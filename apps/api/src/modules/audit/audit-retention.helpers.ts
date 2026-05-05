import type { PrismaClient } from '@prisma/client';

/**
 * Madde 1 PR-1B (audit doc): retention feature-detect helpers.
 *
 * Tasarım kararları (kullanıcı revizyonu 2026-05-05):
 * - relpartbound string parse YAPMA (kırılgan; PG version drift riski).
 *   Naming convention'dan YYYY_MM çıkar, end boundary uygulama tarafında hesapla.
 * - Identifier güvenliği: TABLE_NAME_PATTERN guard (^[a-z0-9_]+$).
 * - isTablePartitioned cache + injectable test override (clearPartitionStatusCache).
 * - DROP TABLE quote'lu identifier; user input olmasa da defansif.
 *
 * Bkz: ops/REQUIREMENTS-AUDITLOG-PARTITION-V1.md
 */

const TABLE_NAME_PATTERN = /^[a-z0-9_]+$/;

export interface PartitionInfo {
  name: string;
  rangeStart: Date;  // inclusive (UTC, ay başlangıcı)
  rangeEnd: Date;    // exclusive (UTC, sonraki ay başlangıcı)
}

/**
 * `audit_logs_YYYY_MM` formatındaki partition adından zaman aralığı çıkarır.
 * Default partition (`audit_logs_default`), legacy table (`audit_logs_legacy`),
 * non-monthly pattern → null (atlanır).
 */
export function parseMonthlyPartitionName(
  partitionName: string,
  tablePrefix = 'audit_logs',
): PartitionInfo | null {
  if (!TABLE_NAME_PATTERN.test(tablePrefix)) return null;
  const re = new RegExp(`^${tablePrefix}_(\\d{4})_(\\d{2})$`);
  const m = partitionName.match(re);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  if (year < 2000 || year > 2100) return null; // sanity
  const rangeStart = new Date(Date.UTC(year, month - 1, 1));
  const rangeEnd   = new Date(Date.UTC(year, month, 1));
  return { name: partitionName, rangeStart, rangeEnd };
}

/**
 * Tablonun PG seviyesinde partitioned olup olmadığını kontrol eder.
 * `pg_class.relkind = 'p'` → partitioned table.
 *
 * Cache'li (module-level Map). Test'lerde `clearPartitionStatusCache()` ile sıfırlanır.
 * App boot'tan sonra schema değişmez (production'da migration ile değişir, container restart sonrası cache tazedir).
 */
const partitionStatusCache = new Map<string, boolean>();

export function clearPartitionStatusCache(): void {
  partitionStatusCache.clear();
}

export async function isTablePartitioned(
  prisma: PrismaClient,
  tableName = 'audit_logs',
): Promise<boolean> {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  const cached = partitionStatusCache.get(tableName);
  if (cached !== undefined) return cached;

  const rows = await prisma.$queryRaw<{ relkind: string }[]>`
    SELECT relkind FROM pg_class WHERE relname = ${tableName}
  `;
  const partitioned = rows.length > 0 && rows[0].relkind === 'p';
  partitionStatusCache.set(tableName, partitioned);
  return partitioned;
}

/**
 * Parent partitioned tablo'nun child partition'larını listeler ve naming convention
 * (`<prefix>_YYYY_MM`) eşleşenlerden range_end ≤ cutoff olanları döndürür.
 *
 * Default partition + legacy + pattern-dışı isimler **atlanır** (parseMonthlyPartitionName null).
 */
export async function findExpiredPartitions(
  prisma: PrismaClient,
  cutoff: Date,
  parentTable = 'audit_logs',
): Promise<PartitionInfo[]> {
  if (!TABLE_NAME_PATTERN.test(parentTable)) {
    throw new Error(`Invalid table name: ${parentTable}`);
  }
  const rows = await prisma.$queryRaw<{ partition_name: string }[]>`
    SELECT child.relname AS partition_name
    FROM pg_inherits
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    WHERE parent.relname = ${parentTable}
  `;
  const expired: PartitionInfo[] = [];
  for (const r of rows) {
    const info = parseMonthlyPartitionName(r.partition_name, parentTable);
    if (!info) continue;
    if (info.rangeEnd.getTime() <= cutoff.getTime()) {
      expired.push(info);
    }
  }
  // Eski tarihten yeni tarihe sıralı; deterministic drop order.
  expired.sort((a, b) => a.rangeEnd.getTime() - b.rangeEnd.getTime());
  return expired;
}

/**
 * Tek partition DROP TABLE. Identifier `^[a-z0-9_]+$` guard'ı ile koruma altında;
 * caller findExpiredPartitions'tan zaten validated PartitionInfo.name geçirir.
 */
export async function dropPartition(
  prisma: PrismaClient,
  partitionName: string,
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  if (!TABLE_NAME_PATTERN.test(partitionName)) {
    throw new Error(`Invalid partition name: ${partitionName}`);
  }
  if (opts.dryRun) {
    return; // caller log'u tutar; side-effect yok
  }
  // Identifier double-quote: PG identifier syntax.
  await prisma.$executeRawUnsafe(`DROP TABLE "${partitionName}"`);
}
