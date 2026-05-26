/**
 * Provys row -> ProvysItemSsdbInfo merge helper.
 *
 * Sorumluluk: API response-time (snapshot/PATCH) icinde Provys satiri ile
 * `ssdb_material_cache` satirini birlestirir; UI'a hazir `materialStatus`
 * + label uretir.
 *
 * Kritik kurallar:
 *  - `PROVYS_SSDB_RESOLVER` kapali iken cache tablosu ASLA sorgulanmaz.
 *  - CANLI satirlar icin cache aranmaz; karar always `live_not_applicable`.
 *  - dcCode null/blank non-CANLI satirlar icin cache aranmaz.
 *  - Cache write YAPILMAZ; sadece read.
 *
 * Bu helper Provys watcher hash/diff mantigina dokunmaz; ProvysItem modeline
 * yeni kolon eklemez. Cache miss veya flag off durumda DTO `ssdb` blogu
 * dolu/null-friendly default ile doner.
 */

import type { PrismaClient } from '@prisma/client';
import type { ProvysItemSsdbInfo } from '@bcms/shared';
import { loadSsdbConfig } from '../ssdb/ssdb.config.js';
import {
  decideMaterialStatus,
  isProvysLiveCategory,
  type SsdbLookupStatus,
  type SsdbMatchMethod,
} from '../ssdb/ssdb-status.js';
import { provysDurationToFrames } from '../ssdb/ssdb-duration.js';

/** Cache row minimal projection — sadece DTO icin gerekli alanlar. */
export interface SsdbCacheRowForMerge {
  dcCode: string;
  lookupStatus: string;
  mediaGuid: string | null;
  matchMethod: string | null;
  ssdbDurationFrames: number | null;
  ssdbDurationTimecode: string | null;
  frameRate: number | null;
  lastCheckedAt: Date;
  lastError: string | null;
}

/** Merge'te kullanilan Provys row alanlari — Prisma findMany subset. */
export interface ProvysRowForMerge {
  category: string;
  dcCode: string | null;
  durationMs: number | null;
  durationTimecode: string | null;
  frameRate: number | null;
}

/** Flag-aware Prisma minimal contract — test mock'lamayi kolaylastirir. */
export interface SsdbCacheReader {
  ssdbMaterialCache: {
    findMany(args: {
      where: { dcCode: { in: string[] } };
      select: {
        dcCode: true; lookupStatus: true; mediaGuid: true; matchMethod: true;
        ssdbDurationFrames: true; ssdbDurationTimecode: true; frameRate: true;
        lastCheckedAt: true; lastError: true;
      };
    }): Promise<SsdbCacheRowForMerge[]>;
  };
}

/**
 * Cache aramaya uygun DC kodlarini cikar.
 *
 * Filtre:
 *  - CANLI hariç (cache aramaya gerek yok)
 *  - dcCode null/empty/whitespace hariç
 *  - duplicate'lar tek seferde
 */
export function pickEligibleDcCodes(rows: readonly ProvysRowForMerge[]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    if (isProvysLiveCategory({ category: row.category })) continue;
    const dc = row.dcCode;
    if (dc == null) continue;
    const t = dc.trim();
    if (t.length === 0) continue;
    set.add(t);
  }
  return [...set];
}

/**
 * Cache map yukle. Flag off iken Prisma'ya hic dokunmaz (migration apply
 * edilmemis ortamlarda API kirilmaz). dcCode listesi bos ise yine empty Map.
 *
 * `prisma` minimal contract — gercek `PrismaClient` veya test mock kabul eder.
 */
export async function fetchSsdbCacheMap(
  prisma: SsdbCacheReader,
  rows: readonly ProvysRowForMerge[],
  flagEnabled: boolean,
): Promise<Map<string, SsdbCacheRowForMerge>> {
  if (!flagEnabled) return new Map();
  const codes = pickEligibleDcCodes(rows);
  if (codes.length === 0) return new Map();

  const cache = await prisma.ssdbMaterialCache.findMany({
    where: { dcCode: { in: codes } },
    select: {
      dcCode: true, lookupStatus: true, mediaGuid: true, matchMethod: true,
      ssdbDurationFrames: true, ssdbDurationTimecode: true, frameRate: true,
      lastCheckedAt: true, lastError: true,
    },
  });
  return new Map(cache.map((c) => [c.dcCode, c]));
}

/**
 * Tek Provys row icin DTO `ssdb` blogunu kur. Cache miss / CANLI / no-dc
 * durumlarinda default doldurur; cache hit'te decideMaterialStatus karari.
 */
export function buildSsdbInfoForRow(
  row: ProvysRowForMerge,
  cacheRow: SsdbCacheRowForMerge | null,
): ProvysItemSsdbInfo {
  const provysFrames = provysDurationToFrames({
    durationTimecode: row.durationTimecode,
    durationMs: row.durationMs,
    frameRate: row.frameRate,
  });

  const decision = decideMaterialStatus({
    category: row.category,
    dcCode: row.dcCode,
    lookupStatus: (cacheRow?.lookupStatus as SsdbLookupStatus | null) ?? null,
    ssdbDurationFrames: cacheRow?.ssdbDurationFrames ?? null,
    provysDurationFrames: provysFrames,
  });

  // CANLI short-circuit — cache alanlari ASLA DTO'ya tasinmaz.
  if (isProvysLiveCategory({ category: row.category })) {
    return {
      lookupStatus: null,
      materialStatus: decision.materialStatus,
      statusLabel: decision.statusLabel,
      mediaGuid: null,
      matchMethod: null,
      ssdbDurationFrames: null,
      ssdbDurationTimecode: null,
      provysDurationFrames: null,
      frameRate: null,
      lastCheckedAt: null,
      lastError: null,
    };
  }

  return {
    lookupStatus: (cacheRow?.lookupStatus as SsdbLookupStatus | undefined) ?? null,
    materialStatus: decision.materialStatus,
    statusLabel: decision.statusLabel,
    mediaGuid: cacheRow?.mediaGuid ?? null,
    matchMethod: (cacheRow?.matchMethod as SsdbMatchMethod | null | undefined) ?? null,
    ssdbDurationFrames: cacheRow?.ssdbDurationFrames ?? null,
    ssdbDurationTimecode: cacheRow?.ssdbDurationTimecode ?? null,
    provysDurationFrames: provysFrames,
    frameRate: cacheRow?.frameRate ?? row.frameRate ?? null,
    lastCheckedAt: cacheRow?.lastCheckedAt ? cacheRow.lastCheckedAt.toISOString() : null,
    lastError: cacheRow?.lastError ?? null,
  };
}

/** Snapshot route gibi caller'lar icin: feature flag'i config'ten oku. */
export function isSsdbResolverEnabled(): boolean {
  return loadSsdbConfig().enabled;
}
