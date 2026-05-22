import { describe, it, expect } from 'vitest';
import type { ParsedItem } from './provys.parser.js';
import type { ProvysCategory } from '@bcms/shared';
import {
  composeFinalSnapshot,
  deriveCoverageWindow,
  type SnapshotSource,
} from './provys.snapshot.js';

const DAY = '2026-05-23';
const PREV = '2026-05-22';

function item(over: Partial<ParsedItem>): ParsedItem {
  return {
    eventId: 'E',
    scheduleDate: DAY,
    sequence: 0,
    startAt: new Date(`${DAY}T08:00:00Z`),
    durationMs: 60_000,
    startTimecode: '08:00:00:00',
    durationTimecode: '00:01:00:00',
    frameRate: 25,
    dcCode: null,
    title: 'X',
    rawKind: 'Program',
    category: 'PROGRAM' as ProvysCategory,
    ...over,
  };
}

function source(
  sourceFile: string,
  sourceMtimeIso: string,
  items: ParsedItem[],
): SnapshotSource {
  return { sourceFile, sourceMtime: new Date(sourceMtimeIso), items };
}

describe('provys.snapshot › deriveCoverageWindow', () => {
  it('returns min start → max (start+duration) for items in target date', () => {
    const items = [
      item({ eventId: 'A', startAt: new Date(`${DAY}T10:00:00Z`), durationMs: 30 * 60_000 }),
      item({ eventId: 'B', startAt: new Date(`${DAY}T14:00:00Z`), durationMs: 60 * 60_000 }),
    ];
    const w = deriveCoverageWindow(items, DAY)!;
    expect(new Date(w.startMs).toISOString()).toBe(`${DAY}T10:00:00.000Z`);
    expect(new Date(w.endMs).toISOString()).toBe(`${DAY}T15:00:00.000Z`);
  });

  it('null durationMs → end = start (single instant)', () => {
    const items = [
      item({ eventId: 'A', startAt: new Date(`${DAY}T10:00:00Z`), durationMs: null }),
    ];
    const w = deriveCoverageWindow(items, DAY)!;
    expect(w.startMs).toBe(w.endMs);
  });

  it('returns null when no item matches scheduleDate', () => {
    const items = [item({ eventId: 'A', scheduleDate: PREV })];
    expect(deriveCoverageWindow(items, DAY)).toBeNull();
  });

  it('ignores items belonging to other scheduleDates', () => {
    const items = [
      item({ eventId: 'OUT', scheduleDate: PREV, startAt: new Date(`${PREV}T05:00:00Z`) }),
      item({ eventId: 'IN', startAt: new Date(`${DAY}T12:00:00Z`), durationMs: 60_000 }),
    ];
    const w = deriveCoverageWindow(items, DAY)!;
    expect(new Date(w.startMs).toISOString()).toBe(`${DAY}T12:00:00.000Z`);
    expect(new Date(w.endMs).toISOString()).toBe(`${DAY}T12:01:00.000Z`);
  });
});

describe('provys.snapshot › composeFinalSnapshot — latest-wins coverage merge', () => {
  it('newer file whose window encompasses older fully replaces it', () => {
    // newer covers [02:00 → 22:01); older's events at 06:00 / 18:00 fall
    // inside that window → both dropped.
    const older = source('A.bxf', '2026-05-23T08:00:00Z', [
      item({ eventId: 'O_06', startAt: new Date(`${DAY}T06:00:00Z`) }),
      item({ eventId: 'O_18', startAt: new Date(`${DAY}T18:00:00Z`) }),
    ]);
    const newer = source('B.bxf', '2026-05-23T10:00:00Z', [
      item({ eventId: 'N_02', startAt: new Date(`${DAY}T02:00:00Z`) }),
      item({ eventId: 'N_22', startAt: new Date(`${DAY}T22:00:00Z`) }),
    ]);
    const out = composeFinalSnapshot([older, newer], DAY);
    expect(out.map((r) => r.item.eventId)).toEqual(['N_02', 'N_22']);
  });

  it('coverage cut is data-driven (15:55 partial revision, not noon)', () => {
    // Regression guard: kesim saati event'lerden türevdir, sabit 12:00 değil.
    // Older 04 saat dilimine yayılı; newer 15:55'te başlayıp 23:00'a uzanıyor.
    // Beklenen final:
    //   - older 00:00 ve 10:00 dışarıda → kalır
    //   - older 16:00 ve 22:00 newer [15:55, 23:01) penceresi içinde → düşer
    //   - newer 15:55, 18:00, 23:00 → kalır
    const older = source('OLD.bxf', '2026-05-23T03:00:00Z', [
      item({ eventId: 'OLD_00', startAt: new Date(`${DAY}T00:00:00Z`), durationMs: 60_000 }),
      item({ eventId: 'OLD_10', startAt: new Date(`${DAY}T10:00:00Z`), durationMs: 60_000 }),
      item({ eventId: 'OLD_16', startAt: new Date(`${DAY}T16:00:00Z`), durationMs: 60_000 }),
      item({ eventId: 'OLD_22', startAt: new Date(`${DAY}T22:00:00Z`), durationMs: 60_000 }),
    ]);
    const newer = source('NEW.bxf', '2026-05-23T15:30:00Z', [
      item({ eventId: 'NEW_1555', startAt: new Date(`${DAY}T15:55:00Z`), durationMs: 60_000 }),
      item({ eventId: 'NEW_18',   startAt: new Date(`${DAY}T18:00:00Z`), durationMs: 60_000 }),
      item({ eventId: 'NEW_23',   startAt: new Date(`${DAY}T23:00:00Z`), durationMs: 60_000 }),
    ]);
    const out = composeFinalSnapshot([older, newer], DAY);
    const ids = out.map((r) => r.item.eventId);
    expect(ids).toEqual(['OLD_00', 'OLD_10', 'NEW_1555', 'NEW_18', 'NEW_23']);
    // Yanlışlıkla 12:00 kesim olsaydı OLD_16 ve OLD_22 düşer + OLD_10 düşmemeli;
    // bu test 12:00 hardcode bir mantığı yakalardı (OLD_10 still in / OLD_16
    // dropped iki ucu birden tutturma garantisi).
  });

  it('newer partial-day fills its own window; older fills outside (user example)', () => {
    // Eski: 00:00-24:00, yeni: 12:00-24:00 → 00:00-12:00 eski, 12:00-24:00 yeni
    const older = source('OLD.bxf', '2026-05-23T08:00:00Z', [
      item({ eventId: 'OLD_06', startAt: new Date(`${DAY}T06:00:00Z`), durationMs: 60 * 60_000 }),
      item({ eventId: 'OLD_15', startAt: new Date(`${DAY}T15:00:00Z`), durationMs: 60 * 60_000 }),
    ]);
    const newer = source('NEW.bxf', '2026-05-23T11:30:00Z', [
      item({ eventId: 'NEW_12', startAt: new Date(`${DAY}T12:00:00Z`), durationMs: 30 * 60_000 }),
      item({ eventId: 'NEW_23', startAt: new Date(`${DAY}T23:30:00Z`), durationMs: 30 * 60_000 }),
    ]);
    const out = composeFinalSnapshot([older, newer], DAY);
    const ids = out.map((r) => r.item.eventId);
    expect(ids).toContain('OLD_06');     // 06:00 < newer.start (12:00) → kept
    expect(ids).not.toContain('OLD_15'); // 15:00 newer window içinde → kaldırıldı
    expect(ids).toContain('NEW_12');
    expect(ids).toContain('NEW_23');
  });

  it('previous-day file contributes after-midnight events outside newer window', () => {
    // Önceki gün dosyası gece yarısı sonrası event'leri ile bu güne katkı yapar.
    // Yeni günün dosyası 00:30 sonrası kapsar; eski dosya 00:25 olayını korur.
    const prevDayFile = source('PREV.bxf', '2026-05-22T23:00:00Z', [
      item({ eventId: 'CARRY_0025', startAt: new Date(`${DAY}T00:25:00Z`), durationMs: 60_000 }),
    ]);
    const todayFile = source('TODAY.bxf', '2026-05-23T00:30:00Z', [
      item({ eventId: 'TODAY_0030', startAt: new Date(`${DAY}T00:30:00Z`), durationMs: 60_000 }),
      item({ eventId: 'TODAY_LATE', startAt: new Date(`${DAY}T22:00:00Z`), durationMs: 60_000 }),
    ]);
    const out = composeFinalSnapshot([prevDayFile, todayFile], DAY);
    const ids = out.map((r) => r.item.eventId);
    expect(ids).toEqual(['CARRY_0025', 'TODAY_0030', 'TODAY_LATE']);
  });

  it('older revision events overlapping newer window get removed', () => {
    const olderRev = source('REV_OLD.bxf', '2026-05-23T05:00:00Z', [
      item({ eventId: 'X1', startAt: new Date(`${DAY}T10:00:00Z`), durationMs: 60_000 }),
      item({ eventId: 'X2', startAt: new Date(`${DAY}T14:00:00Z`), durationMs: 60_000 }),
    ]);
    const newerRev = source('REV_NEW.bxf', '2026-05-23T09:00:00Z', [
      item({ eventId: 'X3', startAt: new Date(`${DAY}T09:00:00Z`), durationMs: 6 * 60 * 60_000 }),
    ]);
    const out = composeFinalSnapshot([olderRev, newerRev], DAY);
    // newer covers 09:00 → 15:00; older's 10:00 + 14:00 fall inside → both removed.
    expect(out.map((r) => r.item.eventId)).toEqual(['X3']);
  });

  it('final sort: startAt asc → startTimecode asc → sequence asc (single-source)', () => {
    // Aynı source içinde sequence 9 başlangıçta olsa bile final akış
    // startAt + timecode ile sıralanır. Aynı startAt'te timecode frame
    // ayırıcıdır (09:00:00:00 < 09:00:00:03).
    const single = source('S.bxf', '2026-05-23T05:00:00Z', [
      item({
        eventId: 'X_0900_00',
        startAt: new Date(`${DAY}T09:00:00Z`),
        startTimecode: '09:00:00:00',
        sequence: 5,
      }),
      item({
        eventId: 'X_0900_03',
        startAt: new Date(`${DAY}T09:00:00Z`),
        startTimecode: '09:00:00:03',
        sequence: 4,
      }),
      item({
        eventId: 'X_0800',
        startAt: new Date(`${DAY}T08:00:00Z`),
        startTimecode: '08:00:00:00',
        sequence: 9, // en yüksek sequence ama startAt en erken → ilk gelmeli
      }),
    ]);
    const out = composeFinalSnapshot([single], DAY);
    expect(out.map((r) => r.item.eventId)).toEqual(['X_0800', 'X_0900_00', 'X_0900_03']);
  });

  it('same eventId in two sources → newer source wins; older skipped even if outside window', () => {
    // Newer source attributes the row to itself; older's duplicate eventId
    // is deduped regardless of window.
    const older = source('OLD.bxf', '2026-05-23T05:00:00Z', [
      item({ eventId: 'SHARED', startAt: new Date(`${DAY}T03:00:00Z`) }),
    ]);
    const newer = source('NEW.bxf', '2026-05-23T08:00:00Z', [
      item({ eventId: 'SHARED', startAt: new Date(`${DAY}T20:00:00Z`) }),
    ]);
    const out = composeFinalSnapshot([older, newer], DAY);
    expect(out).toHaveLength(1);
    expect(out[0].sourceFile).toBe('NEW.bxf');
    expect(out[0].item.startAt.toISOString()).toBe(`${DAY}T20:00:00.000Z`);
  });

  it('mtime tie → sourceFile lexicographic desc wins (deterministic)', () => {
    const a = source('A.bxf', '2026-05-23T10:00:00Z', [
      item({ eventId: 'FROM_A', startAt: new Date(`${DAY}T12:00:00Z`), durationMs: 60_000 }),
    ]);
    const b = source('B.bxf', '2026-05-23T10:00:00Z', [
      item({ eventId: 'FROM_B', startAt: new Date(`${DAY}T12:00:00Z`), durationMs: 60_000 }),
    ]);
    const out = composeFinalSnapshot([a, b], DAY);
    // B > A lexicographic → B is "newer" by tie-break → FROM_B wins;
    // A's 12:00 falls inside B's window so FROM_A is dropped.
    expect(out.map((r) => r.item.eventId)).toEqual(['FROM_B']);
  });

  it('empty source list → empty output', () => {
    expect(composeFinalSnapshot([], DAY)).toEqual([]);
  });

  it('attributes sourceFile/sourceMtime per row from the winning source', () => {
    const older = source('OLD.bxf', '2026-05-23T05:00:00Z', [
      item({ eventId: 'KEEP', startAt: new Date(`${DAY}T06:00:00Z`) }),
    ]);
    const newer = source('NEW.bxf', '2026-05-23T11:00:00Z', [
      item({ eventId: 'TAKE', startAt: new Date(`${DAY}T15:00:00Z`) }),
    ]);
    const out = composeFinalSnapshot([older, newer], DAY);
    const byId = new Map(out.map((r) => [r.item.eventId, r]));
    expect(byId.get('KEEP')?.sourceFile).toBe('OLD.bxf');
    expect(byId.get('TAKE')?.sourceFile).toBe('NEW.bxf');
  });
});
