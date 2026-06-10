/**
 * Asrun-Merge saf fonksiyon testleri — zincir tespiti, canlı pencere
 * (erken bitiş / uzama / fallback), kırpma, isim zenginleştirme kararı.
 */
import { describe, it, expect } from 'vitest';
import {
  buildChains, sustainedChains, clusterIntervals, detectLiveWindow,
  subtractWindows, isTitleMissing, loadMergeOptions, type Interval,
} from './asrun-merge.service.js';

const MIN = 60_000;
const opts = { ...loadMergeOptions({} as NodeJS.ProcessEnv) }; // 2sn tol, 10dk zincir, 2 satır, 5dk küme, 1sn parça
const T0 = Date.parse('2026-06-09T00:00:00Z');
const at = (min: number) => T0 + min * MIN;
const iv = (s: number, e: number): Interval => ({ start: at(s), end: at(e) });

describe('buildChains', () => {
  it('boşluksuz satırlar tek zincir; tolerans üstü boşluk zinciri böler', () => {
    const chains = buildChains([iv(0, 10), iv(10, 25), { start: at(25) + 1500, end: at(40) }, iv(120, 130)], opts.gapToleranceMs);
    expect(chains).toHaveLength(2);
    expect(chains[0]).toMatchObject({ start: at(0), end: at(40), items: 3 }); // 1.5sn boşluk emildi
    expect(chains[1]).toMatchObject({ start: at(120), items: 1 });
  });
  it('sıfır süreli satır zincire girmez', () => {
    expect(buildChains([iv(5, 5), iv(6, 7)], opts.gapToleranceMs)).toHaveLength(1);
  });
});

describe('sustainedChains — yanlış alarm koruması', () => {
  it('kısa/tek satırlı zincir elenir (≥10dk + ≥2 satır)', () => {
    const chains = buildChains([iv(0, 5), iv(5, 8), iv(60, 100), iv(100, 130)], opts.gapToleranceMs);
    const s = sustainedChains(chains, opts);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ start: at(60), end: at(130) });
  });
});

describe('clusterIntervals — bitişik CANLI satırları tek blok', () => {
  it('≤5dk boşluklu CANLI satırlar birleşir (örn. 20:59 0dk + 21:02 83dk)', () => {
    const out = clusterIntervals([iv(0, 0), iv(3, 86), iv(200, 230)], opts.clusterGapMs);
    expect(out).toEqual([iv(0, 86), iv(200, 230)]);
  });
});

describe('detectLiveWindow', () => {
  // Plan: canlı 60–180 dk
  const plan = iv(60, 180);

  it('UZAMA: ilk sürdürülebilir zincir plandan SONRA başlar → bitiş uzar', () => {
    // canlı sırasında akış yok; 207. dk'da kesintisiz akış başlıyor
    const chains = sustainedChains(buildChains([iv(207, 230), iv(230, 260)], opts.gapToleranceMs), opts);
    const w = detectLiveWindow(plan, chains, Number.POSITIVE_INFINITY, opts);
    expect(w).toMatchObject({ start: at(60), end: at(207), startDetected: false, endDetected: true });
  });

  it('ERKEN BİTİŞ: zincir plan bitiminden önce başlar → pencere kısalır', () => {
    const chains = sustainedChains(buildChains([iv(150, 170), iv(170, 200)], opts.gapToleranceMs), opts);
    const w = detectLiveWindow(plan, chains, Number.POSITIVE_INFINITY, opts);
    expect(w).toMatchObject({ end: at(150), endDetected: true });
  });

  it('GEÇ BAŞLAMA (simetrik): planlı başlangıçta zincir hâlâ akıyor → start zincir bitince', () => {
    const chains = sustainedChains(
      buildChains([iv(30, 50), iv(50, 75), iv(220, 240), iv(240, 270)], opts.gapToleranceMs), opts);
    const w = detectLiveWindow(plan, chains, Number.POSITIVE_INFINITY, opts);
    expect(w).toMatchObject({ start: at(75), startDetected: true, end: at(220), endDetected: true });
  });

  it('FALLBACK: hiç zincir yok → plan sınırları + bayraklar false', () => {
    const w = detectLiveWindow(plan, [], Number.POSITIVE_INFINITY, opts);
    expect(w).toMatchObject({ start: at(60), end: at(180), startDetected: false, endDetected: false });
  });

  it('UFUK: ufuk ötesindeki zincir YOK sayılır → plan bitişine düşülür', () => {
    const chains = sustainedChains(buildChains([iv(400, 420), iv(420, 450)], opts.gapToleranceMs), opts);
    const w = detectLiveWindow(plan, chains, at(300), opts);
    expect(w.end).toBe(at(180));           // plan bitişi (zincir 400. dk'da ama ufuk 300)
    expect(w.endDetected).toBe(false);
  });

  it('UFUK: plan bitişi sonraki bloğa taşarsa ufka kırpılır', () => {
    const w = detectLiveWindow(plan, [], at(150), opts);
    expect(w.end).toBe(at(150));
  });
});

describe('subtractWindows — kırpma (1-a)', () => {
  const windows = [iv(60, 180)];
  it('kesişmeyen aynen kalır', () => {
    expect(subtractWindows(iv(0, 30), windows, opts.minSegmentMs)).toEqual([iv(0, 30)]);
  });
  it('tamamen içeride → boş (yayınlanmadı)', () => {
    expect(subtractWindows(iv(90, 120), windows, opts.minSegmentMs)).toEqual([]);
  });
  it('kısmi çakışma → dışarıdaki parça kalır', () => {
    expect(subtractWindows(iv(40, 90), windows, opts.minSegmentMs)).toEqual([iv(40, 60)]);
  });
  it('pencereyi KAPSAYAN uzun satır → iki parçaya bölünür', () => {
    expect(subtractWindows(iv(30, 200), windows, opts.minSegmentMs)).toEqual([iv(30, 60), iv(180, 200)]);
  });
  it('1sn altı kırıntı atılır', () => {
    const parts = subtractWindows({ start: at(60) - 500, end: at(90) }, windows, opts.minSegmentMs);
    expect(parts).toEqual([]);
  });
});

describe('isTitleMissing — isim zenginleştirme kararı', () => {
  it.each([
    ['', 'DC001', true],
    ['   ', 'DC001', true],
    ['DC001', 'DC001', true],
    ['dc001', 'DC001', true],
    ['Maç Özeti', 'DC001', false],
    ['Bir İsim', null, false],
  ])('title=%j dc=%j → %s', (t, dc, expected) => {
    expect(isTitleMissing(t, dc)).toBe(expected);
  });
  it('boş başlık + DC yok → yine isimsiz (ama zenginleştirilemez)', () => {
    expect(isTitleMissing('', null)).toBe(true);
  });
});

describe('loadMergeOptions', () => {
  it('defaultlar: 2sn tol · 10dk zincir · 2 satır · 5dk küme · 1sn parça', () => {
    expect(opts).toMatchObject({
      gapToleranceMs: 2_000, minChainMs: 600_000, minChainItems: 2,
      clusterGapMs: 300_000, minSegmentMs: 1_000,
    });
  });
  it('env override + geçersiz → fallback', () => {
    const o = loadMergeOptions({ ASRUN_MERGE_GAP_TOLERANCE_MS: '5000', ASRUN_MERGE_MIN_CHAIN_MS: '-1' } as unknown as NodeJS.ProcessEnv);
    expect(o.gapToleranceMs).toBe(5_000);
    expect(o.minChainMs).toBe(600_000);
  });
});
