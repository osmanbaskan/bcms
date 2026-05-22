import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { parseBxf, type ParsedItem } from './provys.parser.js';
import {
  extractFileCode,
  resolveChannelFromPath,
} from './provys.channel-mapping.js';
import { listBxfFiles, extractScheduleDate } from './provys.file-resolver.js';
import { composeFinalSnapshot, type SnapshotRow, type SnapshotSource } from './provys.snapshot.js';
import type { ProvysChannelSlug } from '@bcms/shared';

/** Worker bağlamında audit ext'in entityType olarak gördüğü model adı. */
export const PROVYS_AUDIT_ENTITY = 'ProvysItem';

/** pg_notify kanal adı (DB-side notification channel). */
export const PG_NOTIFY_CHANNEL = 'provys_changed';

export interface ProvysSyncResult {
  channelSlug: ProvysChannelSlug | null;
  reason?: 'unknown-channel' | 'parse-empty' | 'unchanged' | 'applied' | 'empty-cleared';
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

function computeHash(
  item: Pick<
    ParsedItem,
    | 'eventId'
    | 'startAt'
    | 'durationMs'
    | 'title'
    | 'rawKind'
    | 'category'
    | 'sequence'
    | 'startTimecode'
    | 'durationTimecode'
    | 'frameRate'
    | 'dcCode'
    | 'scheduleDate'
  >,
): string {
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
 * Composed-final-snapshot scoped diff. Caller önce `composeFinalSnapshot`
 * ile (channelSlug, scheduleDate) için latest-wins merged listeyi hazırlar;
 * `buildDiff` o final listeyi DB'deki mevcut satırlarla karşılaştırır.
 *
 * - composed'da olup DB'de olmayan eventId → INSERT.
 * - composed'da olup DB'de varsa: payloadHash veya sourceFile farkı → UPDATE
 *   (sourceFile takeover composed merge sonucunda doğal davranış).
 * - DB'de olup composed'da olmayan eventId → DELETE. Bu, eski revision'ın
 *   yeni revision pencere'sine düşen event'lerini kaldıran adımdır.
 *
 * Sequence DB'de saklanmaya devam eder (parser file-scope sequence verir);
 * yalnız API ana sıralaması artık `startAt` üzerinden yapılır.
 */
export function buildDiff(
  channelSlug: ProvysChannelSlug,
  scheduleDate: string,
  composed: ReadonlyArray<SnapshotRow>,
  existing: ReadonlyArray<{ id: number; eventId: string; payloadHash: string; sourceFile: string }>,
): DiffPlan {
  const existingByEventId = new Map(existing.map((r) => [r.eventId, r]));
  const composedEventIds = new Set(composed.map((c) => c.item.eventId));

  const toCreate: Prisma.ProvysItemCreateManyInput[] = [];
  const toUpdate: Array<{ id: number; data: Prisma.ProvysItemUpdateInput }> = [];
  const toDeleteIds: number[] = [];

  const scheduleDateAsDb = new Date(`${scheduleDate}T00:00:00Z`);

  for (const row of composed) {
    const { item: p, sourceFile, sourceMtime } = row;
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

  for (const e of existing) {
    if (!composedEventIds.has(e.eventId)) {
      toDeleteIds.push(e.id);
    }
  }

  return { toCreate, toUpdate, toDeleteIds };
}

async function emitNotify(
  prisma: PrismaClient,
  logger: FastifyBaseLogger,
  channelSlug: string,
  scheduleDate: string,
): Promise<void> {
  try {
    const payload = JSON.stringify({ channelSlug, scheduleDate });
    await prisma.$executeRaw`SELECT pg_notify(${PG_NOTIFY_CHANNEL}, ${payload})`;
  } catch (err) {
    logger.warn({ err, channelSlug, scheduleDate }, 'Provys: pg_notify başarısız');
  }
}

/**
 * Aday BXF dosyalarını belirler — bir (channel, scheduleDate) için
 * compose etmesi gereken kaynak listesi.
 *
 * Provys exporter dosya adındaki `YYYYMMDD` yayın gününü belirtir; ancak
 * önceki gün dosyası gece yarısı sonrası event'leri ile bir sonraki güne
 * de katkı yapabilir (parser per-event `broadcastDate` ile o günü yazar).
 * Bu yüzden hedef günün dosyaları + bir önceki günün dosyaları aday
 * setidir. Daha geri tarihler genel olarak hedef güne katkı yapamaz
 * (broadcast day +1'den fazla taşmaz).
 */
function selectCandidateFiles(
  files: ReadonlyArray<{ path: string; fileCode: string; scheduleDate: string; mtime: Date }>,
  fileCode: string,
  targetDate: string,
): Array<{ path: string; mtime: Date }> {
  const normalized = fileCode.trim().toLowerCase();
  const prev = previousIsoDate(targetDate);
  const accepted = new Set([targetDate, prev]);
  return files
    .filter((f) => f.fileCode === normalized && accepted.has(f.scheduleDate))
    .map((f) => ({ path: f.path, mtime: f.mtime }));
}

function previousIsoDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Adı verilen kanal + gün için final composed snapshot'ı hesaplar, DB'ye
 * uygular ve pg_notify yayar. `watchDir` watcher'ın izlediği dizin (mount).
 *
 * Aday dosyalar parse edilir, `composeFinalSnapshot` ile latest-wins merge
 * çalıştırılır, sonuç DB'deki mevcut satırlarla diff'lenir.
 *
 * - Aday yok / parse boş / composed boş → o gün snapshot temizlenir.
 * - Aksi halde diff applied + notify.
 *
 * Aynı dosya birden çok scheduleDate'e katkı yapıyorsa caller her hedef
 * gün için ayrı çağırır (watcher böyle yapıyor).
 */
export async function syncChannelDate(
  prisma: PrismaClient,
  channelSlug: ProvysChannelSlug,
  scheduleDate: string,
  watchDir: string,
  logger: FastifyBaseLogger,
): Promise<ProvysSyncResult> {
  const fileCode = await fileCodeForSlug(channelSlug);
  if (!fileCode) {
    logger.warn({ channelSlug }, 'Provys: slug için fileCode çözülemedi');
    return { channelSlug, reason: 'unknown-channel', inserted: 0, updated: 0, deleted: 0, affectedDates: [] };
  }
  const allFiles = await listBxfFiles(watchDir);

  const candidates = selectCandidateFiles(allFiles, fileCode, scheduleDate);
  const sources: SnapshotSource[] = [];
  for (const c of candidates) {
    let content: string;
    try {
      content = await fs.readFile(c.path, 'utf-8');
    } catch (err) {
      logger.warn({ err, path: c.path }, 'Provys: aday dosya okunamadı, atlanıyor');
      continue;
    }
    let parsed: ParsedItem[];
    try {
      parsed = parseBxf(content);
    } catch (err) {
      logger.warn({ err, path: c.path }, 'Provys: aday dosya parse hatası, atlanıyor');
      continue;
    }
    if (parsed.length === 0) continue;
    sources.push({ sourceFile: c.path, sourceMtime: c.mtime, items: parsed });
  }

  const composed = composeFinalSnapshot(sources, scheduleDate);
  const scheduleDateAsDb = new Date(`${scheduleDate}T00:00:00Z`);
  const existing = await prisma.provysItem.findMany({
    where: { channelSlug, scheduleDate: scheduleDateAsDb },
    select: { id: true, eventId: true, payloadHash: true, sourceFile: true },
  });

  if (composed.length === 0) {
    // Hiç kaynak yok ya da hiçbir parsed event hedef güne düşmüyor.
    if (existing.length === 0) {
      return { channelSlug, reason: 'unchanged', inserted: 0, updated: 0, deleted: 0, affectedDates: [] };
    }
    const cleared = await clearChannelDateSnapshot(prisma, channelSlug, scheduleDate, logger);
    return {
      channelSlug,
      reason: 'empty-cleared',
      inserted: 0,
      updated: 0,
      deleted: cleared.deleted,
      affectedDates: [scheduleDate],
    };
  }

  const diff = buildDiff(channelSlug, scheduleDate, composed, existing);
  const changeCount = diff.toCreate.length + diff.toUpdate.length + diff.toDeleteIds.length;
  if (changeCount === 0) {
    return { channelSlug, reason: 'unchanged', inserted: 0, updated: 0, deleted: 0, affectedDates: [] };
  }

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

  logger.info(
    {
      channelSlug,
      scheduleDate,
      inserted: diff.toCreate.length,
      updated: diff.toUpdate.length,
      deleted: diff.toDeleteIds.length,
      sources: sources.length,
    },
    'Provys: kanal/gün senkronize edildi (composed)',
  );

  return {
    channelSlug,
    reason: 'applied',
    inserted: diff.toCreate.length,
    updated: diff.toUpdate.length,
    deleted: diff.toDeleteIds.length,
    affectedDates: [scheduleDate],
  };
}

/**
 * Slug → fileCode dynamic lookup (shared `PROVYS_CHANNELS` katalogu).
 * Tek bir import path üzerinden tutarlı; channel-mapping.ts dosyada zaten
 * `resolveChannel(fileCode)` veriyor.
 */
async function fileCodeForSlug(slug: ProvysChannelSlug): Promise<string | null> {
  const { PROVYS_CHANNELS } = await import('@bcms/shared');
  const c = PROVYS_CHANNELS.find((x) => x.slug === slug);
  return c?.fileCode ?? null;
}

/**
 * Eski API — file-scoped tek dosya sync. Composed-snapshot mantığına
 * yönlendiren ince wrapper: filePath'ten kanalı + dosya scheduleDate'ini
 * çıkarır, etkilenebilecek günler için (filename day + bir sonraki gün)
 * `syncChannelDate` çağırır. Watcher artık doğrudan `syncChannelDate`
 * kullanıyor; bu wrapper yalnız legacy çağrılar için tutuluyor.
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
  const filenameDate = extractScheduleDate(filePath);
  if (!filenameDate) {
    logger.warn({ filePath }, 'Provys: dosya adından tarih çıkartılamadı');
    return { channelSlug, reason: 'parse-empty', inserted: 0, updated: 0, deleted: 0, affectedDates: [] };
  }
  const watchDir = path.dirname(filePath);
  const nextDate = nextIsoDate(filenameDate);

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;
  const affected: string[] = [];
  for (const d of [filenameDate, nextDate]) {
    const r = await syncChannelDate(prisma, channelSlug, d, watchDir, logger);
    totalInserted += r.inserted;
    totalUpdated += r.updated;
    totalDeleted += r.deleted;
    if (r.reason === 'applied' || r.reason === 'empty-cleared') affected.push(d);
  }
  return {
    channelSlug,
    reason: affected.length > 0 ? 'applied' : 'unchanged',
    inserted: totalInserted,
    updated: totalUpdated,
    deleted: totalDeleted,
    affectedDates: affected,
  };
}

function nextIsoDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * `(channelSlug, scheduleDate)` snapshot'ını siler ve pg_notify yayar.
 * `syncChannelDate` aday/composed boş olduğunda otomatik çağırır; ayrıca
 * watcher unlink event'inde hiç aday kalmadığında kullanılır.
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

/** Pure helpers — test edilebilir. */
export const __internals__ = {
  buildDiff,
  computeHash,
  selectCandidateFiles,
  previousIsoDate,
  nextIsoDate,
};
