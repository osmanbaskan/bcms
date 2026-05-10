import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBackfill } from './backfill-ingest-plan-item-id.js';
import { createAuditedPrisma } from './prisma-factory.js';
import { triggerManualIngest } from '../modules/ingest/ingest.service.js';
import {
  cleanupTransactional,
  getRawPrisma,
  makeAppHarness,
} from '../../test/integration/helpers.js';

/**
 * Phase A2 PR-2b — backfill script integration tests.
 *
 * Kapsam:
 *   ✓ dry-run UPDATE yapmaz (sayım raporu üretir)
 *   ✓ execute matching kayıtları update eder
 *   ✓ planItemId zaten dolu kayıtları atlar
 *   ✓ orphan sourceKey raporlanır ama update edilmez
 *   ✓ idempotent ikinci çalıştırma no-op
 *   ✓ metadata fallback runtime service'te hâlâ korunur (PR-2c'ye kadar)
 *   ✓ audit-extended client UPDATE sırasında audit_logs satırı yazar (audit bypass YOK)
 */

let auditedHandle: ReturnType<typeof createAuditedPrisma> | null = null;

afterAll(async () => {
  if (auditedHandle) {
    await auditedHandle.base.$disconnect();
    auditedHandle = null;
  }
});

function getAuditedClient(): PrismaClient {
  // Test DB URL setup.ts tarafından `process.env.DATABASE_URL`'e set edilir;
  // factory aynı URL'e ikinci PrismaClient açar (bilinçli — production paritesi:
  // script kendi connection pool'unu kullanır, app/worker pool'una yük getirmez).
  if (!auditedHandle) {
    auditedHandle = createAuditedPrisma();
  }
  return auditedHandle.client as unknown as PrismaClient;
}

async function seedPlanItem(sourceKey: string): Promise<{ id: number }> {
  const prisma = getRawPrisma();
  const item = await prisma.ingestPlanItem.create({
    data: {
      sourceKey,
      sourceType: 'manual',
      dayDate:    new Date('2026-06-01'),
      status:     'WAITING',
    },
  });
  return { id: item.id };
}

async function seedJob(opts: {
  metadata?:   Record<string, unknown> | null;
  planItemId?: number | null;
}): Promise<{ id: number }> {
  const prisma = getRawPrisma();
  const job = await prisma.ingestJob.create({
    data: {
      sourcePath: '/tmp/backfill-test.mp4',
      status:     'PENDING',
      metadata:   (opts.metadata ?? undefined) as never,
      planItemId: opts.planItemId ?? null,
    },
  });
  return { id: job.id };
}

describe('backfill-ingest-plan-item-id — runBackfill', () => {
  beforeEach(async () => {
    await cleanupTransactional();
  });

  test('dry-run: matching kayıt için update YAPMAZ; sayımları doğru raporlar', async () => {
    const planItem = await seedPlanItem('bf-dry-1');
    const job = await seedJob({
      metadata: { ingestPlanSourceKey: 'bf-dry-1' },
    });

    const client = getAuditedClient();
    const result = await runBackfill(client, { dryRun: true, batchSize: 100 });

    expect(result.scanned).toBe(1);
    expect(result.matchable).toBe(1);
    expect(result.orphan).toBe(0);
    expect(result.noKey).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.matchSamples).toEqual([
      { jobId: job.id, sourceKey: 'bf-dry-1', planItemId: planItem.id },
    ]);

    const prisma = getRawPrisma();
    const after = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.planItemId).toBeNull();
  });

  test('execute: eşleşen kayıtları planItemId ile günceller', async () => {
    const pi1 = await seedPlanItem('bf-exec-1');
    const pi2 = await seedPlanItem('bf-exec-2');
    const j1 = await seedJob({ metadata: { ingestPlanSourceKey: 'bf-exec-1' } });
    const j2 = await seedJob({ metadata: { ingestPlanSourceKey: 'bf-exec-2' } });

    const client = getAuditedClient();
    const result = await runBackfill(client, { dryRun: false, batchSize: 100 });

    expect(result.scanned).toBe(2);
    expect(result.matchable).toBe(2);
    expect(result.updated).toBe(2);

    const prisma = getRawPrisma();
    const a1 = await prisma.ingestJob.findUniqueOrThrow({ where: { id: j1.id } });
    const a2 = await prisma.ingestJob.findUniqueOrThrow({ where: { id: j2.id } });
    expect(a1.planItemId).toBe(pi1.id);
    expect(a2.planItemId).toBe(pi2.id);
  });

  test('planItemId zaten dolu kayıtları atlar (scan filter `planItemId: null`)', async () => {
    const pi = await seedPlanItem('bf-skip-1');
    // Bu satır zaten doldurulmuş (legacy değil).
    const linked = await seedJob({
      metadata:   { ingestPlanSourceKey: 'bf-skip-1' },
      planItemId: pi.id,
    });
    // Bu satır legacy: NULL FK + key.
    const legacy = await seedJob({
      metadata: { ingestPlanSourceKey: 'bf-skip-1' },
    });

    const client = getAuditedClient();
    const result = await runBackfill(client, { dryRun: false, batchSize: 100 });

    expect(result.scanned).toBe(1); // sadece legacy taranır
    expect(result.alreadyLinked).toBeGreaterThanOrEqual(2); // linked + (legacy update sonrası)
    expect(result.updated).toBe(1);

    const prisma = getRawPrisma();
    const linkedAfter = await prisma.ingestJob.findUniqueOrThrow({ where: { id: linked.id } });
    const legacyAfter = await prisma.ingestJob.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(linkedAfter.planItemId).toBe(pi.id);
    expect(legacyAfter.planItemId).toBe(pi.id);
  });

  test('orphan: planItem bulunmayan sourceKey raporlanır, update edilmez', async () => {
    const orphanJob = await seedJob({
      metadata: { ingestPlanSourceKey: 'bf-orphan-key' },
    });
    // Hiç planItem seed etme.

    const client = getAuditedClient();
    const result = await runBackfill(client, { dryRun: false, batchSize: 100 });

    expect(result.scanned).toBe(1);
    expect(result.matchable).toBe(0);
    expect(result.orphan).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.orphanSamples).toEqual([
      { jobId: orphanJob.id, sourceKey: 'bf-orphan-key' },
    ]);

    const prisma = getRawPrisma();
    const after = await prisma.ingestJob.findUniqueOrThrow({ where: { id: orphanJob.id } });
    expect(after.planItemId).toBeNull();
  });

  test('idempotent: ikinci çalıştırma no-op (matchable=0, updated=0)', async () => {
    await seedPlanItem('bf-idem-1');
    await seedJob({ metadata: { ingestPlanSourceKey: 'bf-idem-1' } });

    const client = getAuditedClient();
    const first = await runBackfill(client, { dryRun: false, batchSize: 100 });
    expect(first.updated).toBe(1);

    const second = await runBackfill(client, { dryRun: false, batchSize: 100 });
    expect(second.scanned).toBe(0);
    expect(second.matchable).toBe(0);
    expect(second.updated).toBe(0);
  });

  test('PR-2c: triggerManualIngest metadata-only çağrısı planItemId NULL bırakır (fallback kaldırıldı)', async () => {
    // PR-2c'de service-layer fallback resolver kaldırıldı. Eşleşen sourceKey
    // body'de gelse bile triggerManualIngest planItemId set ETMEZ; planItem
    // unchanged kalır. Backfill script ise hâlâ DB'deki legacy metadata key'leri
    // tarayabilir (bu spec'in diğer testleri kanıtlıyor) — script <-> service
    // sözleşmesi ayrıştı: legacy onarım için script, yeni request'ler için
    // canonical planItemId.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bcms-bf-pr2c-'));
    const tmpFile = path.join(tmpRoot, 'pr2c.mp4');
    fs.writeFileSync(tmpFile, Buffer.alloc(16, 0));
    const prevAllowedRoots = process.env.INGEST_ALLOWED_ROOTS;
    process.env.INGEST_ALLOWED_ROOTS = tmpRoot;
    try {
      const planItem = await seedPlanItem('bf-pr2c-no-fallback');
      const harness = makeAppHarness();
      const job = await triggerManualIngest(
        harness.app as unknown as FastifyInstance,
        { sourcePath: tmpFile, metadata: { ingestPlanSourceKey: 'bf-pr2c-no-fallback' } },
      );
      expect(job.id).toBeGreaterThan(0);
      expect(job.planItemId).toBeNull();

      const prisma = getRawPrisma();
      const unchanged = await prisma.ingestPlanItem.findUniqueOrThrow({ where: { id: planItem.id } });
      expect(unchanged.jobId).toBeNull();
      expect(unchanged.status).toBe('WAITING');
    } finally {
      if (prevAllowedRoots === undefined) delete process.env.INGEST_ALLOWED_ROOTS;
      else process.env.INGEST_ALLOWED_ROOTS = prevAllowedRoots;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('audit bypass YOK: execute sırasında audit_logs IngestJob × UPDATE satırı yazılır', async () => {
    const prisma = getRawPrisma();
    await seedPlanItem('bf-audit-1');
    const j = await seedJob({ metadata: { ingestPlanSourceKey: 'bf-audit-1' } });

    const beforeCount = await prisma.auditLog.count({
      where: { entityType: 'IngestJob', entityId: j.id, action: 'UPDATE' },
    });

    const client = getAuditedClient();
    const result = await runBackfill(client, { dryRun: false, batchSize: 100 });
    expect(result.updated).toBe(1);

    const afterCount = await prisma.auditLog.count({
      where: { entityType: 'IngestJob', entityId: j.id, action: 'UPDATE' },
    });
    expect(afterCount - beforeCount).toBeGreaterThanOrEqual(1);

    // user='system' (script context — ALS store yok → buildAuditExtension worker
    // branch default user). Bu, audit extension'ın gerçekten devreye girdiğinin
    // ekstra bir kanıtı.
    const latest = await prisma.auditLog.findFirst({
      where:   { entityType: 'IngestJob', entityId: j.id, action: 'UPDATE' },
      orderBy: { id: 'desc' },
    });
    expect(latest).not.toBeNull();
    expect(latest?.user).toBe('system');
  });
});
