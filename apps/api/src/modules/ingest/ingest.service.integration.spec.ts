import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildIngestCompletedKey,
  finalizeIngestJob,
  processIngestCallback,
  triggerManualIngest,
} from './ingest.service.js';
import {
  cleanupTransactional,
  getRawPrisma,
  makeAppHarness,
  type TestAppHarness,
} from '../../../test/integration/helpers.js';

/**
 * Madde 2+7 PR-B3b-1 (audit doc): Ingest manual trigger Phase 2 shadow outbox.
 *
 * Kapsam:
 *   ✓ Manual ingest happy path → IngestJob create + outbox row
 *     (eventType='ingest.job_started', status='published') + direct publish
 *     (queue.ingest.new). Tx içi shadow + tx dışı direct publish invariant.
 *   ✓ Boundary: targetId non-existing live_plan_entry → 400 (Y5-7 paritesi)
 *     atomic (no IngestJob, no outbox row, no direct publish).
 *
 * NOT — auth scope:
 *   Bu spec triggerManualIngest()'i doğrudan çağırır; route handler'ın
 *   preHandler `app.requireGroup(...PERMISSIONS.ingest.write)` katmanı bu
 *   testten kapsam dışındadır. Outbox shadow davranışı service-layer; auth
 *   kontrolleri ayrı RBAC test scope'una aittir (helpers HTTP-layer infra
 *   içermiyor; bkz. booking.service.integration.spec.ts pattern).
 *
 * Watcher path (chokidar) bu PR'da test edilmez — FS-driven, awaitWriteFinish
 * 3s threshold'u integration testte flaky. Watcher refactor outbox helper'ını
 * paylaşır; helper'ın kendi unit-level davranışı booking/schedule spec'lerinde
 * dolaylı kapsanıyor.
 */

// validateIngestSourcePath gerçek FS dosyası bekliyor; tmp root oluştur.
let tmpRoot: string;
let tmpFile: string;
let prevAllowedRoots: string | undefined;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bcms-ingest-test-'));
  tmpFile = path.join(tmpRoot, 'sample.mp4');
  fs.writeFileSync(tmpFile, Buffer.alloc(16, 0));

  prevAllowedRoots = process.env.INGEST_ALLOWED_ROOTS;
  process.env.INGEST_ALLOWED_ROOTS = tmpRoot;
});

afterAll(async () => {
  if (prevAllowedRoots === undefined) delete process.env.INGEST_ALLOWED_ROOTS;
  else process.env.INGEST_ALLOWED_ROOTS = prevAllowedRoots;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('triggerManualIngest — integration', () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
  });

  test('happy path: ingest job + outbox shadow + direct publish', async () => {
    const job = await triggerManualIngest(
      harness.app as unknown as FastifyInstance,
      { sourcePath: tmpFile },
    );

    expect(job.id).toBeGreaterThan(0);
    expect(job.status).toBe('PENDING');

    // Direct publish: queue.ingest.new'e tek mesaj.
    const ingestPublishes = harness.publishedEvents.filter(
      (e) => e.queue === 'queue.ingest.new',
    );
    expect(ingestPublishes).toHaveLength(1);
    expect(ingestPublishes[0].payload).toMatchObject({
      jobId:      job.id,
      sourcePath: job.sourcePath,
    });

    // Outbox shadow row: tek satır, status='published', payload publish ile uyumlu.
    const prisma = getRawPrisma();
    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.eventType).toBe('ingest.job_started');
    expect(row.status).toBe('published');
    expect(row.publishedAt).not.toBeNull();
    expect(row.schemaVersion).toBe(1);
    const payload = row.payload as Record<string, unknown>;
    expect(payload.jobId).toBe(job.id);
    expect(payload.sourcePath).toBe(job.sourcePath);
  });

  test('boundary: targetId non-existing live_plan_entry → 400 atomic (no job, no outbox, no publish)', async () => {
    // SCHED-B5a (Y5-7): ingest schedule coupling kaldırıldı; targetId
    // canonical olarak live_plan_entries.id beklenir. Existing OLMAYAN ID
    // ile ingest tetiklenirse 400 + atomik rollback.
    const NON_EXISTING_LPE_ID = 999_999_999;

    await expect(
      triggerManualIngest(
        harness.app as unknown as FastifyInstance,
        { sourcePath: tmpFile, targetId: NON_EXISTING_LPE_ID },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Atomicity: hiç IngestJob yok, outbox satırı yok, publish yok.
    const prisma = getRawPrisma();
    const jobCount = await prisma.ingestJob.count();
    expect(jobCount).toBe(0);

    const outboxCount = await prisma.outboxEvent.count({
      where: { aggregateType: 'IngestJob' },
    });
    expect(outboxCount).toBe(0);

    expect(
      harness.publishedEvents.filter((e) => e.queue === 'queue.ingest.new'),
    ).toHaveLength(0);
  });
});

/**
 * Madde 2+7 PR-B3b-2 (audit doc): INGEST_COMPLETED Phase 2 shadow + idempotency.
 *
 * Worker (finalizeIngestJob) ve callback (processIngestCallback) iki ayrı
 * authoritative üretici. Aynı (jobId, terminalStatus) için DB partial unique
 * üzerinden tek outbox satırı garantisi. Phase 2'de direct publish her iki
 * yoldan yine yapılır — Phase 3 cut-over'da poller authoritative direct'i alır.
 *
 * Intermediate status (PROCESSING/PROXY_GEN/QC) callback'te shadow YAZMAZ;
 * worker zaten yalnız terminal publish ediyor, parity korunur.
 */
describe('INGEST_COMPLETED shadow — finalizeIngestJob + processIngestCallback', () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
  });

  async function seedJob(): Promise<{ id: number }> {
    const prisma = getRawPrisma();
    const job = await prisma.ingestJob.create({
      data: { sourcePath: '/tmp/x.mp4', status: 'PROCESSING' },
    });
    return { id: job.id };
  }

  test('finalizeIngestJob COMPLETED: outbox shadow + direct publish + idempotency key set', async () => {
    const job = await seedJob();
    await finalizeIngestJob(harness.app as unknown as FastifyInstance, job.id, 'COMPLETED');

    const prisma = getRawPrisma();
    const updated = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('COMPLETED');
    expect(updated.finishedAt).not.toBeNull();

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('ingest.job_completed');
    expect(rows[0].status).toBe('published');
    expect(rows[0].idempotencyKey).toBe(buildIngestCompletedKey(job.id, 'COMPLETED'));

    const publishes = harness.publishedEvents.filter((e) => e.queue === 'queue.ingest.completed');
    expect(publishes).toHaveLength(1);
    expect(publishes[0].payload).toMatchObject({ jobId: job.id, status: 'COMPLETED' });
  });

  test('finalizeIngestJob FAILED: errorMsg propagate + shadow + key', async () => {
    const job = await seedJob();
    await finalizeIngestJob(
      harness.app as unknown as FastifyInstance,
      job.id,
      'FAILED',
      { errorMsg: 'codec unsupported' },
    );

    const prisma = getRawPrisma();
    const updated = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('FAILED');
    expect(updated.errorMsg).toBe('codec unsupported');

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(buildIngestCompletedKey(job.id, 'FAILED'));
  });

  test('processIngestCallback COMPLETED: tx içi update + qcReport + planItem + shadow', async () => {
    const job = await seedJob();
    const prisma = getRawPrisma();

    // Plan item seed (callback updateMany'ye bir hedef bulsun).
    await prisma.ingestPlanItem.create({
      data: {
        sourceKey:  'test-source-1',
        sourceType: 'manual',
        dayDate:    new Date('2026-05-06'),
        jobId:      job.id,
        status:     'INGEST_STARTED',
      },
    });

    await processIngestCallback(harness.app as unknown as FastifyInstance, {
      jobId:    job.id,
      status:   'COMPLETED',
      proxyPath: '/tmp/proxy.mp4',
      checksum:  'sha256-abc',
      qcReport: { codec: 'h264', resolution: '1920x1080', errors: [], warnings: [], passed: true },
    });

    const updated = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('COMPLETED');
    expect(updated.proxyPath).toBe('/tmp/proxy.mp4');

    const qc = await prisma.qcReport.findUnique({ where: { jobId: job.id } });
    expect(qc).not.toBeNull();
    expect(qc?.passed).toBe(true);

    const planItem = await prisma.ingestPlanItem.findUnique({ where: { sourceKey: 'test-source-1' } });
    expect(planItem?.status).toBe('COMPLETED');

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('ingest.job_completed');
    expect(rows[0].idempotencyKey).toBe(buildIngestCompletedKey(job.id, 'COMPLETED'));

    const publishes = harness.publishedEvents.filter((e) => e.queue === 'queue.ingest.completed');
    expect(publishes).toHaveLength(1);
  });

  test('processIngestCallback intermediate (PROCESSING): direct publish var, shadow YOK', async () => {
    const job = await seedJob();
    await processIngestCallback(harness.app as unknown as FastifyInstance, {
      jobId:  job.id,
      status: 'PROCESSING',
    });

    const prisma = getRawPrisma();
    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
    });
    expect(rows).toHaveLength(0);

    // Direct publish her status için aktif (mevcut davranış korunur).
    const publishes = harness.publishedEvents.filter((e) => e.queue === 'queue.ingest.completed');
    expect(publishes).toHaveLength(1);
    expect(publishes[0].payload).toMatchObject({ jobId: job.id, status: 'PROCESSING' });
  });

  test('cross-source dedup: worker COMPLETED + callback COMPLETED → tek outbox satırı + tek publish (A3 race-loss skip)', async () => {
    const job = await seedJob();
    const app = harness.app as unknown as FastifyInstance;
    const prisma = getRawPrisma();

    // Önce worker tarafı (kazanır).
    await finalizeIngestJob(app, job.id, 'COMPLETED');
    // Sonra aynı job için callback (Avid capture senaryosu — race kaybı).
    await processIngestCallback(app, { jobId: job.id, status: 'COMPLETED' });

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(buildIngestCompletedKey(job.id, 'COMPLETED'));

    // Phase A3 (DECISION V1 §4.A3): Race kaybeden çağrı direct publish DE
    // YAPMAZ. Eski Phase 2 "her iki yoldan publish" davranışı bu A3 ile
    // değiştirildi (race-loss skip). Phase 3 poller cut-over'ından bağımsız.
    const publishes = harness.publishedEvents.filter((e) => e.queue === 'queue.ingest.completed');
    expect(publishes).toHaveLength(1);
  });

  test('farklı terminal status (worker COMPLETED + callback FAILED): A3 race-loss; tek outbox, tek publish, status COMPLETED kalır', async () => {
    const job = await seedJob();
    const app = harness.app as unknown as FastifyInstance;
    const prisma = getRawPrisma();

    await finalizeIngestJob(app, job.id, 'COMPLETED');
    // Aynı job için callback FAILED — A3 öncesi override yapardı; A3 sonrası
    // "ilk terminal kazanır" → callback FAILED no-op.
    await processIngestCallback(app, { jobId: job.id, status: 'FAILED', errorMsg: 'override' });

    const updated = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('COMPLETED');
    expect(updated.errorMsg).toBeNull();

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(buildIngestCompletedKey(job.id, 'COMPLETED'));

    const publishes = harness.publishedEvents.filter((e) => e.queue === 'queue.ingest.completed');
    expect(publishes).toHaveLength(1);
  });
});

/**
 * Phase A1 (DECISION-BACKEND-CANONICAL-DATA-MODEL-V1 §4.A1, 2026-05-09):
 * IngestJob.targetId Prisma relation + DB FK ON DELETE SET NULL.
 *
 * Kapsam:
 *   ✓ Entry hard-delete → IngestJob historic kaydı korunur, target_id NULL
 *     (cascade DELETE'in operasyonel domain'de yasak olduğu §2/6 ilkesinin
 *     dolaylı doğrulaması; ingest job kayıtları rapor için referans değer).
 *
 * Y5-7 lock + DECISION V1 §4.A1: targetId canonical olarak live_plan_entries.id.
 * "Boundary: targetId non-existing → 400 atomic" testi yukarıda mevcut spec'te
 * korunur; FK eklenmesi bu davranışı kuvvetlendirir (early validation 400 +
 * DB FK referential integrity).
 */
describe('IngestJob.targetId FK SetNull (Phase A1) — integration', () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
  });

  test('LivePlanEntry hard-delete → IngestJob.targetId NULL (SET NULL cascade)', async () => {
    const prisma = getRawPrisma();

    // 1. LivePlanEntry seed (M5-B1 schema; minimum required: title + iki tarih).
    const entry = await prisma.livePlanEntry.create({
      data: {
        title:          'A1 FK SetNull test',
        eventStartTime: new Date('2026-06-01T19:00:00Z'),
        eventEndTime:   new Date('2026-06-01T21:00:00Z'),
        eventKey:       `manual:a1-fk-${Date.now()}`,
        sourceType:     'MANUAL',
      },
    });

    // 2. IngestJob create with targetId = entry.id.
    const job = await triggerManualIngest(
      harness.app as unknown as FastifyInstance,
      { sourcePath: tmpFile, targetId: entry.id },
    );
    expect(job.targetId).toBe(entry.id);

    // 3. Hard-delete entry (FK ON DELETE SET NULL).
    await prisma.livePlanEntry.delete({ where: { id: entry.id } });

    // 4. IngestJob hâlâ DB'de; targetId NULL.
    const updated = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.id).toBe(job.id);
    expect(updated.targetId).toBeNull();
    // Entry gerçekten silindi (cascade ingestJob'ı silmemiş olduğunu da doğrula).
    const entryAfter = await prisma.livePlanEntry.findUnique({ where: { id: entry.id } });
    expect(entryAfter).toBeNull();
  });
});

/**
 * Phase A2 PR-2a (DECISION-BACKEND-CANONICAL-DATA-MODEL-V1 §4.A2, 2026-05-09):
 * IngestJob.planItemId structured FK; transient `metadata.ingestPlanSourceKey`
 * deprecated fallback yolu A4'e kadar korunur.
 *
 * Karar matrisi (PR-2a):
 *   ✓ planItemId canonical, doğrudan tek tx içinde set edilir.
 *   ✓ planItemId + metadata birlikte → planItemId kazanır, metadata yok sayılır.
 *   ✓ Geçersiz planItemId → 400 erken-validasyon (job/outbox/publish yok).
 *   ✓ Sadece metadata fallback verilir + key DB'de yoksa → yumuşak davranış
 *     (job create, planItemId NULL).
 *   ✓ Plan item hard-delete → ON DELETE SET NULL (job korunur, planItemId NULL).
 */
describe('IngestJob.planItemId structured FK (Phase A2) — integration', () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
  });

  async function seedPlanItem(sourceKey: string): Promise<{ id: number; sourceKey: string }> {
    const prisma = getRawPrisma();
    const item = await prisma.ingestPlanItem.create({
      data: {
        sourceKey,
        sourceType: 'manual',
        dayDate:    new Date('2026-06-01'),
        status:     'WAITING',
      },
    });
    return { id: item.id, sourceKey: item.sourceKey };
  }

  test('planItemId canonical → job.planItemId set, planItem.jobId set, status INGEST_STARTED, sourcePath update', async () => {
    const prisma = getRawPrisma();
    const planItem = await seedPlanItem('a2-canonical-1');

    const job = await triggerManualIngest(
      harness.app as unknown as FastifyInstance,
      { sourcePath: tmpFile, planItemId: planItem.id },
    );

    expect(job.planItemId).toBe(planItem.id);

    const updatedItem = await prisma.ingestPlanItem.findUniqueOrThrow({ where: { id: planItem.id } });
    expect(updatedItem.jobId).toBe(job.id);
    expect(updatedItem.status).toBe('INGEST_STARTED');
    expect(updatedItem.sourcePath).toBe(tmpFile);
  });

  test('deprecated metadata.ingestPlanSourceKey fallback → planItem lookup edilir, invariant aynı', async () => {
    const prisma = getRawPrisma();
    const planItem = await seedPlanItem('a2-fallback-1');

    const job = await triggerManualIngest(
      harness.app as unknown as FastifyInstance,
      {
        sourcePath: tmpFile,
        metadata:   { ingestPlanSourceKey: planItem.sourceKey },
      },
    );

    expect(job.planItemId).toBe(planItem.id);

    const updatedItem = await prisma.ingestPlanItem.findUniqueOrThrow({ where: { id: planItem.id } });
    expect(updatedItem.jobId).toBe(job.id);
    expect(updatedItem.status).toBe('INGEST_STARTED');
  });

  test('planItemId + metadata birlikte → planItemId kazanır, metadata yok sayılır', async () => {
    const prisma = getRawPrisma();
    const winner = await seedPlanItem('a2-winner');
    const ignored = await seedPlanItem('a2-ignored');

    const job = await triggerManualIngest(
      harness.app as unknown as FastifyInstance,
      {
        sourcePath: tmpFile,
        planItemId: winner.id,
        metadata:   { ingestPlanSourceKey: ignored.sourceKey },
      },
    );

    expect(job.planItemId).toBe(winner.id);

    const winnerItem = await prisma.ingestPlanItem.findUniqueOrThrow({ where: { id: winner.id } });
    expect(winnerItem.jobId).toBe(job.id);
    expect(winnerItem.status).toBe('INGEST_STARTED');

    const ignoredItem = await prisma.ingestPlanItem.findUniqueOrThrow({ where: { id: ignored.id } });
    expect(ignoredItem.jobId).toBeNull();
    expect(ignoredItem.status).toBe('WAITING');
  });

  test('invalid explicit planItemId → 400 atomic (no job, no outbox, no publish)', async () => {
    const prisma = getRawPrisma();
    const NON_EXISTING_PI_ID = 999_999_999;

    await expect(
      triggerManualIngest(
        harness.app as unknown as FastifyInstance,
        { sourcePath: tmpFile, planItemId: NON_EXISTING_PI_ID },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(await prisma.ingestJob.count()).toBe(0);
    expect(
      await prisma.outboxEvent.count({ where: { aggregateType: 'IngestJob' } }),
    ).toBe(0);
    expect(
      harness.publishedEvents.filter((e) => e.queue === 'queue.ingest.new'),
    ).toHaveLength(0);
  });

  test('deprecated metadata sourceKey missing → yumuşak davranış (job create, planItemId NULL)', async () => {
    const prisma = getRawPrisma();

    const job = await triggerManualIngest(
      harness.app as unknown as FastifyInstance,
      {
        sourcePath: tmpFile,
        metadata:   { ingestPlanSourceKey: 'a2-nonexistent-key' },
      },
    );

    expect(job.id).toBeGreaterThan(0);
    expect(job.planItemId).toBeNull();

    const planItemCount = await prisma.ingestPlanItem.count();
    expect(planItemCount).toBe(0);
  });

  test('IngestPlanItem hard-delete → IngestJob.planItemId NULL (SET NULL cascade)', async () => {
    const prisma = getRawPrisma();
    const planItem = await seedPlanItem('a2-set-null-cascade');

    const job = await triggerManualIngest(
      harness.app as unknown as FastifyInstance,
      { sourcePath: tmpFile, planItemId: planItem.id },
    );
    expect(job.planItemId).toBe(planItem.id);

    // Hard-delete plan item. Mevcut "IngestPlanItem.jobId → IngestJob" CASCADE
    // ters yön; bu silme işleminde plan item parent değil, child (IngestJob
    // perspektifinden). FK ingest_jobs_plan_item_id_fkey ON DELETE SET NULL.
    await prisma.ingestPlanItem.delete({ where: { id: planItem.id } });

    const updated = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.planItemId).toBeNull();
  });
});

/**
 * Phase A3 (DECISION-BACKEND-CANONICAL-DATA-MODEL-V1 §4.A3, 2026-05-09):
 * IngestJob.version optimistic locking. Worker + callback authoritative
 * üreticiler arasında terminal status race koruması.
 *
 * Karar matrisi (A3):
 *   ✓ İlk terminal write kazanır.
 *   ✓ Race kaybeden çağrı: DB update yok, qcReport upsert yok, planItem
 *     status update yok, outbox shadow yok, direct rabbitmq publish yok.
 *   ✓ Aynı status duplicate callback no-op.
 *   ✓ COMPLETED sonra FAILED (veya tersi) no-op.
 *   ✓ Non-terminal callback mevcut update korunur; version increment yok.
 *   ✓ Job yok: callback 404; finalizeIngestJob worker path açık hata.
 *   ✓ External callback contract DEĞİŞMEZ (If-Match yok).
 */
describe('IngestJob.version optimistic locking (Phase A3) — integration', () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
  });

  async function seedJobLocal(): Promise<{ id: number }> {
    const prisma = getRawPrisma();
    const job = await prisma.ingestJob.create({
      data: { sourcePath: '/tmp/x.mp4', status: 'PROCESSING' },
    });
    return { id: job.id };
  }

  test('create sonrası version default 1', async () => {
    const prisma = getRawPrisma();
    const job = await prisma.ingestJob.create({
      data: { sourcePath: '/tmp/v1.mp4', status: 'PENDING' },
    });
    expect(job.version).toBe(1);
  });

  test('finalizeIngestJob COMPLETED: status COMPLETED, version 2, outbox 1, publish 1', async () => {
    const prisma = getRawPrisma();
    const job = await seedJobLocal();
    await finalizeIngestJob(harness.app as unknown as FastifyInstance, job.id, 'COMPLETED');

    const updated = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('COMPLETED');
    expect(updated.version).toBe(2);

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
    });
    expect(rows).toHaveLength(1);

    const publishes = harness.publishedEvents.filter((e) => e.queue === 'queue.ingest.completed');
    expect(publishes).toHaveLength(1);
  });

  test('processIngestCallback COMPLETED: status COMPLETED, version 2, outbox 1, publish 1', async () => {
    const prisma = getRawPrisma();
    const job = await seedJobLocal();
    await processIngestCallback(
      harness.app as unknown as FastifyInstance,
      { jobId: job.id, status: 'COMPLETED' },
    );

    const updated = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('COMPLETED');
    expect(updated.version).toBe(2);

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
    });
    expect(rows).toHaveLength(1);

    const publishes = harness.publishedEvents.filter((e) => e.queue === 'queue.ingest.completed');
    expect(publishes).toHaveLength(1);
  });

  test('duplicate terminal same status: ikinci çağrı no-op (version, outbox, publish değişmez)', async () => {
    const prisma = getRawPrisma();
    const job = await seedJobLocal();
    const app = harness.app as unknown as FastifyInstance;

    await finalizeIngestJob(app, job.id, 'COMPLETED');
    await finalizeIngestJob(app, job.id, 'COMPLETED');

    const updated = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('COMPLETED');
    expect(updated.version).toBe(2);

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
    });
    expect(rows).toHaveLength(1);

    const publishes = harness.publishedEvents.filter((e) => e.queue === 'queue.ingest.completed');
    expect(publishes).toHaveLength(1);
  });

  test('COMPLETED sonra FAILED: status COMPLETED kalır, version 2 kalır, FAILED outbox/publish yok', async () => {
    const prisma = getRawPrisma();
    const job = await seedJobLocal();
    const app = harness.app as unknown as FastifyInstance;

    await finalizeIngestJob(app, job.id, 'COMPLETED');
    // Aynı job için callback FAILED — A3 race-loss skip.
    await processIngestCallback(app, { jobId: job.id, status: 'FAILED', errorMsg: 'override' });

    const updated = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('COMPLETED');
    expect(updated.version).toBe(2);
    expect(updated.errorMsg).toBeNull();

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(buildIngestCompletedKey(job.id, 'COMPLETED'));

    const publishes = harness.publishedEvents.filter((e) => e.queue === 'queue.ingest.completed');
    expect(publishes).toHaveLength(1);
  });

  test('FAILED sonra COMPLETED: status FAILED kalır, version 2 kalır, COMPLETED outbox/publish yok', async () => {
    const prisma = getRawPrisma();
    const job = await seedJobLocal();
    const app = harness.app as unknown as FastifyInstance;

    await finalizeIngestJob(app, job.id, 'FAILED', { errorMsg: 'codec' });
    await processIngestCallback(app, { jobId: job.id, status: 'COMPLETED' });

    const updated = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('FAILED');
    expect(updated.version).toBe(2);
    expect(updated.errorMsg).toBe('codec');

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(buildIngestCompletedKey(job.id, 'FAILED'));

    const publishes = harness.publishedEvents.filter((e) => e.queue === 'queue.ingest.completed');
    expect(publishes).toHaveLength(1);
  });

  test('non-terminal callback (PROCESSING) version increment YAPMAZ', async () => {
    const prisma = getRawPrisma();
    const job = await seedJobLocal();

    await processIngestCallback(
      harness.app as unknown as FastifyInstance,
      { jobId: job.id, status: 'PROCESSING' },
    );

    const updated = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('PROCESSING');
    expect(updated.version).toBe(1);
  });

  test('processIngestCallback missing job → 404', async () => {
    await expect(
      processIngestCallback(
        harness.app as unknown as FastifyInstance,
        { jobId: 999_999_999, status: 'COMPLETED' },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('finalizeIngestJob missing job → açık hata (sessiz no-op değil)', async () => {
    await expect(
      finalizeIngestJob(
        harness.app as unknown as FastifyInstance,
        999_999_999,
        'COMPLETED',
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
