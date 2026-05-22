import type { ParsedItem } from './provys.parser.js';

/**
 * Provys çoklu-BXF "latest-wins coverage merge" composer.
 *
 * Aynı `(channel, scheduleDate)` için birden fazla BXF dosyası olabiliyor
 * (revize, gece yarısı taşması, partial update). Her dosyanın o güne ait
 * event'leri kendi `[firstEventStart, lastEventEnd]` saat penceresini
 * tanımlar. Yeni dosya bu pencere içinde tek kaynak; eski dosya yalnız
 * dışarıdaki saat aralıklarını doldurur.
 *
 * Sözleşme:
 *   - "Yeni" = `sourceMtime desc`; eşitlikte `sourceFile desc` (lexicographic).
 *   - Coverage window: o source'tan target scheduleDate'e düşen
 *     event'lerin `min(startAt)` → `max(startAt + durationMs)` aralığı.
 *     `durationMs` null ise event sadece kendi `startAt` anını kaplar.
 *   - Sequence file-scoped; global akış DEĞİL. composeFinalSnapshot'ın
 *     döndürdüğü final liste `startAt asc, startTimecode asc, sourceFile
 *     asc, sequence asc` ile sıralanır.
 *   - Aynı eventId iki source'ta varsa daha yeni source kazanır (covered
 *     check'ten önce `seenEventIds` ile güvene alınır).
 *   - Pure: I/O yok; parser çıktısı + meta veri alır, deterministic dönüş.
 */

export interface SnapshotSource {
  sourceFile: string;
  sourceMtime: Date;
  /**
   * Bu source'un parser çıktısı. composeFinalSnapshot sadece
   * `item.scheduleDate === targetDate` olanları kullanır; geri kalanı
   * harici tutar (caller başka gün için ayrı compose çağırır).
   */
  items: ParsedItem[];
}

export interface SnapshotRow {
  sourceFile: string;
  sourceMtime: Date;
  item: ParsedItem;
}

interface Interval {
  startMs: number;
  /** Yarı açık [startMs, endMs): event startAt'i endMs eşit/üstündeyse covered DEĞİL. */
  endMs: number;
}

/**
 * Bir source'un target scheduleDate için coverage penceresi.
 * Hiç ilgili event yoksa `null`. `durationMs` null event'lerde end = start
 * (single instant); bu sayede zero-length event'ler diğer source'ları
 * bloklamaz.
 */
export function deriveCoverageWindow(
  items: ReadonlyArray<ParsedItem>,
  scheduleDate: string,
): Interval | null {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  let hit = false;
  for (const it of items) {
    if (it.scheduleDate !== scheduleDate) continue;
    hit = true;
    const s = it.startAt.getTime();
    const e = it.durationMs != null ? s + it.durationMs : s;
    if (s < startMs) startMs = s;
    if (e > endMs) endMs = e;
  }
  if (!hit) return null;
  return { startMs, endMs };
}

function isCovered(startMs: number, intervals: ReadonlyArray<Interval>): boolean {
  for (const iv of intervals) {
    if (startMs >= iv.startMs && startMs < iv.endMs) return true;
  }
  return false;
}

/**
 * Sources newest-first sıralanır; her source'un coverage window'u
 * accumulator'a eklenir. Sonraki (daha eski) source'tan yalnız
 * `startAt` covered DEĞİL olan event'ler final'e geçer.
 *
 * Final stable sort: `startAt asc → startTimecode asc → sourceFile asc →
 * sequence asc`. Aynı saniyede birden çok event timecode frame'ine göre,
 * aynı timecode'da source filename'e göre, aynı source içinde file-scope
 * sequence ile deterministic.
 */
export function composeFinalSnapshot(
  sources: ReadonlyArray<SnapshotSource>,
  scheduleDate: string,
): SnapshotRow[] {
  const ordered = [...sources].sort((a, b) => {
    const dt = b.sourceMtime.getTime() - a.sourceMtime.getTime();
    if (dt !== 0) return dt;
    return b.sourceFile.localeCompare(a.sourceFile);
  });

  const covered: Interval[] = [];
  const seenEventIds = new Set<string>();
  const out: SnapshotRow[] = [];

  for (const src of ordered) {
    const win = deriveCoverageWindow(src.items, scheduleDate);
    if (!win) continue;

    for (const it of src.items) {
      if (it.scheduleDate !== scheduleDate) continue;
      if (seenEventIds.has(it.eventId)) continue;
      const s = it.startAt.getTime();
      if (isCovered(s, covered)) continue;
      out.push({ sourceFile: src.sourceFile, sourceMtime: src.sourceMtime, item: it });
      seenEventIds.add(it.eventId);
    }

    covered.push(win);
  }

  out.sort((a, b) => {
    const at = a.item.startAt.getTime() - b.item.startAt.getTime();
    if (at !== 0) return at;
    const atc = (a.item.startTimecode ?? '').localeCompare(b.item.startTimecode ?? '');
    if (atc !== 0) return atc;
    const sf = a.sourceFile.localeCompare(b.sourceFile);
    if (sf !== 0) return sf;
    return a.item.sequence - b.item.sequence;
  });

  return out;
}
