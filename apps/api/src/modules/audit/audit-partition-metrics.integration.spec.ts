import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  getDefaultPartitionRows,
  getMonthlyPartitionCount,
  getOldestMonthlyPartitionAgeDays,
} from './audit-partition-metrics.helpers.js';
import { cleanupTransactional, getRawPrisma } from '../../../test/integration/helpers.js';

/**
 * Madde 1 PR-1D regression spec — partition metrics helpers.
 *
 * Throwaway parent + monthly partitions + default kullanır;
 * production audit_logs'a dokunulmaz.
 */

const TEST_PARENT = 'audit_metrics_test';
const TEST_DEFAULT = `${TEST_PARENT}_default`;

describe('Audit partition metrics helpers — DB integration', () => {
  beforeEach(async () => {
    await cleanupTransactional();
    const prisma = getRawPrisma();
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TEST_PARENT}" CASCADE`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${TEST_PARENT}" (
        id SERIAL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id, timestamp)
      ) PARTITION BY RANGE (timestamp)
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${TEST_PARENT}_2025_06" PARTITION OF "${TEST_PARENT}"
        FOR VALUES FROM ('2025-06-01') TO ('2025-07-01')
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${TEST_PARENT}_2026_01" PARTITION OF "${TEST_PARENT}"
        FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${TEST_PARENT}_2026_05" PARTITION OF "${TEST_PARENT}"
        FOR VALUES FROM ('2026-05-01') TO ('2026-06-01')
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${TEST_DEFAULT}" PARTITION OF "${TEST_PARENT}" DEFAULT
    `);
  });

  afterEach(async () => {
    const prisma = getRawPrisma();
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TEST_PARENT}" CASCADE`);
  });

  test('getDefaultPartitionRows: boş default → 0', async () => {
    const prisma = getRawPrisma();
    const value = await getDefaultPartitionRows(prisma, TEST_DEFAULT);
    expect(value).toBe(0);
  });

  test('getDefaultPartitionRows: dolu default → row count', async () => {
    const prisma = getRawPrisma();
    // Default partition'a düşen 2 satır (range dışı timestamp'ler):
    await prisma.$executeRawUnsafe(`
      INSERT INTO "${TEST_PARENT}" (timestamp) VALUES
        ('2024-12-15T10:00:00Z'),
        ('2027-09-01T10:00:00Z')
    `);
    const value = await getDefaultPartitionRows(prisma, TEST_DEFAULT);
    expect(value).toBe(2);
  });

  test('getDefaultPartitionRows: var olmayan tablo → null', async () => {
    const prisma = getRawPrisma();
    const value = await getDefaultPartitionRows(prisma, 'audit_metrics_test_no_such');
    expect(value).toBeNull();
  });

  test('getMonthlyPartitionCount: 3 monthly + 1 default → 3', async () => {
    const prisma = getRawPrisma();
    const value = await getMonthlyPartitionCount(prisma, TEST_PARENT);
    expect(value).toBe(3);
  });

  test('getMonthlyPartitionCount: production audit_logs (test DB regular) → null', async () => {
    const prisma = getRawPrisma();
    const value = await getMonthlyPartitionCount(prisma);
    expect(value).toBeNull();
  });

  test('getMonthlyPartitionCount: var olmayan parent → null', async () => {
    const prisma = getRawPrisma();
    const value = await getMonthlyPartitionCount(prisma, 'audit_metrics_test_no_such_parent');
    expect(value).toBeNull();
  });

  test('getOldestMonthlyPartitionAgeDays: 2025-06 (en eski) → bugüne kadar gün', async () => {
    const prisma = getRawPrisma();
    const now = new Date('2026-05-15T12:00:00Z');
    const value = await getOldestMonthlyPartitionAgeDays(prisma, TEST_PARENT, now);
    // 2025-06-01 → 2026-05-15: ~348 gün (defansif: 340-360)
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThanOrEqual(340);
    expect(value!).toBeLessThanOrEqual(360);
  });

  test('getOldestMonthlyPartitionAgeDays: production audit_logs → null', async () => {
    const prisma = getRawPrisma();
    const value = await getOldestMonthlyPartitionAgeDays(prisma);
    expect(value).toBeNull();
  });

  test('Identifier guard: invalid tablo adı → null (default rows) veya null (count)', async () => {
    const prisma = getRawPrisma();
    expect(await getDefaultPartitionRows(prisma, 'foo; DROP')).toBeNull();
    expect(await getMonthlyPartitionCount(prisma, 'foo; DROP')).toBeNull();
    expect(await getOldestMonthlyPartitionAgeDays(prisma, 'foo; DROP')).toBeNull();
  });
});
