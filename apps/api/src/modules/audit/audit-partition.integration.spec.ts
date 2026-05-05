import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ensureMonthlyPartition,
  formatMonthlyPartitionName,
  monthsAhead,
  partitionRangeBounds,
} from './audit-partition.helpers.js';
import { clearPartitionStatusCache } from './audit-retention.helpers.js';
import { cleanupTransactional, getRawPrisma } from '../../../test/integration/helpers.js';

/**
 * Madde 1 PR-1C regression spec — partition pre-create helpers.
 */

const TEST_PARENT = 'audit_partition_test';

describe('monthsAhead', () => {
  test('Mayıs 2026, 4 → [May, Jun, Jul, Aug] /2026', () => {
    const now = new Date(Date.UTC(2026, 4, 15)); // 2026-05-15
    expect(monthsAhead(now, 4)).toEqual([
      { year: 2026, month: 5 },
      { year: 2026, month: 6 },
      { year: 2026, month: 7 },
      { year: 2026, month: 8 },
    ]);
  });

  test('Aralık edge case → next year January wrap', () => {
    const now = new Date(Date.UTC(2026, 11, 15)); // 2026-12-15
    expect(monthsAhead(now, 4)).toEqual([
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
      { year: 2027, month: 2 },
      { year: 2027, month: 3 },
    ]);
  });

  test('count 0 → empty', () => {
    expect(monthsAhead(new Date(), 0)).toEqual([]);
  });

  test('count 1 → sadece current ay', () => {
    const now = new Date(Date.UTC(2026, 4, 1));
    expect(monthsAhead(now, 1)).toEqual([{ year: 2026, month: 5 }]);
  });
});

describe('formatMonthlyPartitionName', () => {
  test('valid: audit_logs + 2026 + 5 → audit_logs_2026_05', () => {
    expect(formatMonthlyPartitionName('audit_logs', 2026, 5)).toBe('audit_logs_2026_05');
  });

  test('two-digit padding', () => {
    expect(formatMonthlyPartitionName('audit_logs', 2026, 12)).toBe('audit_logs_2026_12');
    expect(formatMonthlyPartitionName('audit_logs', 2026, 1)).toBe('audit_logs_2026_01');
  });

  test('invalid prefix uppercase → throw', () => {
    expect(() => formatMonthlyPartitionName('Audit_Logs', 2026, 5)).toThrow(/invalid/i);
  });

  test('invalid prefix injection → throw', () => {
    expect(() => formatMonthlyPartitionName('foo; DROP', 2026, 5)).toThrow(/invalid/i);
  });

  test('year/month out of range → throw', () => {
    expect(() => formatMonthlyPartitionName('audit_logs', 1999, 5)).toThrow(/year/i);
    expect(() => formatMonthlyPartitionName('audit_logs', 2026, 0)).toThrow(/month/i);
    expect(() => formatMonthlyPartitionName('audit_logs', 2026, 13)).toThrow(/month/i);
  });
});

describe('partitionRangeBounds', () => {
  test('Mayıs 2026 → 2026-05-01..2026-06-01', () => {
    expect(partitionRangeBounds(2026, 5)).toEqual({ from: '2026-05-01', to: '2026-06-01' });
  });

  test('Aralık 2026 → 2026-12-01..2027-01-01', () => {
    expect(partitionRangeBounds(2026, 12)).toEqual({ from: '2026-12-01', to: '2027-01-01' });
  });

  test('Ocak (single-digit padding)', () => {
    expect(partitionRangeBounds(2027, 1)).toEqual({ from: '2027-01-01', to: '2027-02-01' });
  });
});

describe('ensureMonthlyPartition — DB integration', () => {
  beforeEach(async () => {
    await cleanupTransactional();
    clearPartitionStatusCache();
    const prisma = getRawPrisma();
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TEST_PARENT}" CASCADE`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${TEST_PARENT}" (
        id SERIAL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id, timestamp)
      ) PARTITION BY RANGE (timestamp)
    `);
  });

  afterEach(async () => {
    const prisma = getRawPrisma();
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TEST_PARENT}" CASCADE`);
    clearPartitionStatusCache();
  });

  test('ensureMonthlyPartition: yeni create → action=created', async () => {
    const prisma = getRawPrisma();
    const result = await ensureMonthlyPartition(prisma, TEST_PARENT, 2026, 6);
    expect(result).toEqual({ name: `${TEST_PARENT}_2026_06`, action: 'created' });
    const exists = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::int AS count FROM pg_class WHERE relname = ${`${TEST_PARENT}_2026_06`}
    `;
    expect(Number(exists[0].count)).toBe(1);
  });

  test('ensureMonthlyPartition: idempotent ikinci çağrı → action=existed', async () => {
    const prisma = getRawPrisma();
    await ensureMonthlyPartition(prisma, TEST_PARENT, 2026, 6);
    const second = await ensureMonthlyPartition(prisma, TEST_PARENT, 2026, 6);
    expect(second.action).toBe('existed');
  });

  test('ensureMonthlyPartition: dryRun=true → action=dry-run, tablo create edilmez', async () => {
    const prisma = getRawPrisma();
    const result = await ensureMonthlyPartition(prisma, TEST_PARENT, 2026, 6, { dryRun: true });
    expect(result.action).toBe('dry-run');
    const exists = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::int AS count FROM pg_class WHERE relname = ${`${TEST_PARENT}_2026_06`}
    `;
    expect(Number(exists[0].count)).toBe(0);
  });

  test('ensureMonthlyPartition: invalid parent → throw (identifier guard)', async () => {
    const prisma = getRawPrisma();
    await expect(
      ensureMonthlyPartition(prisma, 'foo; DROP TABLE', 2026, 6),
    ).rejects.toThrow(/invalid/i);
  });

  test('ensureMonthlyPartition: range bounds doğru routing', async () => {
    const prisma = getRawPrisma();
    await ensureMonthlyPartition(prisma, TEST_PARENT, 2026, 7);
    // 2026-07 partition'a Temmuz ortasındaki insert düşmeli
    await prisma.$executeRawUnsafe(`
      INSERT INTO "${TEST_PARENT}" (timestamp) VALUES ('2026-07-15T10:00:00Z')
    `);
    // Note: $queryRaw template literal Prisma'yı parametreleştirir; identifier
    // interpolasyonu için $queryRawUnsafe gerek.
    const rows = await prisma.$queryRawUnsafe<{ landed_in: string }[]>(
      `SELECT tableoid::regclass::text AS landed_in FROM "${TEST_PARENT}" WHERE timestamp = '2026-07-15T10:00:00Z'`,
    );
    expect(rows[0].landed_in).toBe(`${TEST_PARENT}_2026_07`);
  });

  test('ensureMonthlyPartition: parent partitioned değil → SQL-level error', async () => {
    const prisma = getRawPrisma();
    // Regular (non-partitioned) parent
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TEST_PARENT}_regular" CASCADE`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${TEST_PARENT}_regular" (id SERIAL PRIMARY KEY, timestamp TIMESTAMPTZ)
    `);
    try {
      await expect(
        ensureMonthlyPartition(prisma, `${TEST_PARENT}_regular`, 2026, 6),
      ).rejects.toThrow(); // PG error, helper opaque pass-through
    } finally {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TEST_PARENT}_regular" CASCADE`);
    }
  });
});
