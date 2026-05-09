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
export const INGEST_TERMINAL_STATUSES = ['COMPLETED', 'FAILED'] as const;
export type IngestTerminalStatus = (typeof INGEST_TERMINAL_STATUSES)[number];

export function isTerminalIngestStatus(status: IngestStatus): status is IngestTerminalStatus {
  return (INGEST_TERMINAL_STATUSES as readonly string[]).includes(status);
}

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
  /** Phase A2 PR-2a (DECISION-BACKEND-CANONICAL-DATA-MODEL-V1 §4.A2, 2026-05-09):
   *  structured FK; transient `metadata.ingestPlanSourceKey` yerine canonical
   *  kaynak. Öncelik kuralı: `planItemId` verilirse kullanılır + metadata key
   *  sessizce yok sayılır. Yalnız metadata key verilirse deprecated fallback
   *  yolu (sourceKey → plan item lookup) çalışır; A4 sonrası kalkar. */
  planItemId?: number;
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

  // Phase A2 PR-2a: planItemId resolution.
  // 1) dto.planItemId verildiyse: var olduğunu doğrula → 400 erken-validasyon.
  // 2) Aksi halde dto.metadata.ingestPlanSourceKey string ise: deprecated
  //    fallback olarak plan item sourceKey lookup. Bulunamazsa yumuşak davranış
  //    korunur (job create edilir, planItemId NULL kalır — A2 backward compat).
  // 3) İkisi birlikte gelirse planItemId kazanır; metadata sessizce yok sayılır.
  let resolvedPlanItemId: number | null = null;

  if (dto.planItemId !== undefined) {
    const planItem = await app.prisma.ingestPlanItem.findUnique({
      where: { id: dto.planItemId },
      select: { id: true },
    });
    if (!planItem) {
      throw Object.assign(
        new Error('Ingest plan item bulunamadı'),
        { statusCode: 400 },
      );
    }
    resolvedPlanItemId = planItem.id;
  } else if (typeof dto.metadata?.ingestPlanSourceKey === 'string') {
    const planItem = await app.prisma.ingestPlanItem.findUnique({
      where: { sourceKey: dto.metadata.ingestPlanSourceKey },
      select: { id: true },
    });
    resolvedPlanItemId = planItem?.id ?? null;
  }

  const job = await app.prisma.$transaction(async (tx) => {
    const created = await tx.ingestJob.create({
      data: {
        sourcePath,
        targetId:   dto.targetId,
        planItemId: resolvedPlanItemId,
        metadata:   dto.metadata as Prisma.InputJsonValue,
      },
    });

    if (resolvedPlanItemId !== null) {
      // Phase A2 PR-2a: id-based update (deterministic; tek satır kesin).
      // Race senaryosunda P2025 fırlarsa $transaction rollback eder; mevcut
      // route global error handler 404'a düşer. Erken-validasyon dış tx zaten
      // var olduğunu kontrol etti; race penceresi pratikte dar.
      await tx.ingestPlanItem.update({
        where: { id: resolvedPlanItemId },
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
  // Phase A3 (DECISION-BACKEND-CANONICAL-DATA-MODEL-V1 §4.A3, 2026-05-09):
  // Terminal status race koruması — `updateMany` + status filter + version
  // increment. İlk terminal write kazanır; race kaybeden çağrı:
  //   - DB update yapmaz (count=0)
  //   - outbox yazmaz
  //   - direct publish yapmaz
  // Bu bilinçli davranış değişikliği (eski Phase 2 invariant'ı race kaybında
  // direct publish'i hâlâ tetiklerdi; A3'te skip).
  // Worker authoritative path: job yoksa açık hata (sessiz yutma yok).
  const applied = await app.prisma.$transaction(async (tx) => {
    const result = await tx.ingestJob.updateMany({
      where: {
        id:     jobId,
        status: { notIn: [...INGEST_TERMINAL_STATUSES] },
      },
      data: {
        status:     terminalStatus,
        finishedAt: new Date(),
        version:    { increment: 1 },
        ...(opts?.errorMsg !== undefined ? { errorMsg: opts.errorMsg } : {}),
      },
    });

    if (result.count === 1) {
      await writeShadowEvent(tx, {
        eventType:     'ingest.job_completed',
        aggregateType: 'IngestJob',
        aggregateId:   jobId,
        payload:       { jobId, status: terminalStatus },
        idempotencyKey: buildIngestCompletedKey(jobId, terminalStatus),
      });
      return true;
    }

    // count === 0 → ya job yok ya da zaten terminal. Worker path: job
    // gerçekten yoksa açık hata; varsa terminal kabul (race kaybı, sessiz).
    const existing = await tx.ingestJob.findUnique({
      where:  { id: jobId },
      select: { id: true },
    });
    if (!existing) {
      throw Object.assign(
        new Error(`Ingest job not found (id=${jobId})`),
        { statusCode: 404 },
      );
    }
    return false;
  });

  if (applied) {
    await app.rabbitmq.publish(QUEUES.INGEST_COMPLETED, {
      jobId,
      status: terminalStatus,
    });
  }
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
  const isTerminal = isTerminalIngestStatus(dto.status);

  // Phase A3 (DECISION-BACKEND-CANONICAL-DATA-MODEL-V1 §4.A3, 2026-05-09):
  // Terminal callback için race korumalı `updateMany` + status filter +
  // version increment. İlk terminal write kazanır; race kaybeden callback:
  //   - DB update yapmaz (status zaten terminal)
  //   - qcReport upsert yapmaz
  //   - planItem status update yapmaz
  //   - outbox yazmaz
  //   - direct publish yapmaz
  // Bu bilinçli davranış değişikliği (eski kod direct publish'i her durumda
  // tetikliyordu; A3'te race kaybında skip).
  // Job yoksa: 404 (mevcut davranış paritesi).
  const { job, applied } = await app.prisma.$transaction(async (tx) => {
    if (isTerminal) {
      const result = await tx.ingestJob.updateMany({
        where: {
          id:     dto.jobId,
          status: { notIn: [...INGEST_TERMINAL_STATUSES] },
        },
        data: {
          status:     dto.status,
          proxyPath:  dto.proxyPath,
          checksum:   dto.checksum,
          errorMsg:   dto.errorMsg,
          finishedAt: new Date(),
          version:    { increment: 1 },
        },
      });

      const existing = await tx.ingestJob.findUnique({ where: { id: dto.jobId } });
      if (!existing) {
        throw Object.assign(
          new Error(`Ingest job not found (id=${dto.jobId})`),
          { statusCode: 404 },
        );
      }

      if (result.count !== 1) {
        // Race kaybedildi: job zaten terminal. Hiçbir side-effect yok;
        // mevcut row caller'a döner. Idempotency: ilk terminal yazımının
        // qcReport/planItem/outbox side-effect'leri zaten DB'de.
        return { job: existing, applied: false };
      }

      // İlk terminal yazımı: qcReport + planItem + outbox + (post-tx) publish.
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
          status: dto.status === 'FAILED' ? 'ISSUE' : 'COMPLETED',
        },
      });

      await writeShadowEvent(tx, {
        eventType:     'ingest.job_completed',
        aggregateType: 'IngestJob',
        aggregateId:   dto.jobId,
        payload:       { jobId: dto.jobId, status: dto.status },
        idempotencyKey: buildIngestCompletedKey(dto.jobId, dto.status as IngestTerminalStatus),
      });

      const updated = await tx.ingestJob.findUniqueOrThrow({ where: { id: dto.jobId } });
      return { job: updated, applied: true };
    }

    // Non-terminal callback: mevcut update mantığı korunur. Worker sequential;
    // race protection gerekmez. Version increment YOK (intermediate akış).
    const updated = await tx.ingestJob.update({
      where: { id: dto.jobId },
      data: {
        status:     dto.status,
        proxyPath:  dto.proxyPath,
        checksum:   dto.checksum,
        errorMsg:   dto.errorMsg,
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
        status: 'INGEST_STARTED',
      },
    });

    return { job: updated, applied: true };
  });

  if (applied) {
    await app.rabbitmq.publish(QUEUES.INGEST_COMPLETED, {
      jobId:  dto.jobId,
      status: dto.status,
    });
  }

  return job;
}
