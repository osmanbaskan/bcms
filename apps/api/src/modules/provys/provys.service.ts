import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { parseBxf, type ParsedItem } from './provys.parser.js';
import { resolveChannelFromPath, extractFileCode } from './provys.channel-mapping.js';
import type { ProvysChannelSlug } from '@bcms/shared';

/** Worker bağlamında audit ext'in entityType olarak gördüğü model adı. */
export const PROVYS_AUDIT_ENTITY = 'ProvysItem';

/** pg_notify kanal adı (DB-side notification channel). */
export const PG_NOTIFY_CHANNEL = 'provys_changed';

export interface ProvysSyncResult {
  channelSlug: ProvysChannelSlug | null;
  reason?: 'unknown-channel' | 'parse-empty' | 'unchanged' | 'applied';
  inserted: number;
  updated: number;
  deleted: number;
  /** Bu sync'te etkilenen kanal+gün çiftleri (SSE notify scope). */
  affectedDates: string[];
}

interface DiffPlan {
  toCreate: Prisma.ProvysItemCreateManyInput[];
  toUpdate: Array<{ id: number; data: Prisma.ProvysItemUpdateInput }>;
  toDeleteIds: number[];
}

function computeHash(item: Pick<ParsedItem, 'eventId' | 'startAt' | 'durationMs' | 'title' | 'rawKind' | 'category' | 'sequence' | 'startTimecode' | 'durationTimecode' | 'frameRate' | 'dcCode' | 'scheduleDate'>): string {
  const canonical = [
    item.eventId,
    item.scheduleDate,
    item.startAt.toISOString(),
    item.durationMs ?? '',
    item.startTimecode ?? '',
    item.durationTimecode ?? '',
    item.frameRate ?? '',
    item.dcCode ?? '',
    item.title,
    item.rawKind ?? '',
    item.category,
    item.sequence,
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Pure diff — `(channelSlug, scheduleDate)` scope. `existing` listesi
 * yalnız bu kanal+gün satırlarını içermeli; başka günler caller tarafından
 * filtrelenir.
 */
/**
 * Diff scope `(channelSlug, scheduleDate)` ama DELETE filtresi `sourceFile`
 * eşitliğiyle kısıtlı. Bir gün'ün event'leri **birden çok dosyadan** gelmiş
 * olabilir (örn. xSNW_20260521.bxf gece yarısı sonrası event'leri 22 Mayıs
 * snapshot'ına katkı yapar). Bu durumda current dosya parse edilirken
 * **başka dosyadan** gelmiş kayıtları DELETE etmeyiz; sadece current dosyaya
 * ait olup artık parsed listede olmayanları sileriz. INSERT/UPDATE upsert
 * mantığıyla: aynı (channelSlug, scheduleDate, eventId) DB'de varsa
 * (kaynak dosya ne olursa olsun) UPDATE; yoksa INSERT.
 */
function buildDiff(
  channelSlug: ProvysChannelSlug,
  scheduleDate: string,
  sourceFile: string,
  sourceMtime: Date,
  parsed: ParsedItem[],
  existing: Array<{ id: number; eventId: string; payloadHash: string; sourceFile: string }>,
): DiffPlan {
  const existingByEventId = new Map(existing.map((r) => [r.eventId, r]));
  const parsedByEventId = new Map(parsed.map((p) => [p.eventId, p]));

  const toCreate: Prisma.ProvysItemCreateManyInput[] = [];
  const toUpdate: Array<{ id: number; data: Prisma.ProvysItemUpdateInput }> = [];
  const toDeleteIds: number[] = [];

  const scheduleDateAsDb = new Date(`${scheduleDate}T00:00:00Z`);

  for (const p of parsed) {
    const hash = computeHash(p);
    const existingRow = existingByEventId.get(p.eventId);
    if (!existingRow) {
      toCreate.push({
        channelSlug,
        scheduleDate: scheduleDateAsDb,
        eventId: p.eventId,
        sequence: p.sequence,
        startAt: p.startAt,
        durationMs: p.durationMs,
        startTimecode: p.startTimecode,
        durationTimecode: p.durationTimecode,
        frameRate: p.frameRate,
        dcCode: p.dcCode,
        title: p.title,
        rawKind: p.rawKind,
        category: p.category,
        sourceFile,
        sourceMtime,
        payloadHash: hash,
      });
    } else if (existingRow.payloadHash !== hash || existingRow.sourceFile !== sourceFile) {
      // Hash farkı veya kaynak dosya farkı → güncelle. sourceFile/sourceMtime
      // yeni dosyaya yazılır; aynı eventId tekrar farklı dosyada görülürse
      // son işlenen kazanır (upsert davranışı).
      toUpdate.push({
        id: existingRow.id,
        data: {
          sequence: p.sequence,
          startAt: p.startAt,
          durationMs: p.durationMs,
          startTimecode: p.startTimecode,
          durationTimecode: p.durationTimecode,
          frameRate: p.frameRate,
          dcCode: p.dcCode,
          title: p.title,
          rawKind: p.rawKind,
          category: p.category,
          sourceFile,
          sourceMtime,
          payloadHash: hash,
        },
      });
    }
  }

  // DELETE sadece current dosyaya ait orphan'lar için — diğer dosyadan gelen
  // satırlar dokunulmaz.
  for (const e of existing) {
    if (!parsedByEventId.has(e.eventId) && e.sourceFile === sourceFile) {
      toDeleteIds.push(e.id);
    }
  }

  return { toCreate, toUpdate, toDeleteIds };
}

/**
 * Parsed items'ı scheduleDate'lere gruplandırır. Pratikte tek dosya tek
 * gündür (Provys exporter sözleşmesi); yine de gece yarısı sonrası event'i
 * farklı broadcastDate'e düşerse generic destek için.
 */
function groupByScheduleDate(items: ParsedItem[]): Map<string, ParsedItem[]> {
  const map = new Map<string, ParsedItem[]>();
  for (const p of items) {
    const arr = map.get(p.scheduleDate) ?? [];
    arr.push(p);
    map.set(p.scheduleDate, arr);
  }
  return map;
}

async function emitNotify(prisma: PrismaClient, logger: FastifyBaseLogger, channelSlug: string, scheduleDate: string): Promise<void> {
  try {
    const payload = JSON.stringify({ channelSlug, scheduleDate });
    await prisma.$executeRaw`SELECT pg_notify(${PG_NOTIFY_CHANNEL}, ${payload})`;
  } catch (err) {
    logger.warn({ err, channelSlug, scheduleDate }, 'Provys: pg_notify başarısız');
  }
}

/**
 * Dosyayı parse eder, kanalı çözer, `(channelSlug, scheduleDate)` scope'unda
 * snapshot diff'ler. Bir dosya birden çok scheduleDate'e parsed item üretirse
 * her grup ayrı tx'te işlenir.
 *
 * Audit: tüm yazımlar Prisma audit extension üstünden geçer (bypass yok).
 */
export async function syncProvysFile(
  prisma: PrismaClient,
  filePath: string,
  logger: FastifyBaseLogger,
): Promise<ProvysSyncResult> {
  const channelSlug = resolveChannelFromPath(filePath);
  if (!channelSlug) {
    logger.warn(
      { filePath, fileCode: extractFileCode(filePath) },
      'Provys: bilinmeyen file code, import edilmedi',
    );
    return { channelSlug: null, reason: 'unknown-channel', inserted: 0, updated: 0, deleted: 0, affectedDates: [] };
  }

  let content: string;
  let stat: { mtime: Date };
  try {
    [content, stat] = await Promise.all([
      fs.readFile(filePath, 'utf-8'),
      fs.stat(filePath),
    ]);
  } catch (err) {
    logger.error({ err, filePath }, 'Provys: dosya okunamadı');
    throw err;
  }

  const parsed = parseBxf(content);
  if (parsed.length === 0) {
    logger.info({ filePath, channelSlug }, 'Provys: parse boş, sync atlandı');
    return { channelSlug, reason: 'parse-empty', inserted: 0, updated: 0, deleted: 0, affectedDates: [] };
  }

  const groups = groupByScheduleDate(parsed);
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;
  const affectedDates: string[] = [];

  for (const [scheduleDate, items] of groups) {
    const scheduleDateAsDb = new Date(`${scheduleDate}T00:00:00Z`);
    const existing = await prisma.provysItem.findMany({
      where: { channelSlug, scheduleDate: scheduleDateAsDb },
      select: { id: true, eventId: true, payloadHash: true, sourceFile: true },
    });

    const diff = buildDiff(channelSlug, scheduleDate, filePath, stat.mtime, items, existing);
    const changeCount = diff.toCreate.length + diff.toUpdate.length + diff.toDeleteIds.length;
    if (changeCount === 0) continue;

    // Büyük gün snapshot'ları (~300 satır) tek tx'te bireysel `update` çağrıları
    // default 5000ms timeout'u aşabilir. 30sn yeterli marj; debounce'lu sync
    // sırasında connection pool basıncı düşük.
    await prisma.$transaction(
      async (tx) => {
        if (diff.toDeleteIds.length > 0) {
          await tx.provysItem.deleteMany({ where: { id: { in: diff.toDeleteIds } } });
        }
        if (diff.toCreate.length > 0) {
          await tx.provysItem.createMany({ data: diff.toCreate });
        }
        for (const u of diff.toUpdate) {
          await tx.provysItem.update({ where: { id: u.id }, data: u.data });
        }
      },
      { timeout: 30_000, maxWait: 5_000 },
    );

    await emitNotify(prisma, logger, channelSlug, scheduleDate);

    totalInserted += diff.toCreate.length;
    totalUpdated += diff.toUpdate.length;
    totalDeleted += diff.toDeleteIds.length;
    affectedDates.push(scheduleDate);

    logger.info(
      {
        channelSlug,
        scheduleDate,
        inserted: diff.toCreate.length,
        updated: diff.toUpdate.length,
        deleted: diff.toDeleteIds.length,
        sourceFile: filePath,
      },
      'Provys: kanal/gün senkronize edildi',
    );
  }

  if (affectedDates.length === 0) {
    return { channelSlug, reason: 'unchanged', inserted: 0, updated: 0, deleted: 0, affectedDates: [] };
  }
  return {
    channelSlug,
    reason: 'applied',
    inserted: totalInserted,
    updated: totalUpdated,
    deleted: totalDeleted,
    affectedDates,
  };
}

/**
 * `(channelSlug, scheduleDate)` snapshot'ını siler ve pg_notify yayar.
 * Dizinde o kanal+gün için BXF kalmadığında watcher çağırır. Audit ext
 * devrede (deleteMany → DELETE audit kaydı). Diğer günlere DOKUNULMAZ.
 */
export async function clearChannelDateSnapshot(
  prisma: PrismaClient,
  channelSlug: string,
  scheduleDate: string,
  logger: FastifyBaseLogger,
): Promise<{ deleted: number }> {
  const scheduleDateAsDb = new Date(`${scheduleDate}T00:00:00Z`);
  const result = await prisma.provysItem.deleteMany({
    where: { channelSlug, scheduleDate: scheduleDateAsDb },
  });
  if (result.count > 0) {
    await emitNotify(prisma, logger, channelSlug, scheduleDate);
    logger.info(
      { channelSlug, scheduleDate, deleted: result.count },
      'Provys: kanal/gün snapshot temizlendi',
    );
  }
  return { deleted: result.count };
}

/** Pure diff — test edilebilir. */
export const __internals__ = { buildDiff, computeHash, groupByScheduleDate };
