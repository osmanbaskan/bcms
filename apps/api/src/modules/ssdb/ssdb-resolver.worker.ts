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
import { als } from '../../plugins/audit.js';
import { istanbulTodayDate } from '../../core/tz.js';
import { emitNotify } from '../provys/provys.service.js';
import { loadSsdbConfig, type SsdbConfig } from './ssdb.config.js';
import {
  resolveSsdbMaterialsByDcCodes,
  type SsdbMaterialLookupOutcome,
} from './ssdb-material-resolver.js';
import type { SsdbLookupStatus } from './ssdb-status.js';
import {
  upsertSsdbCacheOutcome,
  findAffectedTodayFuturePairs,
  notifyAffectedPairs,
  isSsdbCacheOutcomeChanged as cacheServiceIsChanged,
  type SsdbCachePrevRow as CacheServiceSsdbCachePrevRow,
} from './ssdb-cache.service.js';

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
}

function parsePositiveIntEnv(v: string | undefined, fallback: number): number {
  if (!v || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export function loadSsdbWorkerConfig(env: NodeJS.ProcessEnv = process.env): SsdbWorkerConfig {
  return {
    windowFutureDays:       parsePositiveIntEnv(env.SSDB_WINDOW_FUTURE_DAYS, 14),
    intervalMs:             parsePositiveIntEnv(env.SSDB_WORKER_INTERVAL_MS, 60_000),
    maxPerTick:             parsePositiveIntEnv(env.SSDB_WORKER_MAX_PER_TICK, 500),
    batchSize:              parsePositiveIntEnv(env.SSDB_BATCH_SIZE, 50),
    ttlFoundMin:            parsePositiveIntEnv(env.SSDB_TTL_FOUND_MIN, 720),    // 12h
    ttlDurationUnknownMin:  parsePositiveIntEnv(env.SSDB_TTL_DURATION_UNKNOWN_MIN, 120), // 2h
    ttlMissingMin:          parsePositiveIntEnv(env.SSDB_TTL_MISSING_MIN, 30),
    ttlErrorMin:            parsePositiveIntEnv(env.SSDB_TTL_ERROR_MIN, 5),
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

/** TTL filter — cache satiri "yeniden kontrol edilmeli" mi? */
function isCacheTtlExpired(
  prev: SsdbCachePrevRow,
  now: Date,
  cfg: SsdbWorkerConfig,
): boolean {
  const ageMs = now.getTime() - prev.lastCheckedAt.getTime();
  const minutes = ageMs / 60_000;
  const status = prev.lookupStatus as SsdbLookupStatus;
  if (status === 'found')             return minutes >= cfg.ttlFoundMin;
  if (status === 'duration_unknown')  return minutes >= cfg.ttlDurationUnknownMin;
  if (status === 'missing_material')  return minutes >= cfg.ttlMissingMin;
  if (status === 'ssdb_error')        return minutes >= cfg.ttlErrorMin;
  // Bilinmeyen status -> defensif olarak yeniden kontrol
  return true;
}

/** Tick raporu — observability. */
export interface SsdbWorkerTickResult {
  candidates: number;
  processed: number;
  changed: number;
  notified: number;
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
  const now = (deps.now ?? (() => new Date()))();
  const today = (deps.todayIstanbul ?? istanbulTodayDate)();
  const futureDate = addDaysToIstanbulDate(today, cfg.windowFutureDays);
  // `@db.Date` UTC midnight kabul edilir; Istanbul gunu T00:00:00Z karsiligi.
  const todayUtc = new Date(`${today}T00:00:00.000Z`);
  const futureUtc = new Date(`${futureDate}T00:00:00.000Z`);

  // Adim 1: pencere + non-CANLI + dcCode dolu, distinct
  const provysRows = await deps.prisma.provysItem.findMany({
    where: {
      dcCode: { not: null },
      category: { not: 'CANLI' },
      scheduleDate: { gte: todayUtc, lte: futureUtc },
    },
    select: { dcCode: true },
    distinct: ['dcCode'],
    take: cfg.maxPerTick * 2,
  });
  const dcCodes: string[] = [];
  for (const r of provysRows) {
    if (r.dcCode) dcCodes.push(r.dcCode);
  }

  if (dcCodes.length === 0) {
    return { candidates: 0, processed: 0, changed: 0, notified: 0 };
  }

  // Adim 2: mevcut cache satirlari
  const existingCache = await deps.prisma.ssdbMaterialCache.findMany({
    where: { dcCode: { in: dcCodes } },
    select: {
      dcCode: true, lookupStatus: true, mediaGuid: true, matchMethod: true,
      tcSom: true, tcEom: true, ssdbDurationFrames: true,
      lastCheckedAt: true, lastError: true,
    },
  });
  const cacheMap = new Map<string, SsdbCachePrevRow>(
    existingCache.map((c) => [c.dcCode, c as SsdbCachePrevRow]),
  );

  // Adim 3: TTL filter -> candidate
  const candidates: string[] = [];
  for (const dc of dcCodes) {
    if (candidates.length >= cfg.maxPerTick) break;
    const prev = cacheMap.get(dc);
    if (!prev) { candidates.push(dc); continue; }
    if (isCacheTtlExpired(prev, now, cfg)) candidates.push(dc);
  }

  if (candidates.length === 0) {
    return { candidates: 0, processed: 0, changed: 0, notified: 0 };
  }

  // Adim 4: SSDB resolver
  const outcomes = await resolver(candidates, {
    defaultFrameRate: deps.defaultFrameRate,
    batchSize: cfg.batchSize,
  });

  // Adim 5: Upsert + changed track — cache.service helper'lari uzerinden
  const changedDcs: string[] = [];
  for (const dc of candidates) {
    const outcome = outcomes.get(dc);
    if (!outcome) continue;
    const prev = cacheMap.get(dc) ?? null;
    await upsertSsdbCacheOutcome(deps.prisma, outcome, now);
    if (isSsdbCacheOutcomeChanged(prev, outcome)) {
      changedDcs.push(dc);
    }
  }

  // Adim 6: Notify — sadece bugun+gelecek non-CANLI satirlar icin
  let notified = 0;
  if (changedDcs.length > 0) {
    const pairs = await findAffectedTodayFuturePairs(deps.prisma, changedDcs, todayUtc, futureUtc);
    notified = await notifyAffectedPairs(emit, deps.prisma, deps.logger, pairs);
  }

  return { candidates: candidates.length, processed: outcomes.size, changed: changedDcs.length, notified };
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

  const tick = async (): Promise<void> => {
    if (isRunning) {
      app.log.debug('SSDB resolver tick skipped (previous tick still in progress)');
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
      app.log.info(result, 'SSDB resolver tick complete');
    } catch (err) {
      app.log.error({ err }, 'SSDB resolver tick failed');
    } finally {
      isRunning = false;
    }
  };

  startupTimer = setTimeout(() => {
    tick().catch((err) => app.log.error({ err }, 'SSDB resolver initial tick failed'));
  }, 5_000);
  startupTimer.unref();

  intervalTimer = setInterval(() => {
    tick().catch((err) => app.log.error({ err }, 'SSDB resolver scheduled tick failed'));
  }, cfg.intervalMs);
  intervalTimer.unref();

  app.addHook('onClose', async () => {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  });

  return true;
}

/** Test-only — module timer state reset. */
export function _resetSsdbWorkerStateForTests(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
}
