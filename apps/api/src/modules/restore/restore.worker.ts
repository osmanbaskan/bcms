/**
 * Restore V2 — kademe 1 worker (tick-based, SSDB pattern clone).
 *
 * Tick davranışı:
 *  1. Pickup: prisma.restoreJob.findMany({ status IN (QUEUED, RUNNING),
 *     deletedAt NULL, updatedAt <= now() }) orderBy updatedAt asc take=N.
 *  2. ConcurrencyLimiter (default 3).
 *  3. Per-job ALS context + try/catch:
 *     - QUEUED → claimQueuedJob (RUNNING + version+1) → adapter.requestRestore
 *       → setAvidJobId.
 *     - RUNNING + avidJobId → adapter.pollRestoreStatus:
 *       - done → transitionToTerminal(DONE) + outbox shadow.
 *       - failed + attemptCount<max → requeueAfterTransientFailure + backoff.
 *       - failed + max → transitionToTerminal(FAILED).
 *       - pending/running → no-op.
 *     - RUNNING + avidJobId NULL + startedAt > 60sn → recoverStaleRunning.
 *
 * SSDB tick'i restore DONE'da TETİKLENMEZ — sadece transfer DONE'da
 * (asset henüz production'da yok).
 */

import type { FastifyInstance } from 'fastify';
import type { RestoreJob } from '@prisma/client';
import { ConcurrencyLimiter } from '../../core/concurrency.js';
import { als } from '../../plugins/audit.js';
import { recordHeartbeat } from '../../lib/service-heartbeat.js';
import { getAvidAdapter, type AvidAdapter } from '../avid/avid.client.js';
import {
  fetchPickableJobs,
  claimQueuedJob,
  setAvidJobId,
  transitionToTerminal,
  requeueAfterTransientFailure,
  recoverStaleRunning,
} from './restore.service.js';

export const RESTORE_WORKER_ACTOR = 'system:restore-worker';

export interface RestoreWorkerConfig {
  intervalMs: number;
  maxPerTick: number;
  concurrency: number;
  maxAttempts: number;
  staleRunningGraceMs: number;
}

export const RESTORE_ABSOLUTE_CONCURRENCY_MAX = 10;

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

export function loadRestoreWorkerConfig(env: NodeJS.ProcessEnv = process.env): RestoreWorkerConfig {
  return {
    intervalMs:          parsePositiveIntEnv(env.RESTORE_WORKER_INTERVAL_MS, 5_000),
    maxPerTick:          parsePositiveIntEnv(env.RESTORE_MAX_PER_TICK, 20),
    concurrency:         parseConcurrencyEnv(env.RESTORE_CONCURRENCY, 3, RESTORE_ABSOLUTE_CONCURRENCY_MAX),
    maxAttempts:         parsePositiveIntEnv(env.RESTORE_MAX_ATTEMPTS, 3),
    staleRunningGraceMs: parsePositiveIntEnv(env.RESTORE_STALE_RUNNING_GRACE_MS, 60_000),
  };
}

function computeBackoffMs(attemptCount: number): number {
  // min(60_000, 2^attempt * 5_000)
  return Math.min(60_000, Math.pow(2, Math.max(0, attemptCount)) * 5_000);
}

export interface RestoreWorkerTickResult {
  picked: number;
  claimed: number;
  done: number;
  failed: number;
  requeued: number;
  recovered: number;
  errored: number;
  durationMs: number;
}

export interface RestoreWorkerTickDeps {
  app: FastifyInstance;
  adapter?: AvidAdapter;
  workerConfig?: RestoreWorkerConfig;
}

export async function runRestoreWorkerTickOnce(
  deps: RestoreWorkerTickDeps,
): Promise<RestoreWorkerTickResult> {
  const { app } = deps;
  const cfg = deps.workerConfig ?? loadRestoreWorkerConfig();
  const adapter = deps.adapter ?? await getAvidAdapter(app.prisma);
  const startedAt = Date.now();

  const result: RestoreWorkerTickResult = {
    picked: 0, claimed: 0, done: 0, failed: 0,
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
      app.log.error({ err, jobId: job.id, dcCode: job.dcCode }, 'restore worker per-job failure');
    }
  })));

  result.durationMs = Date.now() - startedAt;
  return result;
}

async function processOneJob(
  app: FastifyInstance,
  adapter: AvidAdapter,
  cfg: RestoreWorkerConfig,
  job: RestoreJob,
  result: RestoreWorkerTickResult,
): Promise<void> {
  // RUNNING + avidJobId NULL + startedAt eski → claim crash recovery.
  if (job.status === 'RUNNING' && !job.avidJobId && job.startedAt
      && Date.now() - job.startedAt.getTime() > cfg.staleRunningGraceMs) {
    const recovered = await recoverStaleRunning(app, job);
    if (recovered) {
      result.recovered += 1;
      app.log.warn({ jobId: job.id, dcCode: job.dcCode }, 'restore worker recovered stale RUNNING');
    }
    return;
  }

  if (job.status === 'QUEUED') {
    const claimed = await claimQueuedJob(app, job);
    if (!claimed) return; // race lost
    result.claimed += 1;

    // assetId defense — REST POST handler bunu doldurmuş olmalı.
    if (!claimed.avidAssetId) {
      const msg = 'avidAssetId missing on QUEUED restore job (UI bug or stale row)';
      await transitionToTerminal(app, claimed, 'FAILED', msg);
      result.failed += 1;
      app.log.error({ jobId: claimed.id, dcCode: claimed.dcCode }, msg);
      return;
    }

    let avidJobId: string;
    try {
      const resp = await adapter.requestRestore({
        assetId:     claimed.avidAssetId,
        // Online flag — true ise adapter Interplay no-op DONE simülasyonu yapar.
        // null/undefined ise normal restore davranışı (offline gibi).
        assetOnline: claimed.avidAssetOnline ?? undefined,
        dcCode:      claimed.dcCode,
        channelSlug: claimed.channelSlug,
      });
      avidJobId = resp.avidJobId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const nextBackoffMs = computeBackoffMs(claimed.attemptCount);
      const willTerminal = claimed.attemptCount >= cfg.maxAttempts;
      app.log.error(
        {
          err, jobId: claimed.id, phase: 'requestRestore',
          attemptCount: claimed.attemptCount, maxAttempts: cfg.maxAttempts,
          nextBackoffMs: willTerminal ? null : nextBackoffMs,
          terminal: willTerminal,
        },
        'restore worker requestRestore failed',
      );
      if (willTerminal) {
        await transitionToTerminal(app, claimed, 'FAILED', msg);
        result.failed += 1;
      } else {
        await requeueAfterTransientFailure(app, claimed, nextBackoffMs, msg);
        result.requeued += 1;
      }
      return;
    }

    await setAvidJobId(app, claimed.id, claimed.version + 1, avidJobId);
    return;
  }

  if (job.status === 'RUNNING' && job.avidJobId) {
    let phaseResult: Awaited<ReturnType<AvidAdapter['pollRestoreStatus']>>;
    try {
      phaseResult = await adapter.pollRestoreStatus(job.avidJobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const nextBackoffMs = computeBackoffMs(job.attemptCount);
      const willTerminal = job.attemptCount >= cfg.maxAttempts;
      app.log.error(
        {
          err, jobId: job.id, phase: 'pollRestoreStatus',
          attemptCount: job.attemptCount, maxAttempts: cfg.maxAttempts,
          nextBackoffMs: willTerminal ? null : nextBackoffMs,
          terminal: willTerminal,
        },
        'restore worker pollRestoreStatus failed',
      );
      // Poll hatası transient; re-queue.
      if (willTerminal) {
        await transitionToTerminal(app, job, 'FAILED', msg);
        result.failed += 1;
      } else {
        await requeueAfterTransientFailure(app, job, nextBackoffMs, msg);
        result.requeued += 1;
      }
      return;
    }

    if (phaseResult.status === 'done') {
      await transitionToTerminal(app, job, 'DONE', null);
      result.done += 1;
      app.log.info({ jobId: job.id, dcCode: job.dcCode }, 'restore worker job DONE');
      return;
    }
    if (phaseResult.status === 'failed') {
      const msg = phaseResult.errorMsg ?? 'avid reported failed';
      const nextBackoffMs = computeBackoffMs(job.attemptCount);
      const willTerminal = job.attemptCount >= cfg.maxAttempts;
      app.log.warn(
        {
          jobId: job.id, phase: 'avidReportedFailed',
          attemptCount: job.attemptCount, maxAttempts: cfg.maxAttempts,
          nextBackoffMs: willTerminal ? null : nextBackoffMs,
          terminal: willTerminal, errorMsg: msg,
        },
        'restore worker avid reported failed',
      );
      if (willTerminal) {
        await transitionToTerminal(app, job, 'FAILED', msg);
        result.failed += 1;
      } else {
        await requeueAfterTransientFailure(app, job, nextBackoffMs, msg);
        result.requeued += 1;
      }
      return;
    }
    // pending / running → no-op (sonraki tick)
    return;
  }
}

/** ALS audit context içinde tick'i çalıştır. */
function withAls<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    als.run(
      { userId: RESTORE_WORKER_ACTOR, pendingAuditLogs: [] },
      () => { fn().then(resolve, reject); },
    );
  });
}

let intervalTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

/**
 * Restore worker start. Worker container'da çalışır; API container'da
 * BCMS_BACKGROUND_SERVICES filtresi nedeniyle bu fonksiyon çağrılmaz.
 *
 * @returns true: timer kuruldu; false: skip (henüz disable koşulu yok).
 */
export function startRestoreWorker(app: FastifyInstance): boolean {
  const cfg = loadRestoreWorkerConfig();
  app.log.info(
    { intervalMs: cfg.intervalMs, concurrency: cfg.concurrency, maxAttempts: cfg.maxAttempts },
    'Restore worker configured',
  );

  let isRunning = false;

  const tick = async (reason: string = 'periodic'): Promise<void> => {
    recordHeartbeat('restore-worker');
    if (isRunning) {
      app.log.debug({ reason }, 'restore worker tick skipped (previous tick in progress)');
      return;
    }
    isRunning = true;
    try {
      const r = await withAls(() => runRestoreWorkerTickOnce({ app, workerConfig: cfg }));
      if (r.picked > 0) {
        app.log.info({ reason, ...r }, 'restore worker tick complete');
      }
    } catch (err) {
      app.log.error({ err, reason }, 'restore worker tick failed');
    } finally {
      isRunning = false;
    }
  };

  startupTimer = setTimeout(() => {
    tick('startup').catch((err) => app.log.error({ err }, 'restore worker initial tick failed'));
  }, 5_000);
  startupTimer.unref();

  intervalTimer = setInterval(() => {
    tick('periodic').catch((err) => app.log.error({ err }, 'restore worker scheduled tick failed'));
  }, cfg.intervalMs);
  intervalTimer.unref();

  app.addHook('onClose', async () => {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  });

  return true;
}

/** Test-only — module timer state reset. */
export function _resetRestoreWorkerStateForTests(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
}
