import type { FastifyInstance } from 'fastify';
import { Prisma, type IngestJob, type IngestStatus } from '@prisma/client';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { isOutboxPollerAuthoritative, writeShadowEvent } from '../outbox/outbox.helpers.js';
import { validateIngestSourcePath } from './ingest.paths.js';
import { istanbulDayRangeUtc } from '../../core/tz.js';

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
 * Manual path planItemId çözümlemesi + ingestPlanItem.updateMany() ek işlem
 * içerebilir; watcher path saf yeni job creation.
 *
 * Route handler bu fonksiyonu çağırır. Auth (preHandler requireGroup
 * PERMISSIONS.ingest.write) route layer'ında kalır.
 *
 * Direct publish (queue.ingest.new) tx dışında, mevcut davranış korunur.
 */

export interface TriggerManualIngestDto {
  sourcePath: string;
  targetId?:  number;
  /** Phase A2 + A4 (DECISION-BACKEND-CANONICAL-DATA-MODEL-V1 §4.A2/§4.A4):
   *  IngestPlanItem'a structured FK; tek canonical resolver yolu. A2 PR-2c
   *  metadata.ingestPlanSourceKey fallback'ini, A4 metadata kolonunun kendisini
   *  kaldırdı. Manual ingest body'sinde yalnız `planItemId` resolve eder. */
  planItemId?: number;
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

  // Phase A2 + A4: planItemId tek canonical resolver yolu. Verildiyse var
  // olduğunu doğrula (400 erken-validasyon). Verilmediyse `resolvedPlanItemId`
  // NULL kalır; metadata kolonu A4'te DROP edildiği için fallback resolver
  // path'i yoktur.
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
  }

  const job = await app.prisma.$transaction(async (tx) => {
    const created = await tx.ingestJob.create({
      data: {
        sourcePath,
        targetId:   dto.targetId,
        planItemId: resolvedPlanItemId,
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

  // PR-C2 cut-over: direct publish env-gated. AUTHORITATIVE=true ise outbox
  // poller authoritative (shadow status='pending' yazılır); buradan publish
  // yapılmaz. Flag false/unset ise Phase 2 davranışı korunur.
  if (!isOutboxPollerAuthoritative()) {
    await app.rabbitmq.publish(QUEUES.INGEST_NEW, {
      jobId:      job.id,
      sourcePath: job.sourcePath,
      targetId:   job.targetId,
    });
  } else {
    app.log.debug(
      { domain: 'ingest', queue: QUEUES.INGEST_NEW, eventType: 'ingest.job_started' },
      'direct publish skipped — outbox poller authoritative',
    );
  }

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
    if (!isOutboxPollerAuthoritative()) {
      await app.rabbitmq.publish(QUEUES.INGEST_COMPLETED, {
        jobId,
        status: terminalStatus,
      });
    } else {
      app.log.debug(
        { domain: 'ingest', queue: QUEUES.INGEST_COMPLETED, eventType: 'ingest.job_completed' },
        'direct publish skipped — outbox poller authoritative',
      );
    }
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
    if (!isOutboxPollerAuthoritative()) {
      await app.rabbitmq.publish(QUEUES.INGEST_COMPLETED, {
        jobId:  dto.jobId,
        status: dto.status,
      });
    } else {
      app.log.debug(
        { domain: 'ingest', queue: QUEUES.INGEST_COMPLETED, eventType: 'ingest.job_completed' },
        'direct publish skipped — outbox poller authoritative',
      );
    }
  }

  return job;
}

// ────────────────────────────────────────────────────────────────────────────
// 2026-05-11: Live-plan entry → Ingest Planlama read-only projection.
//
// Ürün kuralı: Canlı Yayın Plan'daki her live_plan_entries kaydı seçilen gün
// için Ingest sekmesinde görünmeli. Filtre yalnız `deletedAt IS NULL` +
// Türkiye gün aralığı (`eventStartTime` Türkiye 00:00..23:59:59.999 UTC).
// channel/eventKey/schedule/technicalDetails/job/planItem var-yok HİÇBİRİ
// filtre değildir — bilgi alanı olarak döner.
//
// DB write YOK. Otomatik schedule / planItem / ingestJob create YOK.
// Domain ownership Y3-Y4 lock korunur (live-plan ≠ ingest); köprü read-only.
// ────────────────────────────────────────────────────────────────────────────

export interface LivePlanIngestCandidate {
  livePlanEntryId: number;
  eventKey:        string | null;
  title:           string;
  eventStartTime:  string; // ISO
  eventEndTime:    string; // ISO
  status:          string; // LivePlanStatus
  channel1Id:      number | null;
  channel2Id:      number | null;
  channel3Id:      number | null;
  leagueName:      string | null;
  planItem: {
    sourceKey:           string; // 'liveplan:<entryId>'
    recordingPort:       string | null;
    backupRecordingPort: string | null;
    status:              string;
    plannedStartMinute:  number | null;
    plannedEndMinute:    number | null;
    note:                string | null;
    jobId:               number | null;
  } | null;
  ingestJob: {
    id:         number;
    status:     IngestStatus;
    sourcePath: string;
  } | null;
  /** Bilgi alanı (filtre değil); aynı entry'nin köprüsünü gösteren broadcast
   *  schedule satırı varsa id. */
  scheduleId:           number | null;
  hasBroadcastSchedule: boolean;
}

export async function loadLivePlanIngestCandidates(
  app: FastifyInstance,
  date: string,
): Promise<LivePlanIngestCandidate[]> {
  const range = istanbulDayRangeUtc(date);

  // 1) Tüm entry'ler (HİÇBİR side-table filtresi yok).
  const entries = await app.prisma.livePlanEntry.findMany({
    where: {
      deletedAt:      null,
      eventStartTime: { gte: range.gte, lte: range.lte },
    },
    include: {
      match: { include: { league: { select: { name: true } } } },
    },
    orderBy: { eventStartTime: 'asc' },
  });

  if (entries.length === 0) return [];

  const entryIds  = entries.map((e) => e.id);
  const sourceKeys = entries.map((e) => `liveplan:${e.id}`);
  const eventKeys  = entries.map((e) => e.eventKey).filter((k): k is string => !!k);

  // 2) Batch joins — N+1 yok.
  const [planItems, ingestJobs, schedules] = await Promise.all([
    app.prisma.ingestPlanItem.findMany({
      where: { sourceKey: { in: sourceKeys } },
      include: { ports: { select: { portName: true, role: true } } },
    }),
    // Her entry için son ingest_job; targetId eşli + en yeni.
    app.prisma.ingestJob.findMany({
      where: { targetId: { in: entryIds } },
      orderBy: { id: 'desc' },
    }),
    eventKeys.length === 0
      ? Promise.resolve([] as Array<{ id: number; eventKey: string | null }>)
      : app.prisma.schedule.findMany({
          where: { eventKey: { in: eventKeys } },
          select: { id: true, eventKey: true },
        }),
  ]);

  // 3) Lookup map'ler.
  const planBySourceKey = new Map(planItems.map((p) => [p.sourceKey, p]));
  const jobByEntryId    = new Map<number, typeof ingestJobs[number]>();
  for (const j of ingestJobs) {
    if (j.targetId !== null && !jobByEntryId.has(j.targetId)) {
      jobByEntryId.set(j.targetId, j); // ordered DESC → en yeni ilk
    }
  }
  const scheduleByEventKey = new Map<string, number>();
  for (const s of schedules) {
    if (s.eventKey) scheduleByEventKey.set(s.eventKey, s.id);
  }

  // 4) Compose.
  return entries.map((e) => {
    const planItem = planBySourceKey.get(`liveplan:${e.id}`);
    const job      = jobByEntryId.get(e.id);
    const schedId  = e.eventKey ? scheduleByEventKey.get(e.eventKey) ?? null : null;

    return {
      livePlanEntryId: e.id,
      eventKey:        e.eventKey,
      title:           e.title,
      eventStartTime:  e.eventStartTime.toISOString(),
      eventEndTime:    e.eventEndTime.toISOString(),
      status:          e.status,
      channel1Id:      e.channel1Id,
      channel2Id:      e.channel2Id,
      channel3Id:      e.channel3Id,
      leagueName:      e.match?.league?.name ?? null,
      planItem: planItem
        ? {
            sourceKey:           planItem.sourceKey,
            recordingPort:       planItem.ports.find((p) => p.role === 'primary')?.portName ?? null,
            backupRecordingPort: planItem.ports.find((p) => p.role === 'backup')?.portName ?? null,
            status:              planItem.status,
            plannedStartMinute:  planItem.plannedStartMinute,
            plannedEndMinute:    planItem.plannedEndMinute,
            note:                planItem.note,
            jobId:               planItem.jobId,
          }
        : null,
      ingestJob: job
        ? { id: job.id, status: job.status, sourcePath: job.sourcePath }
        : null,
      scheduleId:           schedId,
      hasBroadcastSchedule: schedId !== null,
    };
  });
}
