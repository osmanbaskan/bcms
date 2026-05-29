/**
 * Restore V2 — kademe 2 (restore) service (3 kademe modeli).
 *
 * Sorumluluklar:
 *  - `enqueueRestoreJob` — searchJobId precondition + idempotent INSERT;
 *    asset bilgisini search'ten kopyalar.
 *  - `listRestoreJobs`   — gün filtreli liste.
 *  - `claimQueuedJob`    — optimistic claim helper (QUEUED → RUNNING).
 *  - `transitionToTerminal` — DONE/FAILED + outbox shadow + audit ext.
 *  - `requeueAfterTransientFailure` — transient hata sonrası backoff.
 *
 * Tüm yazımlar audit ext üzerinden (Prisma raw SQL write banned).
 */

import type { FastifyInstance } from 'fastify';
import { Prisma, type RestoreJob, type RestoreJobStatus } from '@prisma/client';
import { writeShadowEvent } from '../outbox/outbox.helpers.js';
import type { EnqueueRestoreInput } from './restore.dto.js';

export class SearchNotSelectedError extends Error {
  readonly statusCode = 409;
  readonly code = 'search_not_selected';
  constructor(searchJobId: number) {
    super(`Search job ${searchJobId} is not SELECTED (asset onayı yok).`);
    this.name = 'SearchNotSelectedError';
  }
}

export interface EnqueueRestoreResult {
  job: RestoreJob;
  existing: boolean;
}

/**
 * Idempotent enqueue + searchJobId precondition (3 kademe modeli).
 *
 *  1. search_jobs.findUnique({ id }) — yoksa 404 benzeri SearchNotSelectedError.
 *  2. status=SELECTED + selected_asset_id NOT NULL kontrolü; yoksa 409.
 *  3. Aktif restore_jobs varsa onun id'si döner (idempotent).
 *  4. Yeni QUEUED satır — asset bilgisini search'ten kopyala (channelSlug,
 *     scheduleDate, dcCode dahil; UI body'sinde göndermez).
 *  5. P2002 race → tekrar SELECT.
 */
export async function enqueueRestoreJob(
  app: FastifyInstance,
  input: EnqueueRestoreInput,
  requestedBy: string | null,
): Promise<EnqueueRestoreResult> {
  const search = await app.prisma.searchJob.findUnique({ where: { id: input.searchJobId } });
  if (!search || search.status !== 'SELECTED' || !search.selectedAssetId) {
    throw new SearchNotSelectedError(input.searchJobId);
  }

  const existing = await app.prisma.restoreJob.findFirst({
    where: {
      dcCode:       search.dcCode,
      scheduleDate: search.scheduleDate,
      status:       { in: ['QUEUED', 'RUNNING'] },
      deletedAt:    null,
    },
  });
  if (existing) {
    return { job: existing, existing: true };
  }

  try {
    const job = await app.prisma.restoreJob.create({
      data: {
        dcCode:          search.dcCode,
        channelSlug:     search.channelSlug,
        scheduleDate:    search.scheduleDate,
        searchJobId:     search.id,
        avidAssetId:     search.selectedAssetId,
        avidAssetName:   search.selectedAssetName,
        avidAssetOnline: search.selectedAssetOnline,
        status:          'QUEUED',
        requestedBy,
      },
    });
    return { job, existing: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const after = await app.prisma.restoreJob.findFirst({
        where: {
          dcCode:       search.dcCode,
          scheduleDate: search.scheduleDate,
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
export async function listRestoreJobs(
  app: FastifyInstance,
  date: string | null,
  todayIstanbulDate: string,
): Promise<RestoreJob[]> {
  const where = date
    ? { scheduleDate: new Date(`${date}T00:00:00.000Z`), deletedAt: null }
    : { scheduleDate: { gte: new Date(`${todayIstanbulDate}T00:00:00.000Z`) }, deletedAt: null };
  return app.prisma.restoreJob.findMany({
    where,
    orderBy: [{ scheduleDate: 'asc' }, { createdAt: 'desc' }],
  });
}

/**
 * Optimistic claim QUEUED → RUNNING.
 * `updateMany` + version filter; result.count !== 1 ise race kaybetti (no-op).
 */
export async function claimQueuedJob(
  app: FastifyInstance,
  job: Pick<RestoreJob, 'id' | 'version' | 'attemptCount'>,
): Promise<RestoreJob | null> {
  const result = await app.prisma.restoreJob.updateMany({
    where: { id: job.id, version: job.version, status: 'QUEUED' },
    data: {
      status:       'RUNNING',
      startedAt:    new Date(),
      attemptCount: job.attemptCount + 1,
      version:      { increment: 1 },
    },
  });
  if (result.count !== 1) return null;
  return app.prisma.restoreJob.findUnique({ where: { id: job.id } });
}

/** RUNNING → terminal status (DONE / FAILED) + outbox shadow event. */
export async function transitionToTerminal(
  app: FastifyInstance,
  job: Pick<RestoreJob, 'id' | 'version' | 'dcCode' | 'channelSlug' | 'scheduleDate' | 'attemptCount'>,
  status: 'DONE' | 'FAILED',
  errorMsg: string | null,
): Promise<RestoreJob | null> {
  return app.prisma.$transaction(async (tx) => {
    const result = await tx.restoreJob.updateMany({
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
      eventType:     'restore.job_completed',
      aggregateType: 'RestoreJob',
      aggregateId:   String(job.id),
      payload: {
        dcCode:       job.dcCode,
        channelSlug:  job.channelSlug,
        scheduleDate: job.scheduleDate.toISOString().slice(0, 10),
        status,
        attemptCount: job.attemptCount,
        errorMsg,
      },
      idempotencyKey: `restore.job_completed:RestoreJob:${job.id}:${status}`,
    });

    return tx.restoreJob.findUnique({ where: { id: job.id } });
  });
}

/** RUNNING → QUEUED re-queue (transient failure, retry'a uygun). */
export async function requeueAfterTransientFailure(
  app: FastifyInstance,
  job: Pick<RestoreJob, 'id' | 'version'>,
  backoffMs: number,
  errorMsg: string | null,
): Promise<RestoreJob | null> {
  const result = await app.prisma.restoreJob.updateMany({
    where: { id: job.id, version: job.version, status: 'RUNNING' },
    data: {
      status:     'QUEUED',
      // updatedAt future timestamp ile pickup gecikmesi sağlar (worker
      // findMany orderBy updatedAt asc; backoff sırasında tick'lerde
      // sırada en sona düşer).
      updatedAt:  new Date(Date.now() + backoffMs),
      errorMsg,
      avidJobId:  null,
      startedAt:  null,
      version:    { increment: 1 },
    },
  });
  if (result.count !== 1) return null;
  return app.prisma.restoreJob.findUnique({ where: { id: job.id } });
}

/** Avid job kimliği set (RUNNING + null avidJobId iken). */
export async function setAvidJobId(
  app: FastifyInstance,
  jobId: number,
  version: number,
  avidJobId: string,
): Promise<RestoreJob | null> {
  const result = await app.prisma.restoreJob.updateMany({
    where: { id: jobId, version, status: 'RUNNING' },
    data: {
      avidJobId,
      version: { increment: 1 },
    },
  });
  if (result.count !== 1) return null;
  return app.prisma.restoreJob.findUnique({ where: { id: jobId } });
}

/** RUNNING + avidJobId NULL + startedAt eski → re-queue (claim crash recovery). */
export async function recoverStaleRunning(
  app: FastifyInstance,
  job: Pick<RestoreJob, 'id' | 'version'>,
): Promise<RestoreJob | null> {
  const result = await app.prisma.restoreJob.updateMany({
    where: { id: job.id, version: job.version, status: 'RUNNING' },
    data: {
      status:    'QUEUED',
      avidJobId: null,
      startedAt: null,
      version:   { increment: 1 },
    },
  });
  if (result.count !== 1) return null;
  return app.prisma.restoreJob.findUnique({ where: { id: job.id } });
}

/** Worker tarafında pickup edilebilen jobları getir. */
export async function fetchPickableJobs(
  app: FastifyInstance,
  maxPerTick: number,
): Promise<RestoreJob[]> {
  return app.prisma.restoreJob.findMany({
    where: {
      status:    { in: ['QUEUED', 'RUNNING'] as RestoreJobStatus[] },
      deletedAt: null,
      // updatedAt backoff future timestamp pickup'tan korur.
      updatedAt: { lte: new Date() },
    },
    orderBy: { updatedAt: 'asc' },
    take:    maxPerTick,
  });
}
