import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  clearPartitionStatusCache,
  dropPartition,
  findExpiredPartitions,
  isTablePartitioned,
  parseMonthlyPartitionName,
} from './audit-retention.helpers.js';
import { cleanupTransactional, getRawPrisma } from '../../../test/integration/helpers.js';

/**
 * Madde 1 PR-1B regression spec — retention helpers + feature-detect.
 *
 * Throwaway test tablosu (`audit_retention_test`) kullanılır; production
 * audit_logs'a dokunulmaz (kullanıcı guard).
 */

const TEST_PARENT = 'audit_retention_test';

describe('parseMonthlyPartitionName', () => {
  test('valid: audit_logs_2026_05 → 2026-05-01..2026-06-01', () => {
    const info = parseMonthlyPartitionName('audit_logs_2026_05');
    expect(info).not.toBeNull();
    expect(info!.rangeStart.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(info!.rangeEnd.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  test('default partition → null', () => {
    expect(parseMonthlyPartitionName('audit_logs_default')).toBeNull();
  });

  test('legacy → null', () => {
    expect(parseMonthlyPartitionName('audit_logs_legacy')).toBeNull();
  });

  test('invalid month (00, 13) → null', () => {
    expect(parseMonthlyPartitionName('audit_logs_2026_00')).toBeNull();
    expect(parseMonthlyPartitionName('audit_logs_2026_13')).toBeNull();
  });

  test('invalid year sanity (1999, 2200) → null', () => {
    expect(parseMonthlyPartitionName('audit_logs_1999_05')).toBeNull();
    expect(parseMonthlyPartitionName('audit_logs_2200_05')).toBeNull();
  });

  test('custom prefix: audit_retention_test_2025_03 → ok', () => {
    const info = parseMonthlyPartitionName('audit_retention_test_2025_03', 'audit_retention_test');
    expect(info).not.toBeNull();
    expect(info!.rangeStart.toISOString()).toBe('2025-03-01T00:00:00.000Z');
  });

  test('Aralık (12) → bir sonraki yılın Ocak başı', () => {
    const info = parseMonthlyPartitionName('audit_logs_2026_12');
    expect(info!.rangeStart.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(info!.rangeEnd.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('Audit Retention helpers — DB integration', () => {
  beforeEach(async () => {
    await cleanupTransactional();
    clearPartitionStatusCache();
    const prisma = getRawPrisma();
    // Throwaway parent + partitions yeniden create
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TEST_PARENT}" CASCADE`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${TEST_PARENT}" (
        id SERIAL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id, timestamp)
      ) PARTITION BY RANGE (timestamp)
    `);
    // 3 monthly partition (eski, eski, güncel) + default
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${TEST_PARENT}_2025_01" PARTITION OF "${TEST_PARENT}"
        FOR VALUES FROM ('2025-01-01') TO ('2025-02-01')
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${TEST_PARENT}_2025_02" PARTITION OF "${TEST_PARENT}"
        FOR VALUES FROM ('2025-02-01') TO ('2025-03-01')
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${TEST_PARENT}_2026_05" PARTITION OF "${TEST_PARENT}"
        FOR VALUES FROM ('2026-05-01') TO ('2026-06-01')
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${TEST_PARENT}_default" PARTITION OF "${TEST_PARENT}" DEFAULT
    `);
  });

  afterEach(async () => {
    const prisma = getRawPrisma();
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TEST_PARENT}" CASCADE`);
    clearPartitionStatusCache();
  });

  test('isTablePartitioned: throwaway parent → true', async () => {
    const prisma = getRawPrisma();
    const result = await isTablePartitioned(prisma, TEST_PARENT);
    expect(result).toBe(true);
  });

  test('isTablePartitioned: production audit_logs (test DB) → false (db push regular)', async () => {
    const prisma = getRawPrisma();
    const result = await isTablePartitioned(prisma);
    expect(result).toBe(false);
  });

  test('isTablePartitioned cache: ikinci çağrı DB sorgusu yapmadan döner', async () => {
    const prisma = getRawPrisma();
    const first = await isTablePartitioned(prisma, TEST_PARENT);
    expect(first).toBe(true);
    // Throwaway parent'ı drop et; cache hâlâ true dönmeli (cache invalid değil).
    await prisma.$executeRawUnsafe(`DROP TABLE "${TEST_PARENT}" CASCADE`);
    const cached = await isTablePartitioned(prisma, TEST_PARENT);
    expect(cached).toBe(true);
    // clearPartitionStatusCache → fresh check
    clearPartitionStatusCache();
    const fresh = await isTablePartitioned(prisma, TEST_PARENT);
    expect(fresh).toBe(false);
    // afterEach throwaway parent'ı yeniden create için drop tekrarı zararsız (IF EXISTS)
  });

  test('findExpiredPartitions: cutoff 2026-04-01 → 2025_01 + 2025_02 expired, 2026_05 ve default skip', async () => {
    const prisma = getRawPrisma();
    const cutoff = new Date('2026-04-01T00:00:00Z');
    const expired = await findExpiredPartitions(prisma, cutoff, TEST_PARENT);
    const names = expired.map((e) => e.name).sort();
    expect(names).toEqual([`${TEST_PARENT}_2025_01`, `${TEST_PARENT}_2025_02`]);
  });

  test('findExpiredPartitions: cutoff 2025-01-15 (ortada) → hiçbir partition end <= cutoff değil', async () => {
    const prisma = getRawPrisma();
    // 2025_01 partition end = 2025-02-01, cutoff = 2025-01-15 → end > cutoff → expired DEĞİL
    const cutoff = new Date('2025-01-15T00:00:00Z');
    const expired = await findExpiredPartitions(prisma, cutoff, TEST_PARENT);
    expect(expired).toHaveLength(0);
  });

  test('dropPartition: dryRun=true → tablo durur', async () => {
    const prisma = getRawPrisma();
    const partition = `${TEST_PARENT}_2025_01`;
    await dropPartition(prisma, partition, { dryRun: true });
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::int AS count FROM pg_class WHERE relname = ${partition}
    `;
    expect(Number(rows[0].count)).toBe(1);
  });

  test('dropPartition: actual drop → tablo silinir', async () => {
    const prisma = getRawPrisma();
    const partition = `${TEST_PARENT}_2025_01`;
    await dropPartition(prisma, partition);
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::int AS count FROM pg_class WHERE relname = ${partition}
    `;
    expect(Number(rows[0].count)).toBe(0);
  });

  test('dropPartition: invalid identifier → throw (SQL injection guard)', async () => {
    const prisma = getRawPrisma();
    await expect(
      dropPartition(prisma, 'audit_logs"; DROP TABLE schedules;--'),
    ).rejects.toThrow(/invalid/i);
    await expect(
      dropPartition(prisma, 'AuditLogs_With_Caps'),
    ).rejects.toThrow(/invalid/i);
  });

  test('isTablePartitioned: invalid identifier → throw', async () => {
    const prisma = getRawPrisma();
    await expect(isTablePartitioned(prisma, 'foo; DROP DATABASE')).rejects.toThrow(/invalid/i);
  });
});
