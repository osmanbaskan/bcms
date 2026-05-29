/**
 * SSDB resolver worker — periodik tick'te:
 *  1. Bugun + gelecek (Europe/Istanbul) pencerede non-CANLI + dcCode dolu
 *     Provys satirlarini Prisma uzerinden distinct dcCode olarak topla.
 *  2. Mevcut `ssdb_material_cache` satirlari uzerinde TTL kontrolu (status-bazli)
 *     - cache yok / dolmus -> aday
 *  3. SSDB_BATCH_SIZE parcalariyla `resolveSsdbMaterialsByDcCodes` (C5) cagir.
 *  4. Outcome -> `ssdb_material_cache` upsert (audit ext ALS context).
 *  5. lookupStatus/media/duration/error degisen DC'ler icin etkilenen
 *     (channelSlug, scheduleDate) ciftlerine `provys_changed` notify.
 *
 * **Kritik:** Worker ASLA gecmis tarihli satirlari taramaz. Cache yapilarinda
 * Provys-bagimli status (found_match, mismatch, live_not_applicable) YAZILMAZ
 * — cache sadece SSDB raw fact tutar; UI material status response-time.
 *
 * Lazy/feature-flag: PROVYS_SSDB_RESOLVER kapali iken timer kurulmaz; eksik
 * SSDB_* env iken kontrollu log + skip (process'i cokertmez).
 *
 * Tick mutex: `isRunning` closure; onceki tick bitmeden yenisi skip edilir.
 */

import type { FastifyInstance } from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { als } from '../../plugins/audit.js';
import { istanbulTodayDate } from '../../core/tz.js';
import { emitNotify } from '../provys/provys.service.js';
import { loadSsdbConfig, type SsdbConfig } from './ssdb.config.js';
import {
  resolveSsdbMaterialsByDcCodes,
  type SsdbMaterialLookupOutcome,
} from './ssdb-material-resolver.js';
import {
  upsertSsdbCacheOutcome,
  findAffectedTodayFuturePairs,
  notifyAffectedPairs,
  isSsdbCacheOutcomeChanged as cacheServiceIsChanged,
  type SsdbCachePrevRow as CacheServiceSsdbCachePrevRow,
} from './ssdb-cache.service.js';
import { ConcurrencyLimiter } from '../../core/concurrency.js';
import { recordHeartbeat } from '../../lib/service-heartbeat.js';

// Backward-compat re-export — mevcut spec/test'ler bu modulden import ediyor.
export type SsdbCachePrevRow = CacheServiceSsdbCachePrevRow;
export const isSsdbCacheOutcomeChanged = cacheServiceIsChanged;

/** Audit ALS actor — sistem-tarafi yazimlar bu user_id ile etiketlenir. */
export const SSDB_RESOLVER_ACTOR = 'system:ssdb-resolver';

/** Worker tuning — env override. `loadSsdbWorkerConfig` ile uretilir. */
export interface SsdbWorkerConfig {
  windowFutureDays: number;
  intervalMs: number;
  maxPerTick: number;
  batchSize: number;
  ttlFoundMin: number;
  ttlDurationUnknownMin: number;
  ttlMissingMin: number;
  ttlErrorMin: number;
  /** Es zamanli SSDB lookup uzeri sinir (default 10, clamp [1,10]). */
  lookupConcurrency: number;
  /** Es zamanli Prisma cache upsert sinir (default 3, clamp [1,10]).
   *  P2024 onlem: 9 background service worker'da paylasilan Prisma pool'u
   *  (default 5) ve audit ext'in her write icin ek query yuku icin guvenli. */
  cacheWriteConcurrency: number;
}

function parsePositiveIntEnv(v: string | undefined, fallback: number): number {
  if (!v || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

/** Concurrency env parse — invalid/empty -> default; max clamp uygulanir. */
function parseConcurrencyEnv(v: string | undefined, fallback: number, max: number): number {
  if (!v || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return n > max ? max : n;
}

/** Worker icindeki tum DB-bound concurrency sinirlarinin mutlak ust limiti. */
export const SSDB_ABSOLUTE_CONCURRENCY_MAX = 10;

export function loadSsdbWorkerConfig(env: NodeJS.ProcessEnv = process.env): SsdbWorkerConfig {
  return {
    windowFutureDays:       parsePositiveIntEnv(env.SSDB_WINDOW_FUTURE_DAYS, 14),
    // 2026-05-27: Default interval 60sn → 1 saat. UI/API canlı SSDB sorgusu
    // YOK; cache okuma + worker periyodik + Provys BXF sync sonrası trigger.
    intervalMs:             parsePositiveIntEnv(env.SSDB_WORKER_INTERVAL_MS, 3_600_000),
    // SSDB yükünü düşük tutmak için tick başına max aday DC sayısı 500 → 100.
    maxPerTick:             parsePositiveIntEnv(env.SSDB_WORKER_MAX_PER_TICK, 100),
    // SSDB IN-batch ve concurrency limitleri 5/5 (yük düşük).
    batchSize:              parsePositiveIntEnv(env.SSDB_BATCH_SIZE, 5),
    // Found TTL 12h → 60dk: "daha önce found olan materyal silinirse en geç
    // 1 saat içinde öğreneceğiz" gerekliliği için.
    ttlFoundMin:            parsePositiveIntEnv(env.SSDB_TTL_FOUND_MIN, 60),
    ttlDurationUnknownMin:  parsePositiveIntEnv(env.SSDB_TTL_DURATION_UNKNOWN_MIN, 120), // 2h
    ttlMissingMin:          parsePositiveIntEnv(env.SSDB_TTL_MISSING_MIN, 30),
    ttlErrorMin:            parsePositiveIntEnv(env.SSDB_TTL_ERROR_MIN, 5),
    lookupConcurrency:      parseConcurrencyEnv(env.SSDB_LOOKUP_CONCURRENCY, 5, SSDB_ABSOLUTE_CONCURRENCY_MAX),
    cacheWriteConcurrency:  parseConcurrencyEnv(env.SSDB_CACHE_WRITE_CONCURRENCY, 5, SSDB_ABSOLUTE_CONCURRENCY_MAX),
  };
}

/**
 * Istanbul YYYY-MM-DD tarihine gun ekler. Naive arithmetic; saat dilimine
 * bagimsiz (sadece gun sayisi degisir).
 */
export function addDaysToIstanbulDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`Invalid Istanbul date: ${date}`);
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Tick raporu — observability. Counters sirasi log/metric tutarliligi icin sabit. */
export interface SsdbWorkerTickResult {
  candidates: number;
  /** Resolver'in dondurdugu outcome sayisi (genelde candidates ile esit). */
  processed: number;
  /** lookup_status='found' (mediaGuid var). */
  found: number;
  /** lookup_status='missing_material'. */
  missing: number;
  /** lookup_status='duration_unknown' (MEDIA var, MEDIA_LINK eksik). */
  durationUnknown: number;
  /** lookup_status='ssdb_error'. */
  error: number;
  /** isSsdbCacheOutcomeChanged true; notify aday. */
  changed: number;
  /** Cache upsert basarili. */
  cacheWriteSucceeded: number;
  /** Cache upsert hatasi (continue; tick olmedi). */
  cacheWriteFailed: number;
  /** emitNotify basarili pair sayisi. */
  notified: number;
  /** Tick toplam suresi (ms). */
  durationMs: number;
}

/** Test/injection icin — tum yan etkiler buradan akar. */
export interface SsdbWorkerTickDeps {
  prisma: PrismaClient;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  defaultFrameRate: number;
  workerConfig?: SsdbWorkerConfig;
  resolver?: typeof resolveSsdbMaterialsByDcCodes;
  emitNotifyFn?: typeof emitNotify;
  now?: () => Date;
  todayIstanbul?: () => string;
}

/**
 * Single tick — saf orchestration. Tum yan etkiler `deps` uzerinden.
 * Hicbir setInterval/setTimeout/als yok; bu fonksiyon test edilebilir.
 */
export async function runSsdbResolverTickOnce(
  deps: SsdbWorkerTickDeps,
): Promise<SsdbWorkerTickResult> {
  const cfg = deps.workerConfig ?? loadSsdbWorkerConfig();
  const resolver = deps.resolver ?? resolveSsdbMaterialsByDcCodes;
  const emit = deps.emitNotifyFn ?? emitNotify;
  const startedAt = Date.now();
  const now = (deps.now ?? (() => new Date()))();
  const today = (deps.todayIstanbul ?? istanbulTodayDate)();
  const futureDate = addDaysToIstanbulDate(today, cfg.windowFutureDays);
  // `@db.Date` UTC midnight kabul edilir; Istanbul gunu T00:00:00Z karsiligi.
  const todayUtc = new Date(`${today}T00:00:00.000Z`);
  const futureUtc = new Date(`${futureDate}T00:00:00.000Z`);

  // Adim 1: candidate discovery — SQL-level TTL filter + ORDER BY ile starvation-free.
  // Eski Prisma findMany + distinct + take + TS-level TTL filter starvation
  // bug'ina yol acti: orderBy YOK + distinct DC count > take → ileri ID'li
  // DC'ler hicbir tick'te pickup edilmiyordu. Read-only raw SQL SELECT —
  // Prisma.sql ile parametre binding; string concat YOK.
  const missingTtlBound  = new Date(now.getTime() - cfg.ttlMissingMin          * 60_000);
  const errorTtlBound    = new Date(now.getTime() - cfg.ttlErrorMin            * 60_000);
  const durationTtlBound = new Date(now.getTime() - cfg.ttlDurationUnknownMin * 60_000);
  const foundTtlBound    = new Date(now.getTime() - cfg.ttlFoundMin            * 60_000);

  const candidateRows = await deps.prisma.$queryRaw<Array<{ dc_code: string }>>(Prisma.sql`
    WITH window_dc AS (
      SELECT DISTINCT pi.dc_code
      FROM provys_items pi
      WHERE pi.dc_code IS NOT NULL
        AND pi.category <> 'CANLI'
        AND pi.schedule_date >= ${todayUtc}::date
        AND pi.schedule_date <= ${futureUtc}::date
    )
    SELECT w.dc_code
    FROM window_dc w
    LEFT JOIN ssdb_material_cache c USING (dc_code)
    WHERE
      c.dc_code IS NULL
      OR (c.lookup_status = 'missing_material' AND c.last_checked_at < ${missingTtlBound})
      OR (c.lookup_status = 'ssdb_error'       AND c.last_checked_at < ${errorTtlBound})
      OR (c.lookup_status = 'duration_unknown' AND c.last_checked_at < ${durationTtlBound})
      OR (c.lookup_status = 'found'            AND c.last_checked_at < ${foundTtlBound})
    ORDER BY
      CASE
        WHEN c.dc_code IS NULL                                     THEN 0
        WHEN c.lookup_status IN ('missing_material','ssdb_error')  THEN 1
        WHEN c.lookup_status = 'duration_unknown'                  THEN 2
        ELSE 3
      END,
      c.last_checked_at ASC NULLS FIRST,
      w.dc_code ASC
    LIMIT ${cfg.maxPerTick}
  `);
  const candidates: string[] = [];
  for (const r of candidateRows) {
    if (r.dc_code) candidates.push(r.dc_code);
  }

  if (candidates.length === 0) {
    return emptyTickResult(startedAt);
  }

  // Adim 2: candidate'lar icin onceki cache satirlarini cek — SsdbCachePrevRow
  // shape KORUNUR; alt akistaki isSsdbCacheOutcomeChanged + upsert + emitNotify
  // bu prev row uzerinden calismaya devam eder (changed/notified regression yok).
  const existingCache = await deps.prisma.ssdbMaterialCache.findMany({
    where: { dcCode: { in: candidates } },
    select: {
      dcCode: true, lookupStatus: true, mediaGuid: true, matchMethod: true,
      tcSom: true, tcEom: true, ssdbDurationFrames: true,
      lastCheckedAt: true, lastError: true,
    },
  });
  const cacheMap = new Map<string, SsdbCachePrevRow>(
    existingCache.map((c) => [c.dcCode, c as SsdbCachePrevRow]),
  );

  // Adim 4: SSDB resolver — lookupConcurrency limit resolver icinde enforced.
  const outcomes = await resolver(candidates, {
    defaultFrameRate: deps.defaultFrameRate,
    batchSize: cfg.batchSize,
    lookupConcurrency: cfg.lookupConcurrency,
  });

  // Outcome breakdown — observability metric'leri icin once say.
  let foundCount = 0;
  let missingCount = 0;
  let durationUnknownCount = 0;
  let errorCount = 0;
  for (const o of outcomes.values()) {
    if (o.lookupStatus === 'found')             foundCount++;
    else if (o.lookupStatus === 'missing_material')  missingCount++;
    else if (o.lookupStatus === 'duration_unknown')  durationUnknownCount++;
    else if (o.lookupStatus === 'ssdb_error')        errorCount++;
  }

  // Adim 5: bounded concurrent cache upsert.
  // P2024 onlem: tek tick'te 100+ DC kodu varsa, Prisma pool (default 5) ve
  // audit ext'in her write icin ek query yuku birlikte tukenebilir. Limiter
  // ile es zamanli upsert sayisi `cacheWriteConcurrency` ile sabit tutulur
  // (default 3). Her item kendi try/catch icinde; tek failure tum tick'i
  // OLDURMEZ — `cacheWriteFailed` sayacina yansir.
  const writeLimiter = new ConcurrencyLimiter(cfg.cacheWriteConcurrency);
  let cacheWriteSucceeded = 0;
  let cacheWriteFailed = 0;
  const changedDcs: string[] = [];

  await Promise.all(candidates.map((dc) => writeLimiter.run(async () => {
    const outcome = outcomes.get(dc);
    if (!outcome) return;
    const prev = cacheMap.get(dc) ?? null;
    try {
      await upsertSsdbCacheOutcome(deps.prisma, outcome, now);
      cacheWriteSucceeded++;
      if (isSsdbCacheOutcomeChanged(prev, outcome)) {
        changedDcs.push(dc);
      }
    } catch (err) {
      cacheWriteFailed++;
      deps.logger.warn({ err, dcCode: dc },
        'SSDB cache upsert failed (per-item, tick continues)');
    }
  })));

  // Adim 6: Notify — sadece bugun+gelecek non-CANLI satirlar icin
  let notified = 0;
  if (changedDcs.length > 0) {
    const pairs = await findAffectedTodayFuturePairs(deps.prisma, changedDcs, todayUtc, futureUtc);
    notified = await notifyAffectedPairs(emit, deps.prisma, deps.logger, pairs);
  }

  return {
    candidates: candidates.length,
    processed: outcomes.size,
    found: foundCount,
    missing: missingCount,
    durationUnknown: durationUnknownCount,
    error: errorCount,
    changed: changedDcs.length,
    cacheWriteSucceeded,
    cacheWriteFailed,
    notified,
    durationMs: Date.now() - startedAt,
  };
}

/** No-op tick (no DCs / TTL doldur). Counters sifir, durationMs gerçek. */
function emptyTickResult(startedAt: number): SsdbWorkerTickResult {
  return {
    candidates: 0, processed: 0,
    found: 0, missing: 0, durationUnknown: 0, error: 0,
    changed: 0, cacheWriteSucceeded: 0, cacheWriteFailed: 0,
    notified: 0,
    durationMs: Date.now() - startedAt,
  };
}

/** Tick wrapper — ALS audit context icinde calistirir. */
function withAls<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    als.run(
      { userId: SSDB_RESOLVER_ACTOR, pendingAuditLogs: [] },
      () => { fn().then(resolve, reject); },
    );
  });
}

/** Worker startup state — test reset icin module-scope. */
let intervalTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

// 2026-05-27: Manuel trigger API state — module-scope singleton.
// Worker boot anında dolu; worker disabled iken null (trigger no-op).
let runManualTick: ((reason: string) => Promise<void>) | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let pendingReason: string | null = null;
let triggerWhileRunning = false;
let manualTickIsRunning = false;

/** Debounce penceresi — kısa sürede çok trigger tek tick'e coalesce. */
export const SSDB_TRIGGER_DEBOUNCE_MS = 5_000;

/**
 * Worker tarafında manuel SSDB resolver tick tetikleyici. UI/API canlı SSDB
 * sorgusu atmaz; cache okuma yapar. Provys BXF sync gibi olaylar bittikten
 * sonra bu API çağrılır.
 *
 * Davranış:
 *  - Worker disabled veya henüz başlatılmadıysa → no-op (API container'da
 *    `requestSsdbResolverTick(...)` çağrılırsa sessiz şekilde döner).
 *  - Debounce: kısa sürede gelen birden çok trigger tek tick'e coalesce edilir
 *    (SSDB_TRIGGER_DEBOUNCE_MS, default 5 sn).
 *  - Tick çalışırken yeni trigger: paralel tick BAŞLATMAZ; bittiğinde pending
 *    bayrağı kontrol edilip yeniden tetiklenir.
 */
export function requestSsdbResolverTick(reason: string): void {
  if (!runManualTick) return;             // worker disabled / not started
  if (manualTickIsRunning) {              // tick zaten çalışıyor
    triggerWhileRunning = true;
    pendingReason = reason;
    return;
  }
  pendingReason = reason;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const r = pendingReason ?? 'manual';
    pendingReason = null;
    void executeManualTick(r);
  }, SSDB_TRIGGER_DEBOUNCE_MS);
  debounceTimer.unref();
}

async function executeManualTick(reason: string): Promise<void> {
  if (!runManualTick) return;
  if (manualTickIsRunning) {
    triggerWhileRunning = true;
    return;
  }
  manualTickIsRunning = true;
  try {
    await runManualTick(reason);
  } finally {
    manualTickIsRunning = false;
    if (triggerWhileRunning) {
      triggerWhileRunning = false;
      // Pending reason (tick sırasında gelen son trigger) korunur; yoksa
      // jenerik 'coalesced-pending-after-run' fallback. Debounce ile zincirle.
      const nextReason = pendingReason ?? 'coalesced-pending-after-run';
      pendingReason = null;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void executeManualTick(nextReason);
      }, SSDB_TRIGGER_DEBOUNCE_MS);
      debounceTimer.unref();
    }
  }
}

/**
 * Start worker — feature flag + env validation, timer setup, ALS-wrapped tick.
 * Disabled / env eksik iken timer KURMAZ.
 *
 * @returns true: worker started (timer scheduled); false: skipped (flag off / env missing)
 */
export function startSsdbResolverWorker(app: FastifyInstance): boolean {
  const config = loadSsdbConfig();
  if (!config.enabled) {
    app.log.info('SSDB resolver worker: PROVYS_SSDB_RESOLVER off; skip');
    return false;
  }
  if (!config.host || config.port == null || !config.database
      || !config.user || !config.password) {
    app.log.warn(
      'SSDB resolver worker: required SSDB_* env missing; worker not started',
    );
    return false;
  }

  const cfg = loadSsdbWorkerConfig();
  app.log.info(
    { intervalMs: cfg.intervalMs, windowFutureDays: cfg.windowFutureDays, batchSize: cfg.batchSize },
    'SSDB resolver worker configured',
  );

  let isRunning = false;

  const tick = async (reason: string = 'periodic'): Promise<void> => {
    recordHeartbeat('ssdb-resolver');
    if (isRunning) {
      app.log.debug({ reason }, 'SSDB resolver tick skipped (previous tick still in progress)');
      return;
    }
    isRunning = true;
    try {
      const result = await withAls(() => runSsdbResolverTickOnce({
        prisma: app.prisma,
        logger: app.log,
        defaultFrameRate: config.defaultFps,
        workerConfig: cfg,
      }));
      app.log.info({ reason, ...result }, 'SSDB resolver tick complete');
    } catch (err) {
      app.log.error({ err, reason }, 'SSDB resolver tick failed');
    } finally {
      isRunning = false;
    }
  };

  // Manuel trigger API hook — module-scope singleton'a worker tick'i bağlar.
  // disable'da null kalır, böylece `requestSsdbResolverTick(...)` no-op olur.
  runManualTick = (reason: string) => tick(reason);

  startupTimer = setTimeout(() => {
    tick('startup').catch((err) => app.log.error({ err }, 'SSDB resolver initial tick failed'));
  }, 5_000);
  startupTimer.unref();

  intervalTimer = setInterval(() => {
    tick('periodic').catch((err) => app.log.error({ err }, 'SSDB resolver scheduled tick failed'));
  }, cfg.intervalMs);
  intervalTimer.unref();

  app.addHook('onClose', async () => {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    runManualTick = null;
    pendingReason = null;
    triggerWhileRunning = false;
    manualTickIsRunning = false;
  });

  return true;
}

/** Test-only — module timer + trigger state reset. */
export function _resetSsdbWorkerStateForTests(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  runManualTick = null;
  pendingReason = null;
  triggerWhileRunning = false;
  manualTickIsRunning = false;
}

/**
 * Test-only — `runManualTick` callback'i doğrudan set et (worker boot
 * etmeden coalescing davranışını izole test etmek için).
 */
export function _setRunManualTickForTests(fn: ((reason: string) => Promise<void>) | null): void {
  runManualTick = fn;
}
