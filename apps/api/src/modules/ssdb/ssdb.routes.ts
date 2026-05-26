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

const refreshBodySchema = z.object({
  dcCode: z.string().trim().min(1).max(40),
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
}
