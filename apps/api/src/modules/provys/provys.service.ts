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
import { requestSsdbResolverTick } from '../ssdb/ssdb-resolver.worker.js';
import type { ProvysChannelSlug } from '@bcms/shared';

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
    | 'versionName'
    | 'episodeName'
    | 'eventTitle'
    | 'contentName'
    | 'programName'
    | 'adType'
    | 'spotType'
    | 'titleSource'
    | 'seriesName'
    | 'episodeNumber'
  >,
): string {
  // 2026-05-26: Ham title kaynak alanları hash'e dahil — bu alanlar değişirse
  // payloadHash mismatch tetiklenir → update path çalışır, watcher değişimi
  // ignore etmez. Sıra korunmalı (eski + yeni alanlar; rebuild sırasında
  // existing rows için hash mismatch beklenir → 1x update tetiklenir, sonra
  // stabilize olur).
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
    item.versionName ?? '',
    item.episodeName ?? '',
    item.eventTitle ?? '',
    item.contentName ?? '',
    item.programName ?? '',
    item.adType ?? '',
    item.spotType ?? '',
    item.titleSource,
    item.seriesName ?? '',
    item.episodeNumber ?? '',
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
        versionName: p.versionName,
        episodeName: p.episodeName,
        eventTitle: p.eventTitle,
        contentName: p.contentName,
        programName: p.programName,
        adType: p.adType,
        spotType: p.spotType,
        titleSource: p.titleSource,
        seriesName: p.seriesName,
        episodeNumber: p.episodeNumber,
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
          versionName: p.versionName,
          episodeName: p.episodeName,
          eventTitle: p.eventTitle,
          contentName: p.contentName,
          programName: p.programName,
          adType: p.adType,
          spotType: p.spotType,
          titleSource: p.titleSource,
          seriesName: p.seriesName,
          episodeNumber: p.episodeNumber,
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

// 2026-05-26: SSDB resolver worker (`apps/api/src/modules/ssdb/ssdb-resolver.worker.ts`)
// cache update sonrasi etkilenen (channel, date) ciftleri icin `provys_changed`
// kanalini reuse eder; mevcut SSE listener UI'yi otomatik refresh eder.
// Bu fonksiyon Provys-tarafi pg_notify icin canonical primitive — duplicate
// implementation yerine ortak kullanim icin export.
export async function emitNotify(
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
  fileCodeOrCodes: string | ReadonlyArray<string>,
  targetDate: string,
): Array<{ path: string; mtime: Date }> {
  const rawCodes = Array.isArray(fileCodeOrCodes) ? fileCodeOrCodes : [fileCodeOrCodes as string];
  const acceptedCodes = new Set(rawCodes.map((c) => c.trim().toLowerCase()).filter((c) => c.length > 0));
  if (acceptedCodes.size === 0) return [];
  const prev = previousIsoDate(targetDate);
  const acceptedDates = new Set([targetDate, prev]);
  return files
    .filter((f) => acceptedCodes.has(f.fileCode) && acceptedDates.has(f.scheduleDate))
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
  const fileCodes = await fileCodesForSlug(channelSlug);
  if (fileCodes.length === 0) {
    logger.warn({ channelSlug }, 'Provys: slug için fileCode çözülemedi');
    return { channelSlug, reason: 'unknown-channel', inserted: 0, updated: 0, deleted: 0, affectedDates: [] };
  }
  const allFiles = await listBxfFiles(watchDir);

  const candidates = selectCandidateFiles(allFiles, fileCodes, scheduleDate);
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

  // 2026-05-27: BXF sync başarılı (`applied`) — SSDB resolver tick'i tetikle.
  // Worker tarafında debounce/coalesce; aynı anda gelen birden fazla sync
  // tek tick'e indirgenir. API container'da background services disabled
  // olduğu için `requestSsdbResolverTick` no-op (sessizce döner).
  requestSsdbResolverTick(`provys-sync:${channelSlug}:${scheduleDate}`);

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
 * Slug → kabul edilen `fileCode` set'i (canonical + aliases).
 *
 * Exporter aynı kanal için birden çok fileCode üretebiliyor (örn. Beinhaber
 * canonical `xsnw` + alias `snw`; beinsports kanallarında geçmiş `x*`
 * varyantları). Aday dosya filtresi tüm bu kodları kabul etmeli, yoksa alias
 * dosyaları sessizce filtre dışında kalır.
 */
async function fileCodesForSlug(slug: ProvysChannelSlug): Promise<string[]> {
  const { PROVYS_CHANNELS } = await import('@bcms/shared');
  const c = PROVYS_CHANNELS.find((x) => x.slug === slug);
  if (!c) return [];
  return [c.fileCode, ...(c.fileCodeAliases ?? [])];
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
