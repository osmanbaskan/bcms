import type { PrismaClient } from '@prisma/client';
import { parseMonthlyPartitionName } from './audit-retention.helpers.js';

/**
 * Madde 1 PR-1D (audit doc): partition monitoring helpers.
 *
 * - Non-partitioned veya tablo bulunmayan durumlarda `null` döner (gauge
 *   collector -1 set eder; alert'ler "x >= 0 AND x < N" guard'ı ile non-prod
 *   ortamı skip).
 * - Identifier safety: parseMonthlyPartitionName + audit-retention.helpers
 *   pattern'i ile uyumlu.
 *
 * Bkz: ops/REQUIREMENTS-AUDITLOG-PARTITION-V1.md
 */

const TABLE_NAME_PATTERN = /^[a-z0-9_]+$/;

/**
 * `audit_logs_default` partition'ındaki satır sayısı.
 * Tablo yoksa (regular DB) `null`. Hata fırlatmaz; caller karar verir.
 */
export async function getDefaultPartitionRows(
  prisma: PrismaClient,
  defaultName = 'audit_logs_default',
): Promise<number | null> {
  if (!TABLE_NAME_PATTERN.test(defaultName)) return null;
  // Tablo varlığı kontrol — pg_class lookup (cheap).
  const exists = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM pg_class WHERE relname = ${defaultName}
  `;
  if (Number(exists[0]?.count ?? 0) === 0) return null;
  // Identifier validated; safe interpolation.
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count FROM "${defaultName}"`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Parent partitioned tablonun `audit_logs_YYYY_MM` pattern eşleşen monthly
 * child partition sayısı. Default + legacy + diğer naming hariç.
 * Non-partitioned parent → null.
 */
export async function getMonthlyPartitionCount(
  prisma: PrismaClient,
  parent = 'audit_logs',
): Promise<number | null> {
  if (!TABLE_NAME_PATTERN.test(parent)) return null;
  // Parent varsayılan olarak partitioned mı? relkind 'p' kontrol.
  const parentRow = await prisma.$queryRaw<{ relkind: string }[]>`
    SELECT relkind FROM pg_class WHERE relname = ${parent}
  `;
  if (parentRow.length === 0 || parentRow[0].relkind !== 'p') return null;

  const rows = await prisma.$queryRaw<{ partition_name: string }[]>`
    SELECT child.relname AS partition_name
    FROM pg_inherits
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    WHERE parent.relname = ${parent}
  `;
  let count = 0;
  for (const r of rows) {
    if (parseMonthlyPartitionName(r.partition_name, parent) !== null) count += 1;
  }
  return count;
}

/**
 * En eski monthly partition'ın `rangeStart` tarihinden bugüne yaş (gün).
 * Non-partitioned veya partition yok → null.
 *
 * Retention çalışıyor mu sinyali: değer büyürse drop yapılmıyor demektir
 * (informational; alert'i kullanıcı kararı ile yok).
 */
export async function getOldestMonthlyPartitionAgeDays(
  prisma: PrismaClient,
  parent = 'audit_logs',
  now: Date = new Date(),
): Promise<number | null> {
  if (!TABLE_NAME_PATTERN.test(parent)) return null;
  const parentRow = await prisma.$queryRaw<{ relkind: string }[]>`
    SELECT relkind FROM pg_class WHERE relname = ${parent}
  `;
  if (parentRow.length === 0 || parentRow[0].relkind !== 'p') return null;

  const rows = await prisma.$queryRaw<{ partition_name: string }[]>`
    SELECT child.relname AS partition_name
    FROM pg_inherits
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    WHERE parent.relname = ${parent}
  `;
  let oldestStart: Date | null = null;
  for (const r of rows) {
    const info = parseMonthlyPartitionName(r.partition_name, parent);
    if (!info) continue;
    if (oldestStart === null || info.rangeStart < oldestStart) {
      oldestStart = info.rangeStart;
    }
  }
  if (oldestStart === null) return null;
  const ageMs = now.getTime() - oldestStart.getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  return ageDays;
}
