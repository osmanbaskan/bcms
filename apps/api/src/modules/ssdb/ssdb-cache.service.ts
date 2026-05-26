/**
 * SSDB cache yazma + notify orchestration — worker ve route ortak yolu.
 *
 * Sorumluluk:
 *  - Resolver outcome -> ssdb_material_cache upsert payload mapping
 *  - Idempotent upsert
 *  - "Anlamli degisim" tespiti (lastCheckedAt tek basina degisim sayilmaz)
 *  - Etkilenen today+future non-CANLI (channelSlug, scheduleDate) ciftleri
 *  - Notify (emitNotify) cagrisi per pair
 *
 * Cache SADECE SSDB raw fact tutar; Provys-bagimli status (found_match,
 * mismatch, live_not_applicable) YAZILMAZ.
 */

import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { SsdbMaterialLookupOutcome } from './ssdb-material-resolver.js';
import type { emitNotify } from '../provys/provys.service.js';

/** Cache prev satir minimal projection — TTL ve diff icin yeter. */
export interface SsdbCachePrevRow {
  dcCode: string;
  lookupStatus: string;
  mediaGuid: string | null;
  matchMethod: string | null;
  tcSom: number | null;
  tcEom: number | null;
  ssdbDurationFrames: number | null;
  lastCheckedAt: Date;
  lastError: string | null;
}

/** Etkilenen (channel, date) cifti — affected query cikti tipi. */
export interface AffectedPair {
  channelSlug: string;
  scheduleDate: Date;
}

/** Prisma minimal contract — upsert helper icin yeterli. */
type UpsertCapablePrisma = Pick<PrismaClient, 'ssdbMaterialCache' | 'provysItem'>;

/**
 * Cache prev row + yeni outcome arasinda "anlamli degisim" var mi.
 * `lastCheckedAt` tek basina degisim sayilmaz.
 */
export function isSsdbCacheOutcomeChanged(
  prev: SsdbCachePrevRow | null,
  next: SsdbMaterialLookupOutcome,
): boolean {
  if (prev == null) return true;
  return (
    prev.lookupStatus !== next.lookupStatus ||
    (prev.mediaGuid ?? null) !== (next.mediaGuid ?? null) ||
    (prev.tcSom ?? null) !== (next.tcSom ?? null) ||
    (prev.tcEom ?? null) !== (next.tcEom ?? null) ||
    (prev.ssdbDurationFrames ?? null) !== (next.ssdbDurationFrames ?? null) ||
    (prev.matchMethod ?? null) !== (next.matchMethod ?? null) ||
    (prev.lastError ?? null) !== (next.lastError ?? null)
  );
}

/** Resolver outcome -> Prisma upsert create/update payload. */
export function outcomeToCachePayload(
  o: SsdbMaterialLookupOutcome,
  now: Date,
): { create: Record<string, unknown>; update: Record<string, unknown> } {
  const create = {
    dcCode: o.dcCode,
    lookupStatus: o.lookupStatus,
    mediaGuid: o.mediaGuid,
    mediaName: o.mediaName,
    mediaAlias: o.mediaAlias,
    originalFilename: o.originalFilename,
    matchMethod: o.matchMethod,
    tcSom: o.tcSom,
    tcEom: o.tcEom,
    ssdbDurationFrames: o.ssdbDurationFrames,
    ssdbDurationTimecode: o.ssdbDurationTimecode,
    frameRate: o.frameRate,
    lastCheckedAt: now,
    lastFoundAt: o.lookupStatus === 'found' ? now : null,
    lastError: o.lastError,
  };
  const baseUpdate = {
    lookupStatus: o.lookupStatus,
    mediaGuid: o.mediaGuid,
    mediaName: o.mediaName,
    mediaAlias: o.mediaAlias,
    originalFilename: o.originalFilename,
    matchMethod: o.matchMethod,
    tcSom: o.tcSom,
    tcEom: o.tcEom,
    ssdbDurationFrames: o.ssdbDurationFrames,
    ssdbDurationTimecode: o.ssdbDurationTimecode,
    frameRate: o.frameRate,
    lastCheckedAt: now,
    lastError: o.lastError,
  };
  // `lastFoundAt` sadece found iken bump; aksi durumda var olan deger korunur.
  const update = o.lookupStatus === 'found'
    ? { ...baseUpdate, lastFoundAt: now }
    : baseUpdate;
  return { create, update };
}

/** Prisma upsert — audit ext aktif (caller ALS context'i set etmeli). */
export async function upsertSsdbCacheOutcome(
  prisma: UpsertCapablePrisma,
  outcome: SsdbMaterialLookupOutcome,
  now: Date,
): Promise<void> {
  const { create, update } = outcomeToCachePayload(outcome, now);
  await prisma.ssdbMaterialCache.upsert({
    where: { dcCode: outcome.dcCode },
    create: create as never,
    update: update as never,
  });
}

/**
 * Verilen DC kodlari icin etkilenen non-CANLI today+future (channel, date)
 * ciftlerini bulur. distinct ile dedupe edilmis.
 */
export async function findAffectedTodayFuturePairs(
  prisma: UpsertCapablePrisma,
  dcCodes: readonly string[],
  todayUtc: Date,
  futureUtc: Date,
): Promise<AffectedPair[]> {
  if (dcCodes.length === 0) return [];
  const rows = await prisma.provysItem.findMany({
    where: {
      dcCode: { in: [...dcCodes] },
      category: { not: 'CANLI' },
      scheduleDate: { gte: todayUtc, lte: futureUtc },
    },
    select: { channelSlug: true, scheduleDate: true },
    distinct: ['channelSlug', 'scheduleDate'],
  });
  return rows;
}

/**
 * Etkilenen pair'lar icin emitNotify cagir. Hata olursa log + devam et
 * (tek pair fail digerlerini durdurmaz).
 * Returns: basariyla notify edilen pair sayisi.
 */
export async function notifyAffectedPairs(
  emit: typeof emitNotify,
  prisma: UpsertCapablePrisma,
  logger: Pick<FastifyBaseLogger, 'warn'>,
  pairs: readonly AffectedPair[],
): Promise<number> {
  let count = 0;
  for (const p of pairs) {
    const dateStr = p.scheduleDate.toISOString().slice(0, 10);
    try {
      await emit(prisma as PrismaClient, logger as FastifyBaseLogger, p.channelSlug, dateStr);
      count++;
    } catch (err) {
      logger.warn({ err, channel: p.channelSlug, date: dateStr },
        'SSDB cache notify failed (per-pair, continuing)');
    }
  }
  return count;
}
