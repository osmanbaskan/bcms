/**
 * Restore V2 — kademe 1 (search) service.
 *
 * Sorumluluklar:
 *  - `enqueueSearchJob` — idempotent INSERT (aktif job varsa onun id'sini döner).
 *  - `listSearchJobs`   — gün filtreli liste.
 *  - `selectAsset`      — AWAITING_SELECTION → SELECTED transition (whitelist check).
 *  - Worker helper'ları — `claimQueuedJob`, `markAwaitingSelection`,
 *    `markNotFound`, `markFailed`, `recoverStaleRunning`, `fetchPickableJobs`.
 *
 * Tüm yazımlar audit ext üzerinden (Prisma raw SQL write banned). Outbox shadow
 * event'ler terminal/önemli transition'larda yazılır.
 */

import type { FastifyInstance } from 'fastify';
import { Prisma, type SearchJob, type SearchJobStatus } from '@prisma/client';
import type { AvidAsset } from '@bcms/shared';
import { writeShadowEvent } from '../outbox/outbox.helpers.js';
import type { EnqueueSearchInput, SelectAssetInput } from './search.dto.js';

export class SelectNotAwaitingError extends Error {
  readonly statusCode = 409;
  readonly code = 'search_not_awaiting_selection';
  constructor(jobId: number, status: SearchJobStatus) {
    super(`Search job ${jobId} cannot be selected (status=${status}).`);
    this.name = 'SelectNotAwaitingError';
  }
}

export class AssetNotInResultsError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_asset_id';
  constructor(avidAssetId: string) {
    super(`avidAssetId ${avidAssetId} is not in search results.`);
    this.name = 'AssetNotInResultsError';
  }
}

export interface EnqueueSearchResult {
  job: SearchJob;
  existing: boolean;
}

/** Idempotent enqueue — aktif (QUEUED/RUNNING/AWAITING_SELECTION) job varsa onun id'si döner. */
export async function enqueueSearchJob(
  app: FastifyInstance,
  input: EnqueueSearchInput,
  requestedBy: string | null,
): Promise<EnqueueSearchResult> {
  const scheduleDateUtc = new Date(`${input.scheduleDate}T00:00:00.000Z`);

  const existing = await app.prisma.searchJob.findFirst({
    where: {
      dcCode:       input.dcCode,
      scheduleDate: scheduleDateUtc,
      status:       { in: ['QUEUED', 'RUNNING', 'AWAITING_SELECTION'] },
      deletedAt:    null,
    },
  });
  if (existing) return { job: existing, existing: true };

  try {
    const job = await app.prisma.searchJob.create({
      data: {
        dcCode:       input.dcCode,
        channelSlug:  input.channelSlug,
        scheduleDate: scheduleDateUtc,
        status:       'QUEUED',
        requestedBy,
      },
    });
    return { job, existing: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const after = await app.prisma.searchJob.findFirst({
        where: {
          dcCode:       input.dcCode,
          scheduleDate: scheduleDateUtc,
          status:       { in: ['QUEUED', 'RUNNING', 'AWAITING_SELECTION'] },
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
 *  - `date` verilirse o günün satırları (legacy single-date davranışı).
 *  - `date` null ise scheduleDate >= today (bugün + gelecek).
 *
 * Sıralama: scheduleDate asc → createdAt desc (aynı tarihte en yeni job
 * üstte). UI yeni job'a anında reaktif tepki versin diye desc tutuyor.
 */
// Audit #2c (2026-05-30): GET /jobs tarih-filtreli ama satir-cap'i yoktu —
// patolojik buyumeye karsi ust sinir (today-future is hacmini fazlasiyla asar).
const SEARCH_JOBS_MAX = 2000;

export async function listSearchJobs(
  app: FastifyInstance,
  date: string | null,
  todayIstanbulDate: string,
): Promise<SearchJob[]> {
  const where = date
    ? { scheduleDate: new Date(`${date}T00:00:00.000Z`), deletedAt: null }
    : { scheduleDate: { gte: new Date(`${todayIstanbulDate}T00:00:00.000Z`) }, deletedAt: null };
  return app.prisma.searchJob.findMany({
    where,
    orderBy: [{ scheduleDate: 'asc' }, { createdAt: 'desc' }],
    take: SEARCH_JOBS_MAX,
  });
}

/**
 * AWAITING_SELECTION → SELECTED transition.
 *
 *  1. Job AWAITING_SELECTION değilse 409.
 *  2. avidAssetId job.avidAssets içinde değilse 400 (whitelist guard).
 *  3. Whitelist'ten eşleşen asset'in `online` alanı `selected_asset_online`'a kopyalanır.
 *  4. Tx + version filter ile status=SELECTED + selected_asset_id + selected_asset_name
 *     + selected_asset_online + selected_at + selected_by set.
 *  5. Outbox shadow `search.asset_selected`.
 */
export async function selectAsset(
  app: FastifyInstance,
  jobId: number,
  input: SelectAssetInput,
  selectedBy: string | null,
): Promise<SearchJob | null> {
  const job = await app.prisma.searchJob.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (job.status !== 'AWAITING_SELECTION') {
    throw new SelectNotAwaitingError(jobId, job.status);
  }
  const assets = parseAssetsFromJson(job.avidAssets);
  const matched = assets.find((a) => a.id === input.avidAssetId);
  if (!matched) {
    throw new AssetNotInResultsError(input.avidAssetId);
  }

  return app.prisma.$transaction(async (tx) => {
    const result = await tx.searchJob.updateMany({
      where: { id: jobId, version: job.version, status: 'AWAITING_SELECTION' },
      data: {
        status:              'SELECTED',
        selectedAssetId:     input.avidAssetId,
        selectedAssetName:   input.avidAssetName,
        selectedAssetOnline: matched.online,
        selectedAt:          new Date(),
        selectedBy,
        version:             { increment: 1 },
      },
    });
    if (result.count !== 1) return null;

    await writeShadowEvent(tx, {
      eventType:     'search.asset_selected',
      aggregateType: 'SearchJob',
      aggregateId:   String(jobId),
      payload: {
        dcCode:            job.dcCode,
        scheduleDate:      job.scheduleDate.toISOString().slice(0, 10),
        selectedAssetId:   input.avidAssetId,
        selectedAssetName: input.avidAssetName,
        selectedBy,
      },
      idempotencyKey: `search.asset_selected:SearchJob:${jobId}`,
    });

    return tx.searchJob.findUnique({ where: { id: jobId } });
  });
}

function parseAssetsFromJson(value: Prisma.JsonValue | null | undefined): AvidAsset[] {
  if (value == null || !Array.isArray(value)) return [];
  const result: AvidAsset[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== 'string' || typeof obj.name !== 'string' || typeof obj.modifiedAt !== 'string') continue;
    // online: legacy kayıtlarda yok olabilir → false fallback (defansif).
    const online = typeof obj.online === 'boolean' ? obj.online : false;
    const asset: AvidAsset = { id: obj.id, name: obj.name, modifiedAt: obj.modifiedAt, online };
    if (typeof obj.durationFrames === 'number') asset.durationFrames = obj.durationFrames;
    result.push(asset);
  }
  return result;
}

// ============================================================
// Worker helpers
// ============================================================

export async function fetchPickableJobs(
  app: FastifyInstance,
  maxPerTick: number,
): Promise<SearchJob[]> {
  return app.prisma.searchJob.findMany({
    where: {
      status:    { in: ['QUEUED', 'RUNNING'] as SearchJobStatus[] },
      deletedAt: null,
      updatedAt: { lte: new Date() },
    },
    orderBy: { updatedAt: 'asc' },
    take:    maxPerTick,
  });
}

export async function claimQueuedJob(
  app: FastifyInstance,
  job: Pick<SearchJob, 'id' | 'version' | 'attemptCount'>,
): Promise<SearchJob | null> {
  const result = await app.prisma.searchJob.updateMany({
    where: { id: job.id, version: job.version, status: 'QUEUED' },
    data: {
      status:       'RUNNING',
      startedAt:    new Date(),
      attemptCount: job.attemptCount + 1,
      version:      { increment: 1 },
    },
  });
  if (result.count !== 1) return null;
  return app.prisma.searchJob.findUnique({ where: { id: job.id } });
}

/** RUNNING → AWAITING_SELECTION (1+ sonuç) + JSONB persist + outbox shadow. */
export async function markAwaitingSelection(
  app: FastifyInstance,
  job: Pick<SearchJob, 'id' | 'version' | 'dcCode' | 'channelSlug' | 'scheduleDate' | 'attemptCount'>,
  assets: AvidAsset[],
): Promise<SearchJob | null> {
  return app.prisma.$transaction(async (tx) => {
    const result = await tx.searchJob.updateMany({
      where: { id: job.id, version: job.version, status: 'RUNNING' },
      data: {
        status:     'AWAITING_SELECTION',
        avidAssets: assets as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
        version:    { increment: 1 },
      },
    });
    if (result.count !== 1) return null;

    await writeShadowEvent(tx, {
      eventType:     'search.job_completed',
      aggregateType: 'SearchJob',
      aggregateId:   String(job.id),
      payload: {
        dcCode:       job.dcCode,
        channelSlug:  job.channelSlug,
        scheduleDate: job.scheduleDate.toISOString().slice(0, 10),
        status:       'AWAITING_SELECTION',
        resultCount:  assets.length,
        errorMsg:     null,
      },
      idempotencyKey: `search.job_completed:SearchJob:${job.id}:AWAITING_SELECTION`,
    });

    return tx.searchJob.findUnique({ where: { id: job.id } });
  });
}

/** RUNNING → NOT_FOUND (0 sonuç) terminal + outbox shadow. */
export async function markNotFound(
  app: FastifyInstance,
  job: Pick<SearchJob, 'id' | 'version' | 'dcCode' | 'channelSlug' | 'scheduleDate'>,
): Promise<SearchJob | null> {
  return app.prisma.$transaction(async (tx) => {
    const result = await tx.searchJob.updateMany({
      where: { id: job.id, version: job.version, status: 'RUNNING' },
      data: {
        status:     'NOT_FOUND',
        avidAssets: [] as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
        version:    { increment: 1 },
      },
    });
    if (result.count !== 1) return null;

    await writeShadowEvent(tx, {
      eventType:     'search.job_completed',
      aggregateType: 'SearchJob',
      aggregateId:   String(job.id),
      payload: {
        dcCode:       job.dcCode,
        channelSlug:  job.channelSlug,
        scheduleDate: job.scheduleDate.toISOString().slice(0, 10),
        status:       'NOT_FOUND',
        resultCount:  0,
        errorMsg:     null,
      },
      idempotencyKey: `search.job_completed:SearchJob:${job.id}:NOT_FOUND`,
    });

    return tx.searchJob.findUnique({ where: { id: job.id } });
  });
}

/** RUNNING → terminal FAILED + outbox shadow. */
export async function markFailed(
  app: FastifyInstance,
  job: Pick<SearchJob, 'id' | 'version' | 'dcCode' | 'channelSlug' | 'scheduleDate'>,
  errorMsg: string,
): Promise<SearchJob | null> {
  return app.prisma.$transaction(async (tx) => {
    const result = await tx.searchJob.updateMany({
      where: { id: job.id, version: job.version, status: 'RUNNING' },
      data: {
        status:     'FAILED',
        errorMsg,
        finishedAt: new Date(),
        version:    { increment: 1 },
      },
    });
    if (result.count !== 1) return null;

    await writeShadowEvent(tx, {
      eventType:     'search.job_completed',
      aggregateType: 'SearchJob',
      aggregateId:   String(job.id),
      payload: {
        dcCode:       job.dcCode,
        channelSlug:  job.channelSlug,
        scheduleDate: job.scheduleDate.toISOString().slice(0, 10),
        status:       'FAILED',
        resultCount:  null,
        errorMsg,
      },
      idempotencyKey: `search.job_completed:SearchJob:${job.id}:FAILED`,
    });

    return tx.searchJob.findUnique({ where: { id: job.id } });
  });
}

/** RUNNING + startedAt eski (claim crash) → QUEUED re-queue. */
export async function recoverStaleRunning(
  app: FastifyInstance,
  job: Pick<SearchJob, 'id' | 'version'>,
): Promise<SearchJob | null> {
  const result = await app.prisma.searchJob.updateMany({
    where: { id: job.id, version: job.version, status: 'RUNNING' },
    data: {
      status:    'QUEUED',
      startedAt: null,
      version:   { increment: 1 },
    },
  });
  if (result.count !== 1) return null;
  return app.prisma.searchJob.findUnique({ where: { id: job.id } });
}

/** RUNNING → QUEUED re-queue (transient failure, backoff). */
export async function requeueAfterTransientFailure(
  app: FastifyInstance,
  job: Pick<SearchJob, 'id' | 'version'>,
  backoffMs: number,
  errorMsg: string,
): Promise<SearchJob | null> {
  const result = await app.prisma.searchJob.updateMany({
    where: { id: job.id, version: job.version, status: 'RUNNING' },
    data: {
      status:    'QUEUED',
      updatedAt: new Date(Date.now() + backoffMs),
      errorMsg,
      startedAt: null,
      version:   { increment: 1 },
    },
  });
  if (result.count !== 1) return null;
  return app.prisma.searchJob.findUnique({ where: { id: job.id } });
}
