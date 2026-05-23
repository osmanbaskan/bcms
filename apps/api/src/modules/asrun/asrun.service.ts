import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { parseBxf, type ParsedItem } from '../provys/provys.parser.js';
import { resolveChannelFromPath, extractFileCode } from '../provys/provys.channel-mapping.js';
import type { AsrunChannelSlug } from '@bcms/shared';

/**
 * Asrun ingest servisi — playout sonrası gerçekleşen yayın kaydı.
 *
 * Domain ayrımı:
 *   - Provys (`provys_items`): planlanan playlist; composed latest-wins
 *     coverage merge ile birden çok revize tek snapshot'a indirgenir.
 *   - Asrun  (`asrun_items`):  gerçekleşen yayın olayı; geçmiş sabit.
 *     Composed merge davranışı YOK. Aynı `(channelSlug, scheduleDate,
 *     eventId)` üçlüsü için idempotent upsert; latest sourceMtime kazanır.
 *
 * Parser ve channel-mapping helper'ları Provys modülünden yeniden kullanılır
 * (aynı SMPTE 2021 BXF + aynı 6 kanal kataloğu). Bu modül kendi audit ext
 * context'ini Provys watcher ile paylaşmaz: Asrun yazımları
 * `system:asrun-watcher` actor'üyle işaretlenecek (watcher tarafında).
 */

export const ASRUN_AUDIT_ENTITY = 'AsrunItem';

export interface AsrunSyncResult {
  channelSlug: AsrunChannelSlug | null;
  reason?: 'unknown-channel' | 'parse-empty' | 'unchanged' | 'applied';
  inserted: number;
  updated: number;
  affectedDates: string[];
}

function computeHash(item: ParsedItem): string {
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
 * Bir BXF dosyasını parse eder ve içerdiği her event'i `asrun_items`'a
 * idempotent upsert eder. Provys gibi DELETE yapılmaz — geçmiş kayıt
 * kaybedilemez; aynı eventId yeni bir mtime ile gelirse update edilir.
 *
 * Composed merge mantığı yok: tek dosya, tek import. Aynı kanal/gün için
 * birden fazla dosya gelmiş olabilir (örn. partial export'lar); her dosya
 * kendi event'lerini insert/update eder, başka dosyanın event'lerini
 * silmez.
 */
export async function ingestAsrunFile(
  prisma: PrismaClient,
  filePath: string,
  logger: FastifyBaseLogger,
): Promise<AsrunSyncResult> {
  const channelSlug = resolveChannelFromPath(filePath) as AsrunChannelSlug | null;
  if (!channelSlug) {
    logger.warn(
      { filePath, fileCode: extractFileCode(filePath) },
      'Asrun: bilinmeyen file code, import edilmedi',
    );
    return { channelSlug: null, reason: 'unknown-channel', inserted: 0, updated: 0, affectedDates: [] };
  }

  let content: string;
  let stat: { mtime: Date };
  try {
    [content, stat] = await Promise.all([
      fs.readFile(filePath, 'utf-8'),
      fs.stat(filePath),
    ]);
  } catch (err) {
    logger.error({ err, filePath }, 'Asrun: dosya okunamadı');
    throw err;
  }

  const parsed = parseBxf(content);
  if (parsed.length === 0) {
    logger.info({ filePath, channelSlug }, 'Asrun: parse boş, import atlandı');
    return { channelSlug, reason: 'parse-empty', inserted: 0, updated: 0, affectedDates: [] };
  }

  let inserted = 0;
  let updated = 0;
  const affectedDatesSet = new Set<string>();

  // Tek transaction tek event = pool basıncı artar; bunun yerine grup başına
  // bir transaction (kanal × gün) — Provys service ile aynı pattern.
  const groupedByDate = new Map<string, ParsedItem[]>();
  for (const p of parsed) {
    const arr = groupedByDate.get(p.scheduleDate) ?? [];
    arr.push(p);
    groupedByDate.set(p.scheduleDate, arr);
  }

  for (const [scheduleDate, items] of groupedByDate) {
    const scheduleDateAsDb = new Date(`${scheduleDate}T00:00:00Z`);
    const eventIds = items.map((i) => i.eventId);
    const existing = await prisma.asrunItem.findMany({
      where: {
        channelSlug,
        scheduleDate: scheduleDateAsDb,
        eventId: { in: eventIds },
      },
      select: { id: true, eventId: true, payloadHash: true, sourceMtime: true },
    });
    const existingByEventId = new Map(existing.map((r) => [r.eventId, r]));

    const toCreate: Prisma.AsrunItemCreateManyInput[] = [];
    const toUpdate: Array<{ id: number; data: Prisma.AsrunItemUpdateInput }> = [];

    for (const p of items) {
      const hash = computeHash(p);
      const ex = existingByEventId.get(p.eventId);
      if (!ex) {
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
          sourceFile: filePath,
          sourceMtime: stat.mtime,
          payloadHash: hash,
        });
      } else if (ex.payloadHash !== hash && stat.mtime.getTime() >= ex.sourceMtime.getTime()) {
        // Sadece daha yeni (>= eski) source dosya update edebilir; eski revize
        // yeni revize'yi GERİYE ÇEKEMEZ. Tie durumunda son işlenen kazanır.
        toUpdate.push({
          id: ex.id,
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
            sourceFile: filePath,
            sourceMtime: stat.mtime,
            payloadHash: hash,
          },
        });
      }
    }

    if (toCreate.length === 0 && toUpdate.length === 0) continue;

    await prisma.$transaction(
      async (tx) => {
        if (toCreate.length > 0) {
          await tx.asrunItem.createMany({ data: toCreate, skipDuplicates: true });
        }
        for (const u of toUpdate) {
          await tx.asrunItem.update({ where: { id: u.id }, data: u.data });
        }
      },
      { timeout: 30_000, maxWait: 5_000 },
    );

    inserted += toCreate.length;
    updated += toUpdate.length;
    affectedDatesSet.add(scheduleDate);

    logger.info(
      {
        channelSlug,
        scheduleDate,
        inserted: toCreate.length,
        updated: toUpdate.length,
        sourceFile: filePath,
      },
      'Asrun: dosya senkronize edildi',
    );
  }

  if (inserted === 0 && updated === 0) {
    return { channelSlug, reason: 'unchanged', inserted: 0, updated: 0, affectedDates: [] };
  }
  return {
    channelSlug,
    reason: 'applied',
    inserted,
    updated,
    affectedDates: Array.from(affectedDatesSet),
  };
}
