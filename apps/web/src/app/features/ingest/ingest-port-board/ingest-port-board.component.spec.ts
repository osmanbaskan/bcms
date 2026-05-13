import { IngestPortBoardComponent } from './ingest-port-board.component';

/**
 * 2026-05-14: titleLines parser unit testleri.
 *
 * Kapsam:
 *   - "vs" UI'da gözükmez; takım adları ayrı satır.
 *   - Trailing "(yedek)" ayrı satır (case-insensitive normalize).
 *   - "A-B" gibi boşluksuz tire bölünmez (mevcut davranış korunur).
 *   - Tek-takım fallback bozulmaz.
 *
 * Component constructor'da DI yok → `new IngestPortBoardComponent()`
 * ile direct instance; TestBed gerek değil.
 */
describe('IngestPortBoardComponent.titleLines', () => {
  let cmp: IngestPortBoardComponent;

  beforeEach(() => {
    cmp = new IngestPortBoardComponent();
  });

  it('"A vs B" → ["A", "B"]', () => {
    expect(cmp.titleLines('A vs B')).toEqual(['A', 'B']);
  });

  it('"A VS B" case-insensitive → ["A", "B"]', () => {
    expect(cmp.titleLines('A VS B')).toEqual(['A', 'B']);
  });

  it('"A - B" → ["A", "B"]', () => {
    expect(cmp.titleLines('A - B')).toEqual(['A', 'B']);
  });

  it('"A vs B (yedek)" → ["A", "B", "(yedek)"]', () => {
    expect(cmp.titleLines('A vs B (yedek)')).toEqual(['A', 'B', '(yedek)']);
  });

  it('"A - B (yedek)" → ["A", "B", "(yedek)"]', () => {
    expect(cmp.titleLines('A - B (yedek)')).toEqual(['A', 'B', '(yedek)']);
  });

  it('"Tek Başlık (yedek)" → ["Tek Başlık", "(yedek)"]', () => {
    expect(cmp.titleLines('Tek Başlık (yedek)')).toEqual(['Tek Başlık', '(yedek)']);
  });

  it('"Tek Başlık" fallback → ["Tek Başlık"]', () => {
    expect(cmp.titleLines('Tek Başlık')).toEqual(['Tek Başlık']);
  });

  it('"A-B" boşluksuz tire bölünmez → ["A-B"]', () => {
    expect(cmp.titleLines('A-B')).toEqual(['A-B']);
  });

  it('"Davis Cup" (kelime parçası "vs" yok) → ["Davis Cup"]', () => {
    expect(cmp.titleLines('Davis Cup')).toEqual(['Davis Cup']);
  });

  it('"A - B (YEDEK)" trailing case-insensitive normalize', () => {
    expect(cmp.titleLines('A - B (YEDEK)')).toEqual(['A', 'B', '(yedek)']);
  });

  it('empty string → [""] (defansif fallback)', () => {
    expect(cmp.titleLines('')).toEqual(['']);
  });
});
