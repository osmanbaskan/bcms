import type { PrismaClient } from '@prisma/client';

/**
 * Madde 1 PR-1C (audit doc): partition pre-create helpers.
 *
 * Tasarım kararları (kullanıcı revizyonu 2026-05-05):
 * - Pre-create window: current + 3 ileri ay = 4 partition (monthsAhead(now, 4)).
 *   Current idempotent; yoksa default partition'a düşmeyi engeller.
 * - Identifier guard: TABLE_NAME_PATTERN (^[a-z0-9_]+$).
 * - Helper SQL-level net hata verebilir (parent partitioned değilse PG fail);
 *   job seviyesinde isTablePartitioned ile pre-check yapılır.
 *
 * Bkz: ops/REQUIREMENTS-AUDITLOG-PARTITION-V1.md, ops/RUNBOOK-AUDITLOG-PARTITION-DEPLOY.md §6
 */

const TABLE_NAME_PATTERN = /^[a-z0-9_]+$/;

export interface MonthRef {
  year: number;
  month: number; // 1-12
}

/**
 * `now` dahil ileri `count` ay; UTC bazlı. Aralık → sonraki yılın Ocak'ı vb.
 *
 * Örnek: monthsAhead(2026-05-15, 4) → [May/2026, Jun/2026, Jul/2026, Aug/2026]
 *        monthsAhead(2026-12-15, 4) → [Dec/2026, Jan/2027, Feb/2027, Mar/2027]
 */
export function monthsAhead(now: Date, count: number): MonthRef[] {
  if (count < 1) return [];
  const startYear = now.getUTCFullYear();
  const startMonth0 = now.getUTCMonth(); // 0-11
  const out: MonthRef[] = [];
  for (let i = 0; i < count; i++) {
    const m0 = startMonth0 + i;
    const yearOffset = Math.floor(m0 / 12);
    const monthIdx = m0 % 12;
    out.push({ year: startYear + yearOffset, month: monthIdx + 1 });
  }
  return out;
}

/**
 * `<prefix>_YYYY_MM` partition adı. Identifier guard'a uygundur (lowercase
 * digits underscore).
 */
export function formatMonthlyPartitionName(prefix: string, year: number, month: number): string {
  if (!TABLE_NAME_PATTERN.test(prefix)) {
    throw new Error(`Invalid partition prefix: ${prefix}`);
  }
  if (year < 2000 || year > 2100) throw new Error(`Year out of range: ${year}`);
  if (month < 1 || month > 12) throw new Error(`Month out of range: ${month}`);
  const mm = String(month).padStart(2, '0');
  return `${prefix}_${year}_${mm}`;
}

/**
 * Partition range bound'ları SQL-uyumlu string olarak döner.
 * Aralık → sonraki yılın Ocak'ı edge case handled.
 */
export function partitionRangeBounds(year: number, month: number): { from: string; to: string } {
  if (year < 2000 || year > 2100) throw new Error(`Year out of range: ${year}`);
  if (month < 1 || month > 12) throw new Error(`Month out of range: ${month}`);
  const fromMM = String(month).padStart(2, '0');
  const from = `${year}-${fromMM}-01`;
  const toYear = month === 12 ? year + 1 : year;
  const toMonth = month === 12 ? 1 : month + 1;
  const toMM = String(toMonth).padStart(2, '0');
  const to = `${toYear}-${toMM}-01`;
  return { from, to };
}

export interface EnsurePartitionResult {
  name: string;
  action: 'created' | 'existed' | 'dry-run';
}

/**
 * Idempotent partition create: `CREATE TABLE IF NOT EXISTS`.
 *
 * Parent table partitioned değilse PG hata verir (relation already exists or
 * "must be a partitioned table" — job seviyesinde isTablePartitioned önceden
 * filter eder). Helper bu durumda PG error'u throw eder; caller log'lar.
 *
 * dryRun=true → SQL execute edilmez, sadece beklenen davranış sonucu döner.
 */
export async function ensureMonthlyPartition(
  prisma: PrismaClient,
  parent: string,
  year: number,
  month: number,
  opts: { dryRun?: boolean } = {},
): Promise<EnsurePartitionResult> {
  if (!TABLE_NAME_PATTERN.test(parent)) {
    throw new Error(`Invalid parent table name: ${parent}`);
  }
  const name = formatMonthlyPartitionName(parent, year, month);
  if (opts.dryRun) {
    return { name, action: 'dry-run' };
  }

  const { from, to } = partitionRangeBounds(year, month);
  // Identifier'lar TABLE_NAME_PATTERN ile doğrulandı; FROM/TO string literal
  // (date format) — PG parse eder; injection riski yok ama defansif: only digits + dashes.
  // CREATE TABLE IF NOT EXISTS partition idempotent.
  const existedBefore = await partitionExists(prisma, name);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${name}"
    PARTITION OF "${parent}"
    FOR VALUES FROM ('${from}') TO ('${to}')
  `);
  return { name, action: existedBefore ? 'existed' : 'created' };
}

async function partitionExists(prisma: PrismaClient, name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM pg_class WHERE relname = ${name}
  `;
  return Number(rows[0]?.count ?? 0) > 0;
}
