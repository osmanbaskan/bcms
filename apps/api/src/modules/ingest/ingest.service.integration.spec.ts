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

  test('cross-source dedup: worker COMPLETED + callback COMPLETED → tek outbox satırı', async () => {
    const job = await seedJob();
    const app = harness.app as unknown as FastifyInstance;
    const prisma = getRawPrisma();

    // Önce worker tarafı.
    await finalizeIngestJob(app, job.id, 'COMPLETED');
    // Sonra aynı job için callback (Avid capture senaryosu — race veya recovery).
    await processIngestCallback(app, { jobId: job.id, status: 'COMPLETED' });

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(buildIngestCompletedKey(job.id, 'COMPLETED'));

    // Phase 2 invariant: direct publish her iki yoldan da yapıldı (kabul,
    // Phase 3 cut-over'da disable edilecek).
    const publishes = harness.publishedEvents.filter((e) => e.queue === 'queue.ingest.completed');
    expect(publishes).toHaveLength(2);
  });

  test('farklı terminal status (worker COMPLETED + callback FAILED): iki ayrı outbox satırı', async () => {
    const job = await seedJob();
    const app = harness.app as unknown as FastifyInstance;
    const prisma = getRawPrisma();

    await finalizeIngestJob(app, job.id, 'COMPLETED');
    // Aynı job için callback FAILED — recovery/override senaryosu.
    await processIngestCallback(app, { jobId: job.id, status: 'FAILED', errorMsg: 'override' });

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: String(job.id) },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotencyKey).sort()).toEqual([
      buildIngestCompletedKey(job.id, 'COMPLETED'),
      buildIngestCompletedKey(job.id, 'FAILED'),
    ]);
  });
});
