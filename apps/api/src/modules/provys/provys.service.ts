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
}

interface DiffPlan {
  toCreate: Prisma.ProvysItemCreateManyInput[];
  toUpdate: Array<{ id: number; data: Prisma.ProvysItemUpdateInput }>;
  toDeleteIds: number[];
}

function computeHash(item: Pick<ParsedItem, 'eventId' | 'startAt' | 'durationMs' | 'title' | 'rawKind' | 'category' | 'sequence'>): string {
  const canonical = [
    item.eventId,
    item.startAt.toISOString(),
    item.durationMs ?? '',
    item.title,
    item.rawKind ?? '',
    item.category,
    item.sequence,
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function buildDiff(
  channelSlug: ProvysChannelSlug,
  sourceFile: string,
  sourceMtime: Date,
  parsed: ParsedItem[],
  existing: Array<{ id: number; eventId: string; payloadHash: string }>,
): DiffPlan {
  const existingByEventId = new Map(existing.map((r) => [r.eventId, r]));
  const parsedByEventId = new Map(parsed.map((p) => [p.eventId, p]));

  const toCreate: Prisma.ProvysItemCreateManyInput[] = [];
  const toUpdate: Array<{ id: number; data: Prisma.ProvysItemUpdateInput }> = [];
  const toDeleteIds: number[] = [];

  for (const p of parsed) {
    const hash = computeHash(p);
    const existingRow = existingByEventId.get(p.eventId);
    if (!existingRow) {
      toCreate.push({
        channelSlug,
        eventId: p.eventId,
        sequence: p.sequence,
        startAt: p.startAt,
        durationMs: p.durationMs,
        title: p.title,
        rawKind: p.rawKind,
        category: p.category,
        sourceFile,
        sourceMtime,
        payloadHash: hash,
      });
    } else if (existingRow.payloadHash !== hash) {
      toUpdate.push({
        id: existingRow.id,
        data: {
          sequence: p.sequence,
          startAt: p.startAt,
          durationMs: p.durationMs,
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
    if (!parsedByEventId.has(e.eventId)) toDeleteIds.push(e.id);
  }

  return { toCreate, toUpdate, toDeleteIds };
}

/**
 * Dosyayı parse eder, kanalı çözer, current-snapshot tablosunu diff'leyerek
 * günceller, değişiklik varsa pg_notify yayınlar.
 *
 * Audit: tüm yazımlar Prisma audit extension üstünden geçer (bypass yok).
 * Worker bağlamı için actor='system:provys-watcher' caller tarafından
 * ALS sarmalanarak set edilir (bkz. provys.watcher.ts).
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
    return { channelSlug: null, reason: 'unknown-channel', inserted: 0, updated: 0, deleted: 0 };
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
    return { channelSlug, reason: 'parse-empty', inserted: 0, updated: 0, deleted: 0 };
  }

  const existing = await prisma.provysItem.findMany({
    where: { channelSlug },
    select: { id: true, eventId: true, payloadHash: true },
  });

  const diff = buildDiff(channelSlug, filePath, stat.mtime, parsed, existing);
  const changeCount = diff.toCreate.length + diff.toUpdate.length + diff.toDeleteIds.length;
  if (changeCount === 0) {
    return { channelSlug, reason: 'unchanged', inserted: 0, updated: 0, deleted: 0 };
  }

  await prisma.$transaction(async (tx) => {
    if (diff.toDeleteIds.length > 0) {
      await tx.provysItem.deleteMany({ where: { id: { in: diff.toDeleteIds } } });
    }
    if (diff.toCreate.length > 0) {
      await tx.provysItem.createMany({ data: diff.toCreate });
    }
    for (const u of diff.toUpdate) {
      await tx.provysItem.update({ where: { id: u.id }, data: u.data });
    }
  });

  // Notify outside tx — abonelerin commit'den önce hayalet okumasını önle.
  try {
    const payload = JSON.stringify({ channelSlug });
    // pg_notify(channel, payload) — write değil; audit ext bypass'i gerekmez.
    await prisma.$executeRaw`SELECT pg_notify(${PG_NOTIFY_CHANNEL}, ${payload})`;
  } catch (err) {
    logger.warn({ err, channelSlug }, 'Provys: pg_notify başarısız (sync tamam, listener bypass)');
  }

  logger.info(
    {
      channelSlug,
      inserted: diff.toCreate.length,
      updated: diff.toUpdate.length,
      deleted: diff.toDeleteIds.length,
      sourceFile: filePath,
    },
    'Provys: kanal senkronize edildi',
  );

  return {
    channelSlug,
    reason: 'applied',
    inserted: diff.toCreate.length,
    updated: diff.toUpdate.length,
    deleted: diff.toDeleteIds.length,
  };
}

/**
 * Kanalın tüm satırlarını siler ve pg_notify yayar. Dizinde aynı kanala
 * ait BXF kalmadığında watcher tarafından çağrılır. Audit ext devrede
 * (deleteMany → DELETE audit kaydı).
 */
export async function clearChannelSnapshot(
  prisma: PrismaClient,
  channelSlug: string,
  logger: FastifyBaseLogger,
): Promise<{ deleted: number }> {
  const result = await prisma.provysItem.deleteMany({ where: { channelSlug } });
  if (result.count > 0) {
    try {
      const payload = JSON.stringify({ channelSlug });
      await prisma.$executeRaw`SELECT pg_notify(${PG_NOTIFY_CHANNEL}, ${payload})`;
    } catch (err) {
      logger.warn({ err, channelSlug }, 'Provys: pg_notify başarısız (clear sırasında)');
    }
    logger.info({ channelSlug, deleted: result.count }, 'Provys: kanal snapshot temizlendi');
  }
  return { deleted: result.count };
}

/** Pure diff — test edilebilir. */
export const __internals__ = { buildDiff, computeHash };
