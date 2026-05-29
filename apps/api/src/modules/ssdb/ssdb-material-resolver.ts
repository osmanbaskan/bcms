/**
 * SSDB MAM materyal lookup resolver — pure logic, 3-tier search.
 *
 * Sorumluluklar:
 *  - Input DC kodu listesini normalize (trim/empty/duplicate sade).
 *  - Tier 1: MEDIA.alias IN (batch)            -> matchMethod 'alias'.
 *  - Tier 2: MEDIA_DETAIL.originalFilename IN  -> matchMethod 'original_filename'.
 *  - Tier 3: MEDIA.name LIKE (per-DC, non-batch) -> matchMethod 'name_like'.
 *  - Bulunan media GUID'leri icin MEDIA_LINK batch SELECT (tcSOM/tcEOM).
 *  - Outcome shaping: cache-write-ready Map<dcCode, outcome>.
 *
 * Bu modul DB'ye/SSDB'ye DOGRUDAN yazmaz; sadece `query` helper'i cagirir.
 * `options.query` (default: ssdb.client.querySsdb) inject edilebilir; test'te
 * fake dispatcher kullanilir.
 *
 * SQL guvenligi: tum DC degerleri `request.input` ile bind edilir; SQL metnine
 * literal olarak GOMULMEZ. SELECT'ler `dbo.MEDIA / MEDIA_DETAIL / MEDIA_LINK`
 * tablolarinda sadece gerekli kolonlari okur; INSERT/UPDATE/DELETE/EXEC YOK.
 *
 * Hata davranisi (per-batch, isolation):
 *  - Tier 1/2 batch hata -> o batch'in unresolved code'lari icin ssdb_error
 *    (diger batch'ler etkilenmez; daha onceki Tier 1 hit'leri korunur).
 *  - Tier 3 (per-DC) hata -> sadece o DC ssdb_error.
 *  - MEDIA_LINK batch hata -> bulunan tum DC'ler duration_unknown + lastError
 *    (MEDIA bulundu fact'i korunur; sadece duration eksik).
 */

import sql from 'mssql';
import { querySsdb, type SsdbQueryParam } from './ssdb.client.js';
import { durationFramesInclusive, framesToSmpte } from './ssdb-duration.js';
import type { SsdbLookupStatus, SsdbMatchMethod } from './ssdb-status.js';
import { ConcurrencyLimiter } from '../../core/concurrency.js';

const DEFAULT_BATCH_SIZE = 50;
/** Es zamanli SSDB lookup uzeri mutlak ust limit — emrin "max 10" kuralinin
 *  kod tarafindaki yansimasi. config'de daha yuksek girilse bile clamp. */
export const SSDB_LOOKUP_CONCURRENCY_MAX = 10;
/** Default concurrency — caller (worker) gecmezse bu kullanilir. */
export const DEFAULT_SSDB_LOOKUP_CONCURRENCY = 10;

export interface SsdbMaterialResolverOptions {
  /** Resolver SMPTE timecode olusturmak icin kullanir; SSDB MEDIA_LINK fps
   *  ham olarak `videoFormat` int (V2'de VFORMAT lookup). V1 sabit default. */
  defaultFrameRate: number;
  /** Tier 1/2/MEDIA_LINK IN-batch boyutu. Default 50 (kullanici emir 25-50). */
  batchSize?: number;
  /** SSDB SQL query dispatcher; test'te fake icin override. */
  query?: typeof querySsdb;
  /** Es zamanli SSDB query ust siniri. Default 10; clamp [1,10].
   *  Tier 1/2/3 batch'leri ve MEDIA_LINK lookup'lari bu limiter altinda
   *  Promise.all ile paralel calistirilir; hicbir aciklikta in-flight 10'u asmaz. */
  lookupConcurrency?: number;
}

/** Concurrency input'u guvenli sekilde [1, MAX] araligina sik. */
function clampLookupConcurrency(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    return DEFAULT_SSDB_LOOKUP_CONCURRENCY;
  }
  return raw > SSDB_LOOKUP_CONCURRENCY_MAX ? SSDB_LOOKUP_CONCURRENCY_MAX : raw;
}

export interface SsdbMaterialLookupOutcome {
  dcCode: string;
  lookupStatus: SsdbLookupStatus;
  mediaGuid: string | null;
  mediaName: string | null;
  mediaAlias: string | null;
  originalFilename: string | null;
  matchMethod: SsdbMatchMethod | null;
  tcSom: number | null;
  tcEom: number | null;
  ssdbDurationFrames: number | null;
  ssdbDurationTimecode: string | null;
  frameRate: number | null;
  lastError: string | null;
}

/** SSDB ham SELECT cikti satiri — MEDIA + MEDIA_DETAIL JOIN. */
interface MediaRow {
  id: string;                       // uniqueidentifier
  name: string | null;
  alias: string | null;
  originalFilename: string | null;
}

/** SSDB MEDIA_LINK satiri. */
interface MediaLinkRow {
  idMedia: string;
  tcSOM: number | null;
  tcEOM: number | null;
  videoFormat: number | null;
}

/** Tier hit ara state — duration cek edilmeden once tutulur. */
interface FoundEntry {
  dcCode: string;
  matchMethod: SsdbMatchMethod;
  mediaGuid: string;
  mediaName: string | null;
  mediaAlias: string | null;
  originalFilename: string | null;
}

function normalizeDcCodes(input: readonly string[]): string[] {
  const set = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim();
    if (t.length === 0) continue;
    set.add(t);
  }
  return [...set];
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  if (size <= 0) return arr.length > 0 ? [arr.slice()] : [];
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Truncate; full error log'a yazilir caller tarafindan
  return raw.length > 240 ? raw.slice(0, 240) + '...' : raw;
}

function buildPlaceholders(prefix: string, count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(`@${prefix}${i}`);
  return parts.join(', ');
}

function buildCodeParams(batch: readonly string[]): SsdbQueryParam[] {
  return batch.map((c, i) => ({
    name: `code${i}`,
    type: sql.NVarChar(40),
    value: c,
  }));
}

function buildEmptyOutcome(
  dcCode: string,
  status: SsdbLookupStatus,
  lastError: string | null = null,
): SsdbMaterialLookupOutcome {
  return {
    dcCode,
    lookupStatus: status,
    mediaGuid: null,
    mediaName: null,
    mediaAlias: null,
    originalFilename: null,
    matchMethod: null,
    tcSom: null,
    tcEom: null,
    ssdbDurationFrames: null,
    ssdbDurationTimecode: null,
    frameRate: null,
    lastError,
  };
}

function mediaOutcomeBase(entry: FoundEntry): Omit<SsdbMaterialLookupOutcome,
  'lookupStatus' | 'tcSom' | 'tcEom' | 'ssdbDurationFrames' | 'ssdbDurationTimecode' |
  'frameRate' | 'lastError'> {
  return {
    dcCode: entry.dcCode,
    mediaGuid: entry.mediaGuid,
    mediaName: entry.mediaName,
    mediaAlias: entry.mediaAlias,
    originalFilename: entry.originalFilename,
    matchMethod: entry.matchMethod,
  };
}

/**
 * 3-tier lookup + MEDIA_LINK enrichment. Empty input -> empty Map (no query).
 */
export async function resolveSsdbMaterialsByDcCodes(
  dcCodes: readonly string[],
  options: SsdbMaterialResolverOptions,
): Promise<Map<string, SsdbMaterialLookupOutcome>> {
  const out = new Map<string, SsdbMaterialLookupOutcome>();
  const codes = normalizeDcCodes(dcCodes);
  if (codes.length === 0) return out;

  const batchSize =
    options.batchSize && options.batchSize > 0 ? options.batchSize : DEFAULT_BATCH_SIZE;
  const baseQuery = options.query ?? querySsdb;
  const fps = options.defaultFrameRate;

  // SSDB query fan-out limiter — Tier 1/2/3 + MEDIA_LINK paralel batch'ler
  // bu limiter altinda calisir. clamp [1, 10] zorlanir; default 10.
  const limiter = new ConcurrencyLimiter(clampLookupConcurrency(options.lookupConcurrency));
  const query = <T>(text: string, params?: SsdbQueryParam[]): Promise<T[]> =>
    limiter.run(() => baseQuery<T>(text, params));

  /** dcCode -> tier hit entry. Tek tier'da bulunan kazanir (ileri tier denenmez). */
  const found = new Map<string, FoundEntry>();

  // ─────────────────────────────── Tier 1: MEDIA.alias IN (batch, paralel + limited)
  await Promise.all(chunk(codes, batchSize).map(async (batch) => {
    try {
      const params = buildCodeParams(batch);
      const placeholders = buildPlaceholders('code', batch.length);
      const rows = await query<MediaRow>(
        `SELECT m.id, m.name, m.alias, md.originalFilename
         FROM dbo.MEDIA m
         LEFT JOIN dbo.MEDIA_DETAIL md ON md.id = m.id
         WHERE m.alias IN (${placeholders})`,
        params,
      );
      for (const row of rows) {
        const dc = row.alias;
        if (dc != null && batch.includes(dc) && !found.has(dc)) {
          found.set(dc, {
            dcCode: dc,
            matchMethod: 'alias',
            mediaGuid: row.id,
            mediaName: row.name,
            mediaAlias: row.alias,
            originalFilename: row.originalFilename,
          });
        }
      }
    } catch (err) {
      const errMsg = sanitizeError(err);
      // Bu batch'teki Tier 1 cevabi kayboldu -> code'lari ssdb_error
      // (diger batch'ler / Tier 1 hit'leri etkilenmez).
      for (const c of batch) {
        if (!found.has(c) && !out.has(c)) {
          out.set(c, buildEmptyOutcome(c, 'ssdb_error', errMsg));
        }
      }
    }
  }));

  // Tier 2/3 sadece henuz cozulmemis ve error olmamis olanlar uzerinde
  const tier2Candidates = codes.filter((c) => !found.has(c) && !out.has(c));

  // ─────────────────────────────── Tier 2: MEDIA_DETAIL.originalFilename (paralel + limited)
  await Promise.all(chunk(tier2Candidates, batchSize).map(async (batch) => {
    try {
      const params = buildCodeParams(batch);
      const placeholders = buildPlaceholders('code', batch.length);
      const rows = await query<MediaRow>(
        `SELECT m.id, m.name, m.alias, md.originalFilename
         FROM dbo.MEDIA m
         INNER JOIN dbo.MEDIA_DETAIL md ON md.id = m.id
         WHERE md.originalFilename IN (${placeholders})`,
        params,
      );
      for (const row of rows) {
        const dc = row.originalFilename;
        if (dc != null && batch.includes(dc) && !found.has(dc)) {
          found.set(dc, {
            dcCode: dc,
            matchMethod: 'original_filename',
            mediaGuid: row.id,
            mediaName: row.name,
            mediaAlias: row.alias,
            originalFilename: row.originalFilename,
          });
        }
      }
    } catch (err) {
      const errMsg = sanitizeError(err);
      for (const c of batch) {
        if (!found.has(c) && !out.has(c)) {
          out.set(c, buildEmptyOutcome(c, 'ssdb_error', errMsg));
        }
      }
    }
  }));

  // Tier 3 sadece hala unresolved & error olmayanlar (son care, per-DC LIKE)
  const tier3Candidates = codes.filter((c) => !found.has(c) && !out.has(c));

  // ─────────────────────────────── Tier 3: MEDIA.name LIKE (per-DC, paralel + limited)
  await Promise.all(tier3Candidates.map(async (dc) => {
    try {
      const rows = await query<MediaRow>(
        `SELECT TOP 1 m.id, m.name, m.alias, md.originalFilename
         FROM dbo.MEDIA m
         LEFT JOIN dbo.MEDIA_DETAIL md ON md.id = m.id
         WHERE m.name LIKE '%' + @code + '%'`,
        [{ name: 'code', type: sql.NVarChar(40), value: dc }],
      );
      if (rows.length > 0) {
        const row = rows[0];
        found.set(dc, {
          dcCode: dc,
          matchMethod: 'name_like',
          mediaGuid: row.id,
          mediaName: row.name,
          mediaAlias: row.alias,
          originalFilename: row.originalFilename,
        });
      }
    } catch (err) {
      out.set(dc, buildEmptyOutcome(dc, 'ssdb_error', sanitizeError(err)));
    }
  }));

  // ─────────────────────────────── MEDIA_LINK batch icin tum found GUID'leri (paralel + limited)
  const foundEntries = [...found.values()];
  const guidToLink = new Map<string, MediaLinkRow>();
  // Per-GUID failure map: hangi GUID'lerin MEDIA_LINK batch'i fail oldu +
  // hata mesaji. Outcome shaping link-yok durumda bu map'e bakar; sadece
  // gercekten fail batch'te olan GUID'lere lastError yansir. Unrelated
  // (link satiri olmayan) GUID'lerin lastError'i null kalir.
  const failedMediaLinkGuids = new Map<string, string>();

  if (foundEntries.length > 0) {
    const guids = foundEntries.map((e) => e.mediaGuid);
    const guidBatches = chunk(guids, batchSize);
    // Promise.all + try/catch per-batch. Bir batch fail olursa o batch'in
    // tum GUID'leri `failedMediaLinkGuids` map'ine hata mesajiyla eklenir;
    // diger batch'ler etkilenmez (kismi basari korunur).
    await Promise.all(guidBatches.map(async (guidBatch) => {
      try {
        const params: SsdbQueryParam[] = guidBatch.map((g, i) => ({
          name: `mid${i}`,
          type: sql.UniqueIdentifier,
          value: g,
        }));
        const placeholders = buildPlaceholders('mid', guidBatch.length);
        // Deterministic secim: ayni mediaGuid icin tcSOM ASC + tcEOM DESC;
        // resolver per-guid ilk satiri kullanir (en erken baslayan, en uzun bitis).
        const rows = await query<MediaLinkRow>(
          `SELECT ml.idMedia, ml.tcSOM, ml.tcEOM, ml.videoFormat
           FROM dbo.MEDIA_LINK ml
           WHERE ml.idMedia IN (${placeholders})
           ORDER BY ml.idMedia, ml.tcSOM ASC, ml.tcEOM DESC`,
          params,
        );
        for (const row of rows) {
          if (!guidToLink.has(row.idMedia)) {
            guidToLink.set(row.idMedia, row);
          }
        }
      } catch (err) {
        const errMsg = sanitizeError(err);
        for (const g of guidBatch) {
          failedMediaLinkGuids.set(g, errMsg);
        }
      }
    }));
  }

  // ─────────────────────────────── Outcome shaping
  for (const code of codes) {
    if (out.has(code)) continue; // ssdb_error daha onceki tier'lardan

    const entry = found.get(code);
    if (!entry) {
      out.set(code, buildEmptyOutcome(code, 'missing_material'));
      continue;
    }

    // Partial failure korumasi: per-GUID `failedMediaLinkGuids` map'ine bakilir.
    // - Link bulundu (basarili batch + row var) -> normal `found` outcome.
    // - Link bulunmadi:
    //     a) fail batch'e denk gelen GUID -> duration_unknown + lastError set
    //     b) success batch ama row yok -> duration_unknown + lastError NULL
    //   Bu sekilde unrelated link-missing GUID'lere yanlislikla fail batch'in
    //   hatasi yazilmaz (yoneticinin tespiti).
    const link = guidToLink.get(entry.mediaGuid);
    if (!link) {
      out.set(code, {
        ...mediaOutcomeBase(entry),
        lookupStatus: 'duration_unknown',
        tcSom: null,
        tcEom: null,
        ssdbDurationFrames: null,
        ssdbDurationTimecode: null,
        frameRate: null,
        lastError: failedMediaLinkGuids.get(entry.mediaGuid) ?? null,
      });
      continue;
    }

    const frames = durationFramesInclusive(link.tcSOM, link.tcEOM);
    if (frames == null) {
      out.set(code, {
        ...mediaOutcomeBase(entry),
        lookupStatus: 'duration_unknown',
        tcSom: link.tcSOM,
        tcEom: link.tcEOM,
        ssdbDurationFrames: null,
        ssdbDurationTimecode: null,
        frameRate: null,
        lastError: null,
      });
      continue;
    }

    const tc = framesToSmpte(frames, fps);
    out.set(code, {
      ...mediaOutcomeBase(entry),
      lookupStatus: 'found',
      tcSom: link.tcSOM,
      tcEom: link.tcEOM,
      ssdbDurationFrames: frames,
      ssdbDurationTimecode: tc,
      frameRate: fps,
      lastError: null,
    });
  }

  return out;
}
