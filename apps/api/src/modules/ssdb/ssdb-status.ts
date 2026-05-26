/**
 * SSDB lookup status (cache fact) ve Provys material status (response-time
 * computed) ayrimini koruyan saf helper'lar.
 *
 * Iki katmanli enum:
 *  - SsdbLookupStatus    : DB cache satirinda saklanir; SADECE SSDB lookup
 *                          sonucu (Provys-bagimsiz).
 *  - ProvysMaterialStatus: response-time hesaplanir; UI render bunu kullanir.
 *                          ASLA DB'ye yazilmaz (drift riski).
 *
 * Canlı (CANLI) yayin SSDB MAM materyal kontrolu disindadir:
 * `decideMaterialStatus` 1. adimda short-circuit; cache okumaz, alarm
 * uretmez. Bkz feedback memory + plan revizyonu.
 *
 * Bu modul DB / network / env / global state OKUMAZ. compareDurations ve
 * DEFAULT_TOLERANCE_FRAMES C1'deki ssdb-duration.ts'ten gelir.
 */

import { compareDurations, DEFAULT_TOLERANCE_FRAMES } from './ssdb-duration.js';
import type { SsdbLookupStatus, ProvysMaterialStatus, SsdbMatchMethod } from '@bcms/shared';

// Type tanimlari `@bcms/shared` icinde tek kaynak; backend kullananlar
// historik olarak bu modulden import etti — drift olmamasi icin re-export.
export type { SsdbLookupStatus, ProvysMaterialStatus, SsdbMatchMethod };

/** UI Turkce label tablosu — backend'de derived; UI direkt render eder. */
export const PROVYS_MATERIAL_STATUS_LABEL: Record<ProvysMaterialStatus, string> = {
  live_not_applicable:     'Canlı',
  dc_not_applicable:       'DC kod yok; SSDB MAM materyal kontrolü yapılmaz',
  unchecked:               'Kontrol bekliyor',
  missing_material:        'Materyal eksik',
  found_match:             'Materyal var',
  found_duration_mismatch: 'Materyal var, duration uymuyor',
  found_duration_unknown:  'Materyal var, süre yok',
  ssdb_error:              'SSDB hata',
};

/**
 * Provys satirinin SSDB MAM materyal kontrolunden muaf olup olmadigi.
 *
 * V1: sadece `category === 'CANLI'`. Genisleme (orn. dis kanal naklen feed
 * ayri bayrak) bu fonksiyonun tek degisim noktasi olur.
 */
export function isProvysLiveCategory(input: { category: string | null | undefined }): boolean {
  return input.category === 'CANLI';
}

/** Karar fonksiyonu girdisi. Tum alanlar saf veri; helper hicbirini fetch etmez. */
export interface MaterialStatusInput {
  /** Provys row kategori (ProvysCategory string'i; sadece 'CANLI' onemli). */
  category: string | null;
  /** Provys row DC kodu. null/empty/whitespace -> "yok" semantigi. */
  dcCode: string | null;
  /** Cache satirinin lookup_status'u; cache satiri yoksa null. */
  lookupStatus: SsdbLookupStatus | null;
  /** Cache'ten gelen SSDB duration (frame). null/missing kabul. */
  ssdbDurationFrames: number | null;
  /** Response handler'in Provys row'dan hesapladigi duration (frame). */
  provysDurationFrames: number | null;
}

/** Karar fonksiyonu cikti; UI render bunu kullanir. */
export interface MaterialStatusDecision {
  materialStatus: ProvysMaterialStatus;
  statusLabel: string;
}

function buildDecision(status: ProvysMaterialStatus): MaterialStatusDecision {
  return { materialStatus: status, statusLabel: PROVYS_MATERIAL_STATUS_LABEL[status] };
}

/** dcCode null/empty/whitespace ise "kod yok" kabul edilir. */
function isBlankDcCode(dcCode: string | null): boolean {
  if (dcCode == null) return true;
  return dcCode.trim() === '';
}

/**
 * Provys row + SSDB cache lookup -> UI material status karari.
 *
 * Karar sirasi (ilk eslesen kazanir):
 *  1. CANLI kategori                       -> 'live_not_applicable'
 *  2. dcCode blank                         -> 'dc_not_applicable' (SSDB kapsami disi)
 *  3. cache satiri yok                     -> 'unchecked'
 *  4. lookupStatus 'ssdb_error'            -> 'ssdb_error'
 *  5. lookupStatus 'missing_material'      -> 'missing_material'
 *  6. lookupStatus 'duration_unknown'      -> 'found_duration_unknown'
 *  7. lookupStatus 'found':
 *     a. ssdbDurationFrames yok            -> 'found_duration_unknown'
 *     b. provysDurationFrames yok          -> 'found_duration_unknown'
 *     c. compareDurations 'equal'          -> 'found_match'
 *     d. compareDurations 'mismatch'       -> 'found_duration_mismatch'
 *     e. compareDurations 'unknown'        -> 'found_duration_unknown'
 *
 * Canli short-circuit: cache okunmaz; mediaGuid/duration UI'da null gosterilir.
 */
export function decideMaterialStatus(input: MaterialStatusInput): MaterialStatusDecision {
  // 1. CANLI short-circuit — cache'i hic dikkate alma.
  if (isProvysLiveCategory({ category: input.category })) {
    return buildDecision('live_not_applicable');
  }

  // 2. DC kod yok — SSDB kapsami disi; alarm uretmez. CANLI ile ayni semantik.
  if (isBlankDcCode(input.dcCode)) {
    return buildDecision('dc_not_applicable');
  }

  // 3. Cache henuz yok (worker bakmadi).
  if (input.lookupStatus == null) {
    return buildDecision('unchecked');
  }

  // 4-6. Cache lookup status raw -> UI status haritasi.
  if (input.lookupStatus === 'ssdb_error')       return buildDecision('ssdb_error');
  if (input.lookupStatus === 'missing_material') return buildDecision('missing_material');
  if (input.lookupStatus === 'duration_unknown') return buildDecision('found_duration_unknown');

  // 7. lookupStatus === 'found' — duration karsilastirmasi.
  const ssdbOk =
    typeof input.ssdbDurationFrames === 'number' && Number.isFinite(input.ssdbDurationFrames);
  const provysOk =
    typeof input.provysDurationFrames === 'number' && Number.isFinite(input.provysDurationFrames);

  if (!ssdbOk || !provysOk) {
    return buildDecision('found_duration_unknown');
  }

  const cmp = compareDurations(
    input.provysDurationFrames,
    input.ssdbDurationFrames,
    DEFAULT_TOLERANCE_FRAMES,
  );
  if (cmp === 'equal')    return buildDecision('found_match');
  if (cmp === 'mismatch') return buildDecision('found_duration_mismatch');
  return buildDecision('found_duration_unknown');
}
