/**
 * Restore V2 — kademe 2 (transfer) worker (tick-based, SSDB pattern clone).
 *
 * Restore worker'a paralel; adapter farklı method çifti kullanır
 * (requestTransfer / pollTransferStatus). Tek farkla:
 *  - DONE branch: `requestSsdbResolverTick('transfer-completed:${dcCode}')`
 *    çağrılır → SSDB cache yenilenir → Provys "Var" görür.
 */

import type { FastifyInstance } from 'fastify';
import type { TransferJob } from '@prisma/client';
import { ConcurrencyLimiter } from '../../core/concurrency.js';
import { als } from '../../plugins/audit.js';
import { recordHeartbeat } from '../../lib/service-heartbeat.js';
import { getAvidAdapter, type AvidAdapter } from '../avid/avid.client.js';
import { requestSsdbResolverTick } from '../ssdb/ssdb-resolver.worker.js';
import {
  fetchPickableJobs,
  claimQueuedJob,
  setAvidJobId,
  transitionToTerminal,
  requeueAfterTransientFailure,
  recoverStaleRunning,
} from './transfer.service.js';

export const TRANSFER_WORKER_ACTOR = 'system:transfer-worker';

export interface TransferWorkerConfig {
  intervalMs: number;
  maxPerTick: number;
  concurrency: number;
  maxAttempts: number;
  staleRunningGraceMs: number;
}

export const TRANSFER_ABSOLUTE_CONCURRENCY_MAX = 10;

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

export function loadTransferWorkerConfig(env: NodeJS.ProcessEnv = process.env): TransferWorkerConfig {
  return {
    intervalMs:          parsePositiveIntEnv(env.TRANSFER_WORKER_INTERVAL_MS, 5_000),
    maxPerTick:          parsePositiveIntEnv(env.TRANSFER_MAX_PER_TICK, 20),
    concurrency:         parseConcurrencyEnv(env.TRANSFER_CONCURRENCY, 3, TRANSFER_ABSOLUTE_CONCURRENCY_MAX),
    maxAttempts:         parsePositiveIntEnv(env.TRANSFER_MAX_ATTEMPTS, 3),
    staleRunningGraceMs: parsePositiveIntEnv(env.TRANSFER_STALE_RUNNING_GRACE_MS, 60_000),
  };
}

function computeBackoffMs(attemptCount: number): number {
  return Math.min(60_000, Math.pow(2, Math.max(0, attemptCount)) * 5_000);
}

export interface TransferWorkerTickResult {
  picked: number;
  claimed: number;
  done: number;
  failed: number;
  requeued: number;
  recovered: number;
  errored: number;
  ssdbTicksTriggered: number;
  durationMs: number;
}

export interface TransferWorkerTickDeps {
  app: FastifyInstance;
  adapter?: AvidAdapter;
  workerConfig?: TransferWorkerConfig;
  /** Test seam — varsayılan: gerçek requestSsdbResolverTick. */
  triggerSsdbTick?: (reason: string) => void;
}

export async function runTransferWorkerTickOnce(
  deps: TransferWorkerTickDeps,
): Promise<TransferWorkerTickResult> {
  const { app } = deps;
  const cfg = deps.workerConfig ?? loadTransferWorkerConfig();
  const adapter = deps.adapter ?? getAvidAdapter();
  const triggerSsdb = deps.triggerSsdbTick ?? requestSsdbResolverTick;
  const startedAt = Date.now();

  const result: TransferWorkerTickResult = {
    picked: 0, claimed: 0, done: 0, failed: 0,
    requeued: 0, recovered: 0, errored: 0, ssdbTicksTriggered: 0,
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
      await processOneJob(app, adapter, cfg, job, result, triggerSsdb);
    } catch (err) {
      result.errored += 1;
      app.log.error({ err, jobId: job.id, dcCode: job.dcCode }, 'transfer worker per-job failure');
    }
  })));

  result.durationMs = Date.now() - startedAt;
  return result;
}

async function processOneJob(
  app: FastifyInstance,
  adapter: AvidAdapter,
  cfg: TransferWorkerConfig,
  job: TransferJob,
  result: TransferWorkerTickResult,
  triggerSsdb: (reason: string) => void,
): Promise<void> {
  if (job.status === 'RUNNING' && !job.avidJobId && job.startedAt
      && Date.now() - job.startedAt.getTime() > cfg.staleRunningGraceMs) {
    const recovered = await recoverStaleRunning(app, job);
    if (recovered) {
      result.recovered += 1;
      app.log.warn({ jobId: job.id, dcCode: job.dcCode }, 'transfer worker recovered stale RUNNING');
    }
    return;
  }

  if (job.status === 'QUEUED') {
    const claimed = await claimQueuedJob(app, job);
    if (!claimed) return;
    result.claimed += 1;

    // assetId defense — REST POST handler restore'dan kopyalamış olmalı.
    if (!claimed.avidAssetId) {
      const msg = 'avidAssetId missing on QUEUED transfer job (UI bug or stale row)';
      await transitionToTerminal(app, claimed, 'FAILED', msg);
      result.failed += 1;
      app.log.error({ jobId: claimed.id, dcCode: claimed.dcCode }, msg);
      return;
    }

    let avidJobId: string;
    try {
      const resp = await adapter.requestTransfer({
        assetId:     claimed.avidAssetId,
        dcCode:      claimed.dcCode,
        channelSlug: claimed.channelSlug,
        // K3 CTMS processName için asset display name (varsa). Yoksa dcCode.
        assetName:   claimed.avidAssetName ?? undefined,
      });
      avidJobId = resp.avidJobId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err, jobId: claimed.id }, 'transfer worker requestTransfer failed');
      if (claimed.attemptCount >= cfg.maxAttempts) {
        await transitionToTerminal(app, claimed, 'FAILED', msg);
        result.failed += 1;
      } else {
        await requeueAfterTransientFailure(app, claimed, computeBackoffMs(claimed.attemptCount), msg);
        result.requeued += 1;
      }
      return;
    }

    await setAvidJobId(app, claimed.id, claimed.version + 1, avidJobId);
    return;
  }

  if (job.status === 'RUNNING' && job.avidJobId) {
    let phaseResult: Awaited<ReturnType<AvidAdapter['pollTransferStatus']>>;
    try {
      phaseResult = await adapter.pollTransferStatus(job.avidJobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err, jobId: job.id }, 'transfer worker pollTransferStatus failed');
      if (job.attemptCount >= cfg.maxAttempts) {
        await transitionToTerminal(app, job, 'FAILED', msg);
        result.failed += 1;
      } else {
        await requeueAfterTransientFailure(app, job, computeBackoffMs(job.attemptCount), msg);
        result.requeued += 1;
      }
      return;
    }

    if (phaseResult.status === 'done') {
      const done = await transitionToTerminal(app, job, 'DONE', null);
      result.done += 1;
      if (done) {
        // SSDB cache yenile — Provys "Var" görür.
        try {
          triggerSsdb(`transfer-completed:${job.dcCode}`);
          result.ssdbTicksTriggered += 1;
        } catch (err) {
          app.log.warn({ err, jobId: job.id, dcCode: job.dcCode }, 'transfer worker SSDB tick trigger failed');
        }
      }
      app.log.info({ jobId: job.id, dcCode: job.dcCode }, 'transfer worker job DONE');
      return;
    }
    if (phaseResult.status === 'failed') {
      const msg = phaseResult.errorMsg ?? 'avid reported failed';
      if (job.attemptCount >= cfg.maxAttempts) {
        await transitionToTerminal(app, job, 'FAILED', msg);
        result.failed += 1;
      } else {
        await requeueAfterTransientFailure(app, job, computeBackoffMs(job.attemptCount), msg);
        result.requeued += 1;
      }
      return;
    }
    return;
  }
}

function withAls<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    als.run(
      { userId: TRANSFER_WORKER_ACTOR, pendingAuditLogs: [] },
      () => { fn().then(resolve, reject); },
    );
  });
}

let intervalTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

export function startTransferWorker(app: FastifyInstance): boolean {
  const cfg = loadTransferWorkerConfig();
  app.log.info(
    { intervalMs: cfg.intervalMs, concurrency: cfg.concurrency, maxAttempts: cfg.maxAttempts },
    'Transfer worker configured',
  );

  let isRunning = false;

  const tick = async (reason: string = 'periodic'): Promise<void> => {
    recordHeartbeat('transfer-worker');
    if (isRunning) {
      app.log.debug({ reason }, 'transfer worker tick skipped (previous tick in progress)');
      return;
    }
    isRunning = true;
    try {
      const r = await withAls(() => runTransferWorkerTickOnce({ app, workerConfig: cfg }));
      if (r.picked > 0) {
        app.log.info({ reason, ...r }, 'transfer worker tick complete');
      }
    } catch (err) {
      app.log.error({ err, reason }, 'transfer worker tick failed');
    } finally {
      isRunning = false;
    }
  };

  startupTimer = setTimeout(() => {
    tick('startup').catch((err) => app.log.error({ err }, 'transfer worker initial tick failed'));
  }, 5_000);
  startupTimer.unref();

  intervalTimer = setInterval(() => {
    tick('periodic').catch((err) => app.log.error({ err }, 'transfer worker scheduled tick failed'));
  }, cfg.intervalMs);
  intervalTimer.unref();

  app.addHook('onClose', async () => {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  });

  return true;
}

export function _resetTransferWorkerStateForTests(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
}
