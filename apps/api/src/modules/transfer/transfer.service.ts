/**
 * Restore V2 — kademe 3 (transfer) service (3 kademe modeli).
 *
 * Precondition: restore_jobs.findUnique({ id, status=DONE, avid_asset_id NOT
 * NULL }). Yoksa 409 `restore_not_done`. Backend asset bilgisini restore'dan
 * kopyalayıp transfer_jobs'a yazar.
 *
 * DONE branch worker tarafında `requestSsdbResolverTick(...)` çağırır.
 */

import type { FastifyInstance } from 'fastify';
import { Prisma, type TransferJob, type TransferJobStatus } from '@prisma/client';
import { writeShadowEvent } from '../outbox/outbox.helpers.js';
import type { EnqueueTransferInput } from './transfer.dto.js';

export class RestoreNotDoneError extends Error {
  readonly statusCode = 409;
  readonly code = 'restore_not_done';
  constructor(restoreJobId: number) {
    super(`Restore job ${restoreJobId} is not DONE or asset id missing.`);
    this.name = 'RestoreNotDoneError';
  }
}

export interface EnqueueTransferResult {
  job: TransferJob;
  existing: boolean;
}

/**
 * Idempotent enqueue + restore precondition guard (3 kademe modeli).
 *
 *  1. restore_jobs.findUnique({ id }) — status=DONE + avid_asset_id NOT NULL.
 *     Yoksa 409 RestoreNotDoneError.
 *  2. Aktif (QUEUED/RUNNING) transfer_jobs varsa onun id'sini döner.
 *  3. Yeni QUEUED satır — asset bilgisini restore'dan kopyala (channelSlug,
 *     scheduleDate, dcCode dahil; UI body'sinde göndermez).
 *  4. P2002 race → tekrar SELECT.
 */
export async function enqueueTransferJob(
  app: FastifyInstance,
  input: EnqueueTransferInput,
  requestedBy: string | null,
): Promise<EnqueueTransferResult> {
  const restore = await app.prisma.restoreJob.findUnique({ where: { id: input.restoreJobId } });
  if (!restore || restore.status !== 'DONE' || !restore.avidAssetId) {
    throw new RestoreNotDoneError(input.restoreJobId);
  }

  const existing = await app.prisma.transferJob.findFirst({
    where: {
      dcCode:       restore.dcCode,
      scheduleDate: restore.scheduleDate,
      status:       { in: ['QUEUED', 'RUNNING'] },
      deletedAt:    null,
    },
  });
  if (existing) {
    return { job: existing, existing: true };
  }

  try {
    const job = await app.prisma.transferJob.create({
      data: {
        dcCode:          restore.dcCode,
        channelSlug:     restore.channelSlug,
        scheduleDate:    restore.scheduleDate,
        restoreJobId:    restore.id,
        avidAssetId:     restore.avidAssetId,
        avidAssetName:   restore.avidAssetName,
        avidAssetOnline: restore.avidAssetOnline,
        status:          'QUEUED',
        requestedBy,
      },
    });
    return { job, existing: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const after = await app.prisma.transferJob.findFirst({
        where: {
          dcCode:       restore.dcCode,
          scheduleDate: restore.scheduleDate,
          status:       { in: ['QUEUED', 'RUNNING'] },
          deletedAt:    null,
        },
      });
      if (after) return { job: after, existing: true };
    }
    throw err;
  }
}

/**
 * Restore sekmesi today-future scope (2026-05-28):
 *  - `date` verilirse o günün satırları (legacy).
 *  - `date` null ise scheduleDate >= today (bugün + gelecek).
 */
export async function listTransferJobs(
  app: FastifyInstance,
  date: string | null,
  todayIstanbulDate: string,
): Promise<TransferJob[]> {
  const where = date
    ? { scheduleDate: new Date(`${date}T00:00:00.000Z`), deletedAt: null }
    : { scheduleDate: { gte: new Date(`${todayIstanbulDate}T00:00:00.000Z`) }, deletedAt: null };
  return app.prisma.transferJob.findMany({
    where,
    orderBy: [{ scheduleDate: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function claimQueuedJob(
  app: FastifyInstance,
  job: Pick<TransferJob, 'id' | 'version' | 'attemptCount'>,
): Promise<TransferJob | null> {
  const result = await app.prisma.transferJob.updateMany({
    where: { id: job.id, version: job.version, status: 'QUEUED' },
    data: {
      status:       'RUNNING',
      startedAt:    new Date(),
      attemptCount: job.attemptCount + 1,
      version:      { increment: 1 },
    },
  });
  if (result.count !== 1) return null;
  return app.prisma.transferJob.findUnique({ where: { id: job.id } });
}

export async function transitionToTerminal(
  app: FastifyInstance,
  job: Pick<TransferJob, 'id' | 'version' | 'dcCode' | 'channelSlug' | 'scheduleDate' | 'attemptCount' | 'restoreJobId'>,
  status: 'DONE' | 'FAILED',
  errorMsg: string | null,
): Promise<TransferJob | null> {
  return app.prisma.$transaction(async (tx) => {
    const result = await tx.transferJob.updateMany({
      where: { id: job.id, version: job.version, status: 'RUNNING' },
      data: {
        status,
        finishedAt: new Date(),
        errorMsg,
        version:    { increment: 1 },
      },
    });
    if (result.count !== 1) return null;

    await writeShadowEvent(tx, {
      eventType:     'transfer.job_completed',
      aggregateType: 'TransferJob',
      aggregateId:   String(job.id),
      payload: {
        dcCode:       job.dcCode,
        channelSlug:  job.channelSlug,
        scheduleDate: job.scheduleDate.toISOString().slice(0, 10),
        restoreJobId: job.restoreJobId,
        status,
        attemptCount: job.attemptCount,
        errorMsg,
      },
      idempotencyKey: `transfer.job_completed:TransferJob:${job.id}:${status}`,
    });

    return tx.transferJob.findUnique({ where: { id: job.id } });
  });
}

export async function requeueAfterTransientFailure(
  app: FastifyInstance,
  job: Pick<TransferJob, 'id' | 'version'>,
  backoffMs: number,
  errorMsg: string | null,
): Promise<TransferJob | null> {
  const result = await app.prisma.transferJob.updateMany({
    where: { id: job.id, version: job.version, status: 'RUNNING' },
    data: {
      status:    'QUEUED',
      updatedAt: new Date(Date.now() + backoffMs),
      errorMsg,
      avidJobId: null,
      startedAt: null,
      version:   { increment: 1 },
    },
  });
  if (result.count !== 1) return null;
  return app.prisma.transferJob.findUnique({ where: { id: job.id } });
}

export async function setAvidJobId(
  app: FastifyInstance,
  jobId: number,
  avidJobId: string,
): Promise<TransferJob | null> {
  // Version'dan BAĞIMSIZ yaz: RUNNING + avidJobId boş iken set et.
  // Önceki `where version` koşulu off-by-one'la (worker `claimed.version + 1`
  // gönderiyordu, DB ise `claimed.version`'da) HİÇ eşleşmiyordu → avidJobId
  // asla yazılmıyor → poll başlamıyor → DONE görülmüyordu. Ayrıca yavaş submit
  // sırasında stale-recovery version'ı kaydırsa bile jobId yine kaydedilir.
  // `avidJobId: null` guard'ı çift/eski yazımı önler.
  const result = await app.prisma.transferJob.updateMany({
    where: { id: jobId, status: 'RUNNING', avidJobId: null },
    data: {
      avidJobId,
      version: { increment: 1 },
    },
  });
  if (result.count !== 1) return null;
  return app.prisma.transferJob.findUnique({ where: { id: jobId } });
}

export async function recoverStaleRunning(
  app: FastifyInstance,
  job: Pick<TransferJob, 'id' | 'version'>,
): Promise<TransferJob | null> {
  const result = await app.prisma.transferJob.updateMany({
    where: { id: job.id, version: job.version, status: 'RUNNING' },
    data: {
      status:    'QUEUED',
      avidJobId: null,
      startedAt: null,
      version:   { increment: 1 },
    },
  });
  if (result.count !== 1) return null;
  return app.prisma.transferJob.findUnique({ where: { id: job.id } });
}

export async function fetchPickableJobs(
  app: FastifyInstance,
  maxPerTick: number,
): Promise<TransferJob[]> {
  return app.prisma.transferJob.findMany({
    where: {
      status:    { in: ['QUEUED', 'RUNNING'] as TransferJobStatus[] },
      deletedAt: null,
      updatedAt: { lte: new Date() },
    },
    orderBy: { updatedAt: 'asc' },
    take:    maxPerTick,
  });
}
