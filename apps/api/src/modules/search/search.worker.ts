/**
 * Restore V2 — kademe 1 (search) worker (tick-based, SSDB pattern clone).
 *
 * Tick davranışı:
 *  1. Pickup: prisma.searchJob.findMany({ status IN (QUEUED, RUNNING),
 *     deletedAt NULL, updatedAt <= now() }) orderBy updatedAt asc take=N.
 *     AWAITING_SELECTION pickup edilmez — operatör girdisi bekleniyor.
 *  2. ConcurrencyLimiter (default 3).
 *  3. Per-job ALS context + try/catch:
 *     - QUEUED → claimQueuedJob (RUNNING + version+1) → adapter.searchByDcCode(dcCode).
 *       - 0 sonuç → markNotFound (terminal).
 *       - 1..N sonuç → markAwaitingSelection (status + avid_assets JSONB).
 *       - exception → backoff/retry/terminal FAILED.
 *     - RUNNING + startedAt > 60s → recoverStaleRunning (claim crash).
 *
 * SELECTED transition route handler içinde sync (worker'da DEĞİL).
 */

import type { FastifyInstance } from 'fastify';
import type { SearchJob } from '@prisma/client';
import { ConcurrencyLimiter } from '../../core/concurrency.js';
import { als } from '../../plugins/audit.js';
import { recordHeartbeat } from '../../lib/service-heartbeat.js';
import { getAvidAdapter, type AvidAdapter } from '../avid/avid.client.js';
import {
  fetchPickableJobs,
  claimQueuedJob,
  markAwaitingSelection,
  markNotFound,
  markFailed,
  recoverStaleRunning,
  requeueAfterTransientFailure,
} from './search.service.js';

export const SEARCH_WORKER_ACTOR = 'system:search-worker';

export interface SearchWorkerConfig {
  intervalMs: number;
  maxPerTick: number;
  concurrency: number;
  maxAttempts: number;
  staleRunningGraceMs: number;
}

export const SEARCH_ABSOLUTE_CONCURRENCY_MAX = 10;

function parsePositiveIntEnv(v: string | undefined, fallback: number): number {
  if (!v || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function parseConcurrencyEnv(v: string | undefined, fallback: number, max: number): number {
  if (!v || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return n > max ? max : n;
}

export function loadSearchWorkerConfig(env: NodeJS.ProcessEnv = process.env): SearchWorkerConfig {
  return {
    intervalMs:          parsePositiveIntEnv(env.SEARCH_WORKER_INTERVAL_MS, 5_000),
    maxPerTick:          parsePositiveIntEnv(env.SEARCH_MAX_PER_TICK, 20),
    concurrency:         parseConcurrencyEnv(env.SEARCH_CONCURRENCY, 3, SEARCH_ABSOLUTE_CONCURRENCY_MAX),
    maxAttempts:         parsePositiveIntEnv(env.SEARCH_MAX_ATTEMPTS, 3),
    staleRunningGraceMs: parsePositiveIntEnv(env.SEARCH_STALE_RUNNING_GRACE_MS, 60_000),
  };
}

function computeBackoffMs(attemptCount: number): number {
  return Math.min(60_000, Math.pow(2, Math.max(0, attemptCount)) * 5_000);
}

export interface SearchWorkerTickResult {
  picked: number;
  claimed: number;
  awaiting: number;
  notFound: number;
  failed: number;
  requeued: number;
  recovered: number;
  errored: number;
  durationMs: number;
}

export interface SearchWorkerTickDeps {
  app: FastifyInstance;
  adapter?: AvidAdapter;
  workerConfig?: SearchWorkerConfig;
}

export async function runSearchWorkerTickOnce(
  deps: SearchWorkerTickDeps,
): Promise<SearchWorkerTickResult> {
  const { app } = deps;
  const cfg = deps.workerConfig ?? loadSearchWorkerConfig();
  const adapter = deps.adapter ?? await getAvidAdapter(app.prisma);
  const startedAt = Date.now();

  const result: SearchWorkerTickResult = {
    picked: 0, claimed: 0, awaiting: 0, notFound: 0, failed: 0,
    requeued: 0, recovered: 0, errored: 0,
    durationMs: 0,
  };

  const jobs = await fetchPickableJobs(app, cfg.maxPerTick);
  result.picked = jobs.length;
  if (jobs.length === 0) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  const limiter = new ConcurrencyLimiter(cfg.concurrency);

  await Promise.all(jobs.map((job) => limiter.run(async () => {
    try {
      await processOneJob(app, adapter, cfg, job, result);
    } catch (err) {
      result.errored += 1;
      app.log.error({ err, jobId: job.id, dcCode: job.dcCode }, 'search worker per-job failure');
    }
  })));

  result.durationMs = Date.now() - startedAt;
  return result;
}

async function processOneJob(
  app: FastifyInstance,
  adapter: AvidAdapter,
  cfg: SearchWorkerConfig,
  job: SearchJob,
  result: SearchWorkerTickResult,
): Promise<void> {
  // RUNNING + startedAt eski → claim crash recovery
  if (job.status === 'RUNNING' && job.startedAt
      && Date.now() - job.startedAt.getTime() > cfg.staleRunningGraceMs) {
    const recovered = await recoverStaleRunning(app, job);
    if (recovered) {
      result.recovered += 1;
      app.log.warn({ jobId: job.id, dcCode: job.dcCode }, 'search worker recovered stale RUNNING');
    }
    return;
  }

  if (job.status === 'QUEUED') {
    const claimed = await claimQueuedJob(app, job);
    if (!claimed) return; // race lost
    result.claimed += 1;

    try {
      const assets = await adapter.searchByDcCode(claimed.dcCode);
      if (assets.length === 0) {
        await markNotFound(app, claimed);
        result.notFound += 1;
        app.log.info({ jobId: claimed.id, dcCode: claimed.dcCode }, 'search worker job NOT_FOUND');
      } else {
        await markAwaitingSelection(app, claimed, assets);
        result.awaiting += 1;
        app.log.info({ jobId: claimed.id, dcCode: claimed.dcCode, count: assets.length }, 'search worker AWAITING_SELECTION');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err, jobId: claimed.id }, 'search worker searchByDcCode failed');
      if (claimed.attemptCount >= cfg.maxAttempts) {
        await markFailed(app, claimed, msg);
        result.failed += 1;
      } else {
        await requeueAfterTransientFailure(app, claimed, computeBackoffMs(claimed.attemptCount), msg);
        result.requeued += 1;
      }
    }
  }
}

function withAls<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    als.run(
      { userId: SEARCH_WORKER_ACTOR, pendingAuditLogs: [] },
      () => { fn().then(resolve, reject); },
    );
  });
}

let intervalTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

export function startSearchWorker(app: FastifyInstance): boolean {
  const cfg = loadSearchWorkerConfig();
  app.log.info(
    { intervalMs: cfg.intervalMs, concurrency: cfg.concurrency, maxAttempts: cfg.maxAttempts },
    'Search worker configured',
  );

  let isRunning = false;

  const tick = async (reason: string = 'periodic'): Promise<void> => {
    recordHeartbeat('search-worker');
    if (isRunning) {
      app.log.debug({ reason }, 'search worker tick skipped (previous tick in progress)');
      return;
    }
    isRunning = true;
    try {
      const r = await withAls(() => runSearchWorkerTickOnce({ app, workerConfig: cfg }));
      if (r.picked > 0) {
        app.log.info({ reason, ...r }, 'search worker tick complete');
      }
    } catch (err) {
      app.log.error({ err, reason }, 'search worker tick failed');
    } finally {
      isRunning = false;
    }
  };

  startupTimer = setTimeout(() => {
    tick('startup').catch((err) => app.log.error({ err }, 'search worker initial tick failed'));
  }, 5_000);
  startupTimer.unref();

  intervalTimer = setInterval(() => {
    tick('periodic').catch((err) => app.log.error({ err }, 'search worker scheduled tick failed'));
  }, cfg.intervalMs);
  intervalTimer.unref();

  app.addHook('onClose', async () => {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  });

  return true;
}
