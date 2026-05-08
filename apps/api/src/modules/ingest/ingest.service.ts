import type { FastifyInstance } from 'fastify';
import { Prisma, type IngestJob, type IngestStatus } from '@prisma/client';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { writeShadowEvent } from '../outbox/outbox.helpers.js';
import { validateIngestSourcePath } from './ingest.paths.js';

/**
 * Madde 2+7 PR-B3b-2 (audit doc): cross-producer idempotency key.
 *
 * Worker (in-process Node, FFmpeg pipeline) ve callback (POST
 * /webhooks/ingest/callback — Avid capture entegrasyonu için planlanan)
 * aynı domain event'i (ingest.job_completed) farklı yollardan üretebilir.
 * Aynı `jobId` + aynı terminal status için tek outbox satırı garantisi
 * partial unique index üzerinden DB seviyesinde sağlanır.
 *
 * Format: `ingest.job_completed:IngestJob:{jobId}:{terminalStatus}`.
 * Kararı: ops/DECISION-INGEST_COMPLETED-AUTHORITATIVE-PRODUCER.md sub-option B2.
 */
export type IngestTerminalStatus = 'COMPLETED' | 'FAILED';

export function buildIngestCompletedKey(
  jobId: number,
  terminalStatus: IngestTerminalStatus,
): string {
  return `ingest.job_completed:IngestJob:${jobId}:${terminalStatus}`;
}

/**
 * Madde 2+7 PR-B3b-1: manual ingest tetikleme — route handler'dan extract.
 *
 * Domain flow watcher'dan ayrı tutulur (guard #2): her ikisi de aynı outbox
 * helper'ını (writeShadowEvent) kullanır ama kendi $transaction akışını korur.
 * Manual path metadata + ingestPlanItem.updateMany() ek işlemler içerebilir;
 * watcher path saf yeni job creation.
 *
 * Route handler bu fonksiyonu çağırır. Auth (preHandler requireGroup
 * PERMISSIONS.ingest.write) route layer'ında kalır.
 *
 * Direct publish (queue.ingest.new) tx dışında, mevcut davranış korunur.
 */

export interface TriggerManualIngestDto {
  sourcePath: string;
  targetId?:  number;
  metadata?:  Record<string, unknown>;
}

export async function triggerManualIngest(
  app: FastifyInstance,
  dto: TriggerManualIngestDto,
): Promise<IngestJob> {
  const sourcePath = validateIngestSourcePath(dto.sourcePath);

  if (dto.targetId) {
    // SCHED-B5a (Y5-7 — Domain Ownership lock): ingest hedefi canlı yayın
    // plan canonical olarak `live_plan_entries`. Eski `schedules.usage_scope=
    // 'live-plan'` coupling kaldırıldı. Frontend "live-plan'dan ingest
    // tetikleme" akışı follow-up PR'da; geçişte targetId mismatch operasyonel
    // break — guard explicit hata mesajıyla görünür kalsın.
    const entry = await app.prisma.livePlanEntry.findFirst({
      where: { id: dto.targetId, deletedAt: null },
      select: { id: true },
    });
    if (!entry) {
      throw Object.assign(
        new Error('Ingest hedefi canlı yayın planı kaydı olmalıdır (live_plan_entries.id)'),
        { statusCode: 400 },
      );
    }
  }

  const planSourceKey = typeof dto.metadata?.ingestPlanSourceKey === 'string'
    ? dto.metadata.ingestPlanSourceKey
    : null;

  const job = await app.prisma.$transaction(async (tx) => {
    const created = await tx.ingestJob.create({
      data: {
        sourcePath,
        targetId: dto.targetId,
        metadata: dto.metadata as Prisma.InputJsonValue,
      },
    });

    if (planSourceKey) {
      await tx.ingestPlanItem.updateMany({
        where: { sourceKey: planSourceKey },
        data: {
          sourcePath,
          status: 'INGEST_STARTED',
          jobId:  created.id,
        },
      });
    }

    await writeShadowEvent(tx, {
      eventType:     'ingest.job_started',
      aggregateType: 'IngestJob',
      aggregateId:   created.id,
      payload: {
        jobId:      created.id,
        sourcePath: created.sourcePath,
        targetId:   created.targetId,
      },
    });

    return created;
  });

  await app.rabbitmq.publish(QUEUES.INGEST_NEW, {
    jobId:      job.id,
    sourcePath: job.sourcePath,
    targetId:   job.targetId,
  });

  return job;
}

/**
 * Madde 2+7 PR-B3b-2 (worker authoritative path): Node ingest worker'ın
 * COMPLETED/FAILED finalization'ı. Tx içinde ingestJob.update() + outbox shadow
 * (eventType='ingest.job_completed', idempotencyKey set); tx dışında direct
 * publish (queue.ingest.completed) — Phase 2 invariant aynen korunur.
 *
 * Phase 2'de aynı (jobId, terminalStatus) için iki üretici (worker + callback)
 * idempotency key üzerinden tek outbox satırına düşer; direct publish iki defa
 * happen olabilir (mevcut davranış, kabul). Phase 3 cut-over direct publish
 * disable + poller authoritative ile duplicate publish kapanır.
 */
export interface FinalizeIngestJobOptions {
  errorMsg?: string;
}

export async function finalizeIngestJob(
  app: FastifyInstance,
  jobId: number,
  terminalStatus: IngestTerminalStatus,
  opts?: FinalizeIngestJobOptions,
): Promise<void> {
  await app.prisma.$transaction(async (tx) => {
    await tx.ingestJob.update({
      where: { id: jobId },
      data: {
        status:     terminalStatus,
        finishedAt: new Date(),
        ...(opts?.errorMsg !== undefined ? { errorMsg: opts.errorMsg } : {}),
      },
    });
    await writeShadowEvent(tx, {
      eventType:     'ingest.job_completed',
      aggregateType: 'IngestJob',
      aggregateId:   jobId,
      payload: { jobId, status: terminalStatus },
      idempotencyKey: buildIngestCompletedKey(jobId, terminalStatus),
    });
  });

  await app.rabbitmq.publish(QUEUES.INGEST_COMPLETED, {
    jobId,
    status: terminalStatus,
  });
}

/**
 * Madde 2+7 PR-B3b-2 (callback authoritative path): external worker callback
 * (Avid capture entegrasyonu) için handler logic — POST /webhooks/ingest/callback
 * route'undan extract.
 *
 * Tx içinde ingestJob.update() + opsiyonel qcReport.upsert() +
 * ingestPlanItem.updateMany() + (sadece terminal status için) outbox shadow.
 * Intermediate status'lar (PROCESSING/PROXY_GEN/QC) shadow YAZMAZ — guard #1:
 * worker zaten yalnız terminal publish ediyor, parity için intermediate sadece
 * direct publish kalır.
 *
 * Direct publish (queue.ingest.completed) tx dışında ve her status için aktif.
 *
 * Auth (preHandler requireWorkerSecret HMAC) route layer'ında kalır;
 * test bu fonksiyonu doğrudan çağırır (auth scope dışı).
 */
export interface IngestCallbackQcReport {
  codec?:      string;
  resolution?: string;
  duration?:   number;
  frameRate?:  number;
  bitrate?:    number;
  loudness?:   number;
  errors?:     unknown[];
  warnings?:   unknown[];
  passed?:     boolean;
}

export interface IngestCallbackDto {
  jobId:     number;
  status:    IngestStatus;
  proxyPath?: string;
  checksum?:  string;
  errorMsg?:  string;
  qcReport?:  IngestCallbackQcReport;
}

export async function processIngestCallback(
  app: FastifyInstance,
  dto: IngestCallbackDto,
): Promise<IngestJob> {
  const isTerminal = dto.status === 'COMPLETED' || dto.status === 'FAILED';

  const job = await app.prisma.$transaction(async (tx) => {
    const updated = await tx.ingestJob.update({
      where: { id: dto.jobId },
      data: {
        status:     dto.status,
        proxyPath:  dto.proxyPath,
        checksum:   dto.checksum,
        errorMsg:   dto.errorMsg,
        finishedAt: isTerminal ? new Date() : undefined,
      },
    });

    if (dto.qcReport) {
      await tx.qcReport.upsert({
        where:  { jobId: dto.jobId },
        create: {
          jobId: dto.jobId,
          ...dto.qcReport,
          errors:   dto.qcReport.errors   as Prisma.InputJsonValue,
          warnings: dto.qcReport.warnings as Prisma.InputJsonValue,
        },
        update: {
          ...dto.qcReport,
          errors:   dto.qcReport.errors   as Prisma.InputJsonValue,
          warnings: dto.qcReport.warnings as Prisma.InputJsonValue,
        },
      });
    }

    await tx.ingestPlanItem.updateMany({
      where: { jobId: dto.jobId },
      data: {
        status: dto.status === 'FAILED'    ? 'ISSUE'
              : dto.status === 'COMPLETED' ? 'COMPLETED'
              :                              'INGEST_STARTED',
      },
    });

    if (isTerminal) {
      await writeShadowEvent(tx, {
        eventType:     'ingest.job_completed',
        aggregateType: 'IngestJob',
        aggregateId:   dto.jobId,
        payload: { jobId: dto.jobId, status: dto.status },
        idempotencyKey: buildIngestCompletedKey(dto.jobId, dto.status as IngestTerminalStatus),
      });
    }

    return updated;
  });

  await app.rabbitmq.publish(QUEUES.INGEST_COMPLETED, {
    jobId:  dto.jobId,
    status: dto.status,
  });

  return job;
}
