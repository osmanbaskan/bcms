import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { triggerManualIngest } from './ingest.service.js';
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
 *   ✓ Boundary: targetId broadcast usageScope schedule'ı işaret ediyor → 400
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

  test('boundary: targetId broadcast schedule → 400 atomic (no job, no outbox, no publish)', async () => {
    // Broadcast usageScope schedule oluştur — manual ingest target olamaz.
    const prisma = getRawPrisma();
    const sch = await prisma.schedule.create({
      data: {
        channelId:  1,
        startTime:  new Date(),
        endTime:    new Date(Date.now() + 60 * 60 * 1000),
        title:      'Broadcast schedule (ingest target invalid)',
        status:     'CONFIRMED',
        usageScope: 'broadcast',
        createdBy:  'integration-test',
      },
    });

    await expect(
      triggerManualIngest(
        harness.app as unknown as FastifyInstance,
        { sourcePath: tmpFile, targetId: sch.id },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Atomicity: hiç IngestJob yok, outbox satırı yok, publish yok.
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
