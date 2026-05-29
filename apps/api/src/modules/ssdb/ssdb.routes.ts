/**
 * SSDB MAM resolver operasyonel kontrol endpointleri.
 *
 *  GET  /api/v1/ssdb/health         — flag/config/cache durumu (SSDB'ye baglanmaz)
 *  POST /api/v1/ssdb/cache/refresh  — tek DC icin manuel cache refresh
 *
 * RBAC: SystemEng allowlist + Admin auto-bypass. /health read, /refresh admin.
 *
 * Guvenlik:
 *  - /health SSDB SQL Server'a baglanmaz; sadece local Postgres cache okur.
 *  - /refresh SSDB read-only SELECT (resolver C5) yapar; INSERT/UPDATE yok.
 *  - Sifre/connection string response/log'a sizdirilmaz (resolver tarafi sanitize).
 *  - Cache write sadece SSDB raw fact; Provys-bagimli status YAZILMAZ.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';
import { loadSsdbConfig } from './ssdb.config.js';
import {
  resolveSsdbMaterialsByDcCodes,
  type SsdbMaterialLookupOutcome,
} from './ssdb-material-resolver.js';
import {
  upsertSsdbCacheOutcome,
  findAffectedTodayFuturePairs,
  notifyAffectedPairs,
  isSsdbCacheOutcomeChanged,
  type SsdbCachePrevRow,
} from './ssdb-cache.service.js';
import { addDaysToIstanbulDate } from './ssdb-resolver.worker.js';
import { istanbulTodayDate } from '../../core/tz.js';
import { emitNotify } from '../provys/provys.service.js';
import { ConcurrencyLimiter } from '../../core/concurrency.js';

const refreshBodySchema = z.object({
  dcCode: z.string().trim().min(1).max(40),
});

/** Bulk cache refresh — UI sayfa acilis otomatik tetigi (Sira 5) + toplu yenile
 *  butonu (Sira 6) icin. Tek DC endpoint'in batch versiyonu; max 100 ile spam
 *  korumasi. Mevcut tek-DC endpoint korunur. */
const BULK_REFRESH_MAX = 100;
const bulkRefreshBodySchema = z.object({
  dcCodes: z.array(z.string().trim().min(1).max(40)).min(1).max(BULK_REFRESH_MAX),
});

/** Route registration ile test injection birlestiren opts. */
export interface SsdbRoutesOptions {
  resolver?: typeof resolveSsdbMaterialsByDcCodes;
  emitNotifyFn?: typeof emitNotify;
  now?: () => Date;
  todayIstanbul?: () => string;
  /** Default window — worker ile ayni 14 gun; env override degil (V1). */
  windowFutureDays?: number;
}

export async function ssdbRoutes(
  app: FastifyInstance,
  opts: SsdbRoutesOptions = {},
): Promise<void> {
  const resolverFn   = opts.resolver      ?? resolveSsdbMaterialsByDcCodes;
  const emitFn       = opts.emitNotifyFn  ?? emitNotify;
  const nowFn        = opts.now           ?? (() => new Date());
  const todayFn      = opts.todayIstanbul ?? istanbulTodayDate;
  const windowDays   = opts.windowFutureDays ?? 14;

  // ───────────────────────────────────────── GET /ssdb/health
  app.get('/health', {
    preHandler: app.requireGroup(...PERMISSIONS.ssdb.read),
    schema: { tags: ['SSDB'], summary: 'SSDB resolver health + cache durumu' },
  }, async (_request, reply) => {
    const config = loadSsdbConfig();
    const configured = !!(
      config.host && config.port != null && config.database
      && config.user && config.password
    );

    let cacheTableReachable = true;
    let total = 0;
    const stats = { found: 0, missingMaterial: 0, durationUnknown: 0, ssdbError: 0 };
    let latestCheckedAt: string | null = null;

    try {
      const groups = await app.prisma.ssdbMaterialCache.groupBy({
        by: ['lookupStatus'],
        _count: { _all: true },
      });
      for (const g of groups) {
        const n = g._count._all;
        total += n;
        if (g.lookupStatus === 'found')             stats.found = n;
        else if (g.lookupStatus === 'missing_material')  stats.missingMaterial = n;
        else if (g.lookupStatus === 'duration_unknown')  stats.durationUnknown = n;
        else if (g.lookupStatus === 'ssdb_error')        stats.ssdbError = n;
      }
      const latest = await app.prisma.ssdbMaterialCache.findFirst({
        orderBy: { lastCheckedAt: 'desc' },
        select: { lastCheckedAt: true },
      });
      if (latest?.lastCheckedAt) {
        latestCheckedAt = latest.lastCheckedAt.toISOString();
      }
    } catch (err) {
      // Migration apply edilmemis ortam veya tablo erisim hatasi -> API kirilmaz
      cacheTableReachable = false;
      app.log.warn({ err }, 'SSDB health: cache table unreachable');
    }

    return reply.send({
      enabled: config.enabled,
      configured,
      cacheTableReachable,
      cacheStats: { total, ...stats },
      latestCheckedAt,
    });
  });

  // ───────────────────────────────────────── POST /ssdb/cache/refresh
  app.post('/cache/refresh', {
    preHandler: app.requireGroup(...PERMISSIONS.ssdb.admin),
    schema: { tags: ['SSDB'], summary: 'SSDB cache manual refresh (single DC)' },
  }, async (request, reply) => {
    const body = refreshBodySchema.parse(request.body);
    const dcCode = body.dcCode.trim();

    const config = loadSsdbConfig();
    if (!config.enabled) {
      return reply.code(503).send({
        statusCode: 503, error: 'Service Unavailable',
        message: 'SSDB resolver disabled (PROVYS_SSDB_RESOLVER != on)',
      });
    }
    if (!config.host || config.port == null || !config.database
        || !config.user || !config.password) {
      return reply.code(503).send({
        statusCode: 503, error: 'Service Unavailable',
        message: 'SSDB config incomplete (SSDB_* env eksik)',
      });
    }

    // Onceki cache snapshot (changed detection icin)
    const prev = await app.prisma.ssdbMaterialCache.findUnique({
      where: { dcCode },
      select: {
        dcCode: true, lookupStatus: true, mediaGuid: true, matchMethod: true,
        tcSom: true, tcEom: true, ssdbDurationFrames: true,
        lastCheckedAt: true, lastError: true,
      },
    });

    // Resolver — tek DC, batch=1
    const outcomes = await resolverFn([dcCode], {
      defaultFrameRate: config.defaultFps,
      batchSize: 50,
    });
    const outcome: SsdbMaterialLookupOutcome | undefined = outcomes.get(dcCode);
    if (!outcome) {
      return reply.code(500).send({
        statusCode: 500, error: 'Internal Server Error',
        message: 'resolver returned no outcome for given dcCode',
      });
    }

    const now = nowFn();
    await upsertSsdbCacheOutcome(app.prisma, outcome, now);
    const changed = isSsdbCacheOutcomeChanged(prev as SsdbCachePrevRow | null, outcome);

    // Notify — sadece today+future + non-CANLI affected pair'lar
    if (changed) {
      const today = todayFn();
      const future = addDaysToIstanbulDate(today, windowDays);
      const todayUtc = new Date(`${today}T00:00:00.000Z`);
      const futureUtc = new Date(`${future}T00:00:00.000Z`);
      const pairs = await findAffectedTodayFuturePairs(app.prisma, [dcCode], todayUtc, futureUtc);
      await notifyAffectedPairs(emitFn, app.prisma, app.log, pairs);
    }

    return reply.send({
      dcCode: outcome.dcCode,
      lookupStatus: outcome.lookupStatus,
      mediaGuid: outcome.mediaGuid,
      matchMethod: outcome.matchMethod,
      ssdbDurationFrames: outcome.ssdbDurationFrames,
      ssdbDurationTimecode: outcome.ssdbDurationTimecode,
      changed,
    });
  });

  // ───────────────────────────────────────── POST /ssdb/cache/refresh/bulk
  //
  // Tek-DC endpoint'in batch versiyonu. Sistem yormama icin:
  //  - Body max 100 DC (Zod reddeder, validation 400).
  //  - Duplicate dcCode'lar Set ile elenir → tek SSDB sorgusu.
  //  - Prev cache TEK round-trip (`findMany IN [...]`).
  //  - Resolver array-aware + lookupConcurrency 5 (A2 grup ConcurrencyLimiter).
  //  - Upsert bounded paralel (cacheWriteConcurrency 5; Prisma pool koruma).
  //  - Per-item try/catch → tek failure tum batch'i OLDURMEZ; warn loglanir.
  //  - Notify: yalniz changed DC'ler icin TEK `findAffectedTodayFuturePairs`.
  //  - Response sirasi input dcCodes ile birebir (deterministik).
  app.post('/cache/refresh/bulk', {
    preHandler: app.requireGroup(...PERMISSIONS.ssdb.admin),
    schema: { tags: ['SSDB'], summary: 'SSDB cache manual refresh (multi-DC, max 100)' },
  }, async (request, reply) => {
    const body = bulkRefreshBodySchema.parse(request.body);

    // Trim + dedup (input sirasini koru).
    const seen = new Set<string>();
    const dcCodes: string[] = [];
    for (const raw of body.dcCodes) {
      const dc = raw.trim();
      if (dc.length === 0) continue;
      if (seen.has(dc)) continue;
      seen.add(dc);
      dcCodes.push(dc);
    }
    if (dcCodes.length === 0) {
      return reply.code(400).send({
        statusCode: 400, error: 'Bad Request',
        message: 'dcCodes empty after trim/dedup',
      });
    }

    const config = loadSsdbConfig();
    if (!config.enabled) {
      return reply.code(503).send({
        statusCode: 503, error: 'Service Unavailable',
        message: 'SSDB resolver disabled (PROVYS_SSDB_RESOLVER != on)',
      });
    }
    if (!config.host || config.port == null || !config.database
        || !config.user || !config.password) {
      return reply.code(503).send({
        statusCode: 503, error: 'Service Unavailable',
        message: 'SSDB config incomplete (SSDB_* env eksik)',
      });
    }

    // Prev cache TEK findMany (changed detection icin).
    const prevs = await app.prisma.ssdbMaterialCache.findMany({
      where: { dcCode: { in: dcCodes } },
      select: {
        dcCode: true, lookupStatus: true, mediaGuid: true, matchMethod: true,
        tcSom: true, tcEom: true, ssdbDurationFrames: true,
        lastCheckedAt: true, lastError: true,
      },
    });
    const prevMap = new Map<string, SsdbCachePrevRow>(
      prevs.map((p) => [p.dcCode, p as SsdbCachePrevRow]),
    );

    // Resolver — array-aware + lookupConcurrency 5 (A2 grup).
    const outcomes = await resolverFn(dcCodes, {
      defaultFrameRate: config.defaultFps,
      batchSize: 50,
      lookupConcurrency: 5,
    });

    const now = nowFn();
    const writeLimiter = new ConcurrencyLimiter(5);
    type BulkItem = {
      dcCode: string;
      lookupStatus: string;
      mediaGuid: string | null;
      matchMethod: string | null;
      ssdbDurationFrames: number | null;
      ssdbDurationTimecode: string | null;
      changed: boolean;
    };
    // Pre-allocate — input sirasi korumasi icin.
    const results: Array<BulkItem | null> = new Array(dcCodes.length).fill(null);
    const changedDcs: string[] = [];

    await Promise.all(dcCodes.map((dc, idx) => writeLimiter.run(async () => {
      const outcome: SsdbMaterialLookupOutcome | undefined = outcomes.get(dc);
      if (!outcome) {
        // resolver outcome dondurmedi — slot null kalir; final filter eler.
        return;
      }
      let wasChanged = false;
      try {
        await upsertSsdbCacheOutcome(app.prisma, outcome, now);
        wasChanged = isSsdbCacheOutcomeChanged(prevMap.get(dc) ?? null, outcome);
        if (wasChanged) changedDcs.push(dc);
      } catch (err) {
        app.log.warn({ err, dcCode: dc }, 'bulk refresh: per-item upsert failed');
        // upsert basarisiz → changed=false; outcome'u yine de raporla.
      }
      results[idx] = {
        dcCode: outcome.dcCode,
        lookupStatus: outcome.lookupStatus,
        mediaGuid: outcome.mediaGuid,
        matchMethod: outcome.matchMethod,
        ssdbDurationFrames: outcome.ssdbDurationFrames,
        ssdbDurationTimecode: outcome.ssdbDurationTimecode,
        changed: wasChanged,
      };
    })));

    // Notify — yalniz changed DC'ler icin TEK round-trip.
    let notified = 0;
    if (changedDcs.length > 0) {
      const today = todayFn();
      const future = addDaysToIstanbulDate(today, windowDays);
      const todayUtc = new Date(`${today}T00:00:00.000Z`);
      const futureUtc = new Date(`${future}T00:00:00.000Z`);
      const pairs = await findAffectedTodayFuturePairs(app.prisma, changedDcs, todayUtc, futureUtc);
      notified = await notifyAffectedPairs(emitFn, app.prisma, app.log, pairs);
    }

    const finalResults: BulkItem[] = [];
    for (const r of results) if (r) finalResults.push(r);
    return reply.send({ results: finalResults, notified });
  });
}
