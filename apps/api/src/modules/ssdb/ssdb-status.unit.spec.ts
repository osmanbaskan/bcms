import { describe, it, expect } from 'vitest';
import {
  decideMaterialStatus,
  isProvysLiveCategory,
  PROVYS_MATERIAL_STATUS_LABEL,
  type MaterialStatusInput,
  type ProvysMaterialStatus,
} from './ssdb-status.js';

/** Test fixture — defaults eshebir alan acikca override edilmedikce non-CANLI/no-DC senaryo. */
function buildInput(over: Partial<MaterialStatusInput>): MaterialStatusInput {
  return {
    category: 'PROGRAM',
    dcCode: 'DC00040962',
    lookupStatus: null,
    ssdbDurationFrames: null,
    provysDurationFrames: null,
    ...over,
  };
}

/** Beklenen status + label uyumunu tek noktadan kontrol eden assertion. */
function expectStatus(input: MaterialStatusInput, expected: ProvysMaterialStatus): void {
  const decision = decideMaterialStatus(input);
  expect(decision.materialStatus).toBe(expected);
  expect(decision.statusLabel).toBe(PROVYS_MATERIAL_STATUS_LABEL[expected]);
}

describe('ssdb-status > isProvysLiveCategory', () => {
  it('CANLI -> true', () => {
    expect(isProvysLiveCategory({ category: 'CANLI' })).toBe(true);
  });

  it('non-CANLI kategoriler -> false', () => {
    for (const c of ['PROGRAM', 'REKLAM', 'KAMU_SPOTU', 'TANITIM', 'DIGER']) {
      expect(isProvysLiveCategory({ category: c })).toBe(false);
    }
  });

  it('null / undefined / blank -> false (case-sensitive literal)', () => {
    expect(isProvysLiveCategory({ category: null })).toBe(false);
    expect(isProvysLiveCategory({ category: undefined })).toBe(false);
    expect(isProvysLiveCategory({ category: '' })).toBe(false);
    expect(isProvysLiveCategory({ category: 'canli' })).toBe(false);   // lowercase reddet
    expect(isProvysLiveCategory({ category: 'Canli' })).toBe(false);   // mixed case reddet
  });
});

describe('ssdb-status > decideMaterialStatus — CANLI short-circuit', () => {
  it('CANLI + dcCode null -> live_not_applicable (dc_not_applicable DEGIL)', () => {
    expectStatus(buildInput({ category: 'CANLI', dcCode: null }), 'live_not_applicable');
  });

  it('CANLI + dcCode dolu + cache yok -> live_not_applicable (unchecked DEGIL)', () => {
    expectStatus(
      buildInput({ category: 'CANLI', dcCode: 'DC00012345', lookupStatus: null }),
      'live_not_applicable',
    );
  });

  it('CANLI + cache found + duration mismatch -> live_not_applicable (cache yoksayilir)', () => {
    expectStatus(
      buildInput({
        category: 'CANLI',
        dcCode: 'DC00012345',
        lookupStatus: 'found',
        ssdbDurationFrames: 5000,
        provysDurationFrames: 4465,
      }),
      'live_not_applicable',
    );
  });

  it('CANLI + cache missing_material -> live_not_applicable (alarm UREMEZ)', () => {
    expectStatus(
      buildInput({
        category: 'CANLI',
        dcCode: 'DC00012345',
        lookupStatus: 'missing_material',
      }),
      'live_not_applicable',
    );
  });

  it('CANLI + cache ssdb_error -> live_not_applicable', () => {
    expectStatus(
      buildInput({ category: 'CANLI', dcCode: 'DC00012345', lookupStatus: 'ssdb_error' }),
      'live_not_applicable',
    );
  });
});

describe('ssdb-status > decideMaterialStatus — dc_not_applicable (SSDB kapsamı dışı)', () => {
  it('PROGRAM + dcCode null -> dc_not_applicable', () => {
    expectStatus(buildInput({ dcCode: null }), 'dc_not_applicable');
  });

  it('PROGRAM + dcCode empty string -> dc_not_applicable', () => {
    expectStatus(buildInput({ dcCode: '' }), 'dc_not_applicable');
  });

  it('PROGRAM + dcCode whitespace -> dc_not_applicable', () => {
    expectStatus(buildInput({ dcCode: '   ' }), 'dc_not_applicable');
    expectStatus(buildInput({ dcCode: '\t\n' }), 'dc_not_applicable');
  });
});

describe('ssdb-status > decideMaterialStatus — unchecked', () => {
  it('non-CANLI + dcCode var + lookupStatus null -> unchecked', () => {
    expectStatus(buildInput({ lookupStatus: null }), 'unchecked');
  });

  it('unchecked statusLabel "Kontrol bekliyor"', () => {
    const r = decideMaterialStatus(buildInput({ lookupStatus: null }));
    expect(r.statusLabel).toBe('Kontrol bekliyor');
  });
});

describe('ssdb-status > decideMaterialStatus — cache lookup branches', () => {
  it('lookupStatus ssdb_error -> ssdb_error', () => {
    expectStatus(buildInput({ lookupStatus: 'ssdb_error' }), 'ssdb_error');
  });

  it('lookupStatus missing_material -> missing_material', () => {
    expectStatus(buildInput({ lookupStatus: 'missing_material' }), 'missing_material');
  });

  it('lookupStatus duration_unknown -> found_duration_unknown', () => {
    expectStatus(buildInput({ lookupStatus: 'duration_unknown' }), 'found_duration_unknown');
  });
});

describe('ssdb-status > decideMaterialStatus — found + duration compare', () => {
  it('found + ssdb duration null -> found_duration_unknown', () => {
    expectStatus(
      buildInput({
        lookupStatus: 'found',
        ssdbDurationFrames: null,
        provysDurationFrames: 4465,
      }),
      'found_duration_unknown',
    );
  });

  it('found + provys duration null -> found_duration_unknown', () => {
    expectStatus(
      buildInput({
        lookupStatus: 'found',
        ssdbDurationFrames: 4465,
        provysDurationFrames: null,
      }),
      'found_duration_unknown',
    );
  });

  it('found + her ikisi NaN/Infinity -> found_duration_unknown', () => {
    expectStatus(
      buildInput({
        lookupStatus: 'found',
        ssdbDurationFrames: Number.NaN,
        provysDurationFrames: 4465,
      }),
      'found_duration_unknown',
    );
    expectStatus(
      buildInput({
        lookupStatus: 'found',
        ssdbDurationFrames: 4465,
        provysDurationFrames: Number.POSITIVE_INFINITY,
      }),
      'found_duration_unknown',
    );
  });

  it('found + equal durations -> found_match', () => {
    expectStatus(
      buildInput({
        lookupStatus: 'found',
        ssdbDurationFrames: 4465,
        provysDurationFrames: 4465,
      }),
      'found_match',
    );
  });

  it('found + 1 frame difference -> found_match (tolerance icinde)', () => {
    expectStatus(
      buildInput({
        lookupStatus: 'found',
        ssdbDurationFrames: 4465,
        provysDurationFrames: 4464,
      }),
      'found_match',
    );
    expectStatus(
      buildInput({
        lookupStatus: 'found',
        ssdbDurationFrames: 4465,
        provysDurationFrames: 4466,
      }),
      'found_match',
    );
  });

  it('found + 2 frame difference -> found_duration_mismatch', () => {
    expectStatus(
      buildInput({
        lookupStatus: 'found',
        ssdbDurationFrames: 4465,
        provysDurationFrames: 4463,
      }),
      'found_duration_mismatch',
    );
    expectStatus(
      buildInput({
        lookupStatus: 'found',
        ssdbDurationFrames: 4465,
        provysDurationFrames: 4467,
      }),
      'found_duration_mismatch',
    );
  });
});

describe('ssdb-status > PROVYS_MATERIAL_STATUS_LABEL — tum statuslerin TR karsiligi', () => {
  it('label map 8 status icin tam', () => {
    expect(PROVYS_MATERIAL_STATUS_LABEL.live_not_applicable).toBe('Canlı');
    expect(PROVYS_MATERIAL_STATUS_LABEL.dc_not_applicable).toBe('DC kod yok; SSDB MAM materyal kontrolü yapılmaz');
    expect(PROVYS_MATERIAL_STATUS_LABEL.unchecked).toBe('Kontrol bekliyor');
    expect(PROVYS_MATERIAL_STATUS_LABEL.missing_material).toBe('Materyal eksik');
    expect(PROVYS_MATERIAL_STATUS_LABEL.found_match).toBe('Materyal var');
    expect(PROVYS_MATERIAL_STATUS_LABEL.found_duration_mismatch).toBe('Materyal var, duration uymuyor');
    expect(PROVYS_MATERIAL_STATUS_LABEL.found_duration_unknown).toBe('Materyal var, süre yok');
    expect(PROVYS_MATERIAL_STATUS_LABEL.ssdb_error).toBe('SSDB hata');
  });

  it('decision.statusLabel her durumda label map ile birebir esitlenir', () => {
    // Her UI status icin en az bir karar dali; label-status drift olmasin.
    const cases: Array<[MaterialStatusInput, ProvysMaterialStatus]> = [
      [buildInput({ category: 'CANLI' }), 'live_not_applicable'],
      [buildInput({ dcCode: null }), 'dc_not_applicable'],
      [buildInput({ lookupStatus: null }), 'unchecked'],
      [buildInput({ lookupStatus: 'missing_material' }), 'missing_material'],
      [buildInput({ lookupStatus: 'ssdb_error' }), 'ssdb_error'],
      [buildInput({ lookupStatus: 'duration_unknown' }), 'found_duration_unknown'],
      [buildInput({ lookupStatus: 'found', ssdbDurationFrames: 4465, provysDurationFrames: 4465 }), 'found_match'],
      [buildInput({ lookupStatus: 'found', ssdbDurationFrames: 4465, provysDurationFrames: 4000 }), 'found_duration_mismatch'],
    ];
    for (const [input, expected] of cases) {
      const r = decideMaterialStatus(input);
      expect(r.materialStatus).toBe(expected);
      expect(r.statusLabel).toBe(PROVYS_MATERIAL_STATUS_LABEL[expected]);
    }
  });
});
