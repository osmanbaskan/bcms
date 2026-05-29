import { describe, it, expect } from 'vitest';
import { __internals__ } from './provys.service.js';
import type { ParsedItem } from './provys.parser.js';
import type { SnapshotRow } from './provys.snapshot.js';
import type { ProvysCategory } from '@bcms/shared';

const { buildDiff, computeHash, selectCandidateFiles, previousIsoDate, nextIsoDate } = __internals__;

function p(overrides: Partial<ParsedItem>): ParsedItem {
  return {
    eventId: 'E1',
    scheduleDate: '2026-02-17',
    sequence: 0,
    startAt: new Date('2026-02-17T18:00:00Z'),
    durationMs: 30_000,
    startTimecode: null,
    durationTimecode: null,
    frameRate: null,
    dcCode: null,
    title: 'X',
    rawKind: 'COMMERCIAL',
    category: 'REKLAM' as ProvysCategory,
    ...overrides,
  };
}

function row(item: ParsedItem, sourceFile: string, mtimeIso = '2026-02-17T17:00:00Z'): SnapshotRow {
  return { sourceFile, sourceMtime: new Date(mtimeIso), item };
}

describe('provys.service › buildDiff (composed-snapshot scope)', () => {
  const DATE = '2026-02-17';
  const FILE = '/cur.bxf';

  it('plans INSERT for composed rows not in DB', () => {
    const a = p({ eventId: 'A' });
    const b = p({ eventId: 'B', sequence: 1 });
    const composed = [row(a, FILE), row(b, FILE)];
    const diff = buildDiff('beinsports1', DATE, composed, []);
    expect(diff.toCreate.map((c) => c.eventId)).toEqual(['A', 'B']);
    expect((diff.toCreate[0] as { scheduleDate: Date }).scheduleDate.toISOString().slice(0, 10)).toBe(DATE);
  });

  it('plans DELETE for existing rows whose eventId is NOT in composed snapshot', () => {
    // Composed final snapshot içinde A var, OLD yok → OLD silinmeli.
    // Yeni mantık: DELETE artık sourceFile-scoped DEĞİL; composed dışı her
    // existing satır silinir (eski revision overlap event'leri böyle düşer).
    const a = p({ eventId: 'A' });
    const composed = [row(a, FILE)];
    const existing = [
      { id: 10, eventId: 'A',   payloadHash: computeHash(a), sourceFile: FILE },
      { id: 20, eventId: 'OLD', payloadHash: 'whatever',     sourceFile: FILE },
      { id: 21, eventId: 'OLD_OTHER_SRC', payloadHash: 'x',  sourceFile: '/other.bxf' },
    ];
    const diff = buildDiff('beinsports1', DATE, composed, existing);
    expect(diff.toDeleteIds.sort()).toEqual([20, 21]);
    expect(diff.toCreate).toEqual([]);
  });

  it('plans UPDATE when payloadHash differs OR sourceFile takeover', () => {
    const a = p({ eventId: 'A', title: 'Original' });
    const b = p({ eventId: 'B', sequence: 1, title: 'B-Original' });
    const c = p({ eventId: 'C', sequence: 2 });
    const composed = [row(a, FILE), row(b, FILE), row(c, FILE)];
    const existing = [
      { id: 1, eventId: 'A', payloadHash: computeHash(a), sourceFile: FILE },          // unchanged
      { id: 2, eventId: 'B', payloadHash: 'stale-hash',    sourceFile: FILE },          // hash diff
      { id: 3, eventId: 'C', payloadHash: computeHash(c), sourceFile: '/other.bxf' },   // sourceFile takeover
    ];
    const diff = buildDiff('beinsports1', DATE, composed, existing);
    expect(diff.toUpdate.map((u) => u.id).sort()).toEqual([2, 3]);
  });

  it('is idempotent when composed input matches DB exactly', () => {
    const a = p({ eventId: 'A' });
    const b = p({ eventId: 'B', sequence: 1 });
    const composed = [row(a, FILE), row(b, FILE)];
    const existing = [
      { id: 1, eventId: 'A', payloadHash: computeHash(a), sourceFile: FILE },
      { id: 2, eventId: 'B', payloadHash: computeHash(b), sourceFile: FILE },
    ];
    const diff = buildDiff('beinsports1', DATE, composed, existing);
    expect(diff.toCreate).toEqual([]);
    expect(diff.toUpdate).toEqual([]);
    expect(diff.toDeleteIds).toEqual([]);
  });

  it('older revision event NOT in composed → DELETE (cross-source cleanup)', () => {
    // composeFinalSnapshot eski revision'ın overlap event'lerini düşürüyor;
    // service.buildDiff bunu DB'den silmeli. Bu yeni davranışın mihenk noktası.
    const newerRow = p({ eventId: 'NEW', startAt: new Date('2026-02-17T10:00:00Z') });
    const composed = [row(newerRow, '/new.bxf', '2026-02-17T12:00:00Z')];
    const existing = [
      { id: 99, eventId: 'OLD_OVERLAP', payloadHash: 'h', sourceFile: '/old.bxf' },
    ];
    const diff = buildDiff('beinsports1', DATE, composed, existing);
    expect(diff.toDeleteIds).toEqual([99]);
    expect(diff.toCreate.map((c) => c.eventId)).toEqual(['NEW']);
  });

  it('respects per-row sourceFile attribution from composed snapshot', () => {
    // composed satır başına sourceFile taşıyor — older satır 'OLD.bxf'ten
    // korunmuşsa INSERT'te OLD.bxf yazılmalı; newer satır 'NEW.bxf'ten
    // geldiyse o yazılmalı.
    const oldRow = p({ eventId: 'KEEP_OLD', startAt: new Date('2026-02-17T06:00:00Z') });
    const newRow = p({ eventId: 'TAKE_NEW', startAt: new Date('2026-02-17T15:00:00Z') });
    const composed = [
      row(oldRow, '/old.bxf', '2026-02-17T05:00:00Z'),
      row(newRow, '/new.bxf', '2026-02-17T11:30:00Z'),
    ];
    const diff = buildDiff('beinsports1', DATE, composed, []);
    const byEvent = new Map(diff.toCreate.map((c) => [c.eventId, c]));
    expect(byEvent.get('KEEP_OLD')?.sourceFile).toBe('/old.bxf');
    expect(byEvent.get('TAKE_NEW')?.sourceFile).toBe('/new.bxf');
  });
});

describe('provys.service › selectCandidateFiles', () => {
  const files = [
    { path: '/a/BXF_Playlist_LT4_20260523_x.bxf', fileCode: 'lt4', scheduleDate: '2026-05-23', mtime: new Date('2026-05-23T01:00:00Z') },
    { path: '/a/BXF_Playlist_LT4_20260522_x.bxf', fileCode: 'lt4', scheduleDate: '2026-05-22', mtime: new Date('2026-05-22T01:00:00Z') },
    { path: '/a/BXF_Playlist_LT4_20260521_x.bxf', fileCode: 'lt4', scheduleDate: '2026-05-21', mtime: new Date('2026-05-21T01:00:00Z') },
    { path: '/a/BXF_Playlist_LT2_20260523_x.bxf', fileCode: 'lt2', scheduleDate: '2026-05-23', mtime: new Date('2026-05-23T01:00:00Z') },
  ];

  it('keeps only target-date and previous-day files for the requested fileCode', () => {
    const sel = selectCandidateFiles(files, 'lt4', '2026-05-23');
    expect(sel.map((c) => c.path).sort()).toEqual([
      '/a/BXF_Playlist_LT4_20260522_x.bxf',
      '/a/BXF_Playlist_LT4_20260523_x.bxf',
    ]);
  });

  it('ignores files for other fileCodes', () => {
    const sel = selectCandidateFiles(files, 'lt4', '2026-05-23');
    expect(sel.some((c) => c.path.includes('LT2'))).toBe(false);
  });

  it('treats fileCode case-insensitively', () => {
    const sel = selectCandidateFiles(files, 'LT4', '2026-05-23');
    expect(sel.length).toBe(2);
  });

  it('accepts an array of fileCodes (canonical + aliases)', () => {
    const mixed = [
      ...files,
      { path: '/a/BXF_Playlist_xLT4_20260523_x.bxf', fileCode: 'xlt4', scheduleDate: '2026-05-23', mtime: new Date('2026-05-23T02:00:00Z') },
      { path: '/a/BXF_Playlist_xLT4_20260522_x.bxf', fileCode: 'xlt4', scheduleDate: '2026-05-22', mtime: new Date('2026-05-22T02:00:00Z') },
    ];
    const sel = selectCandidateFiles(mixed, ['lt4', 'xlt4'], '2026-05-23');
    expect(sel.map((c) => c.path).sort()).toEqual([
      '/a/BXF_Playlist_LT4_20260522_x.bxf',
      '/a/BXF_Playlist_LT4_20260523_x.bxf',
      '/a/BXF_Playlist_xLT4_20260522_x.bxf',
      '/a/BXF_Playlist_xLT4_20260523_x.bxf',
    ]);
  });

  it('with array codes, ignores files whose fileCode is not in the accepted set', () => {
    const sel = selectCandidateFiles(files, ['lt4', 'xlt4'], '2026-05-23');
    expect(sel.some((c) => c.path.includes('LT2'))).toBe(false);
  });

  it('returns empty when fileCodes is an empty array', () => {
    const sel = selectCandidateFiles(files, [], '2026-05-23');
    expect(sel).toEqual([]);
  });
});

describe('provys.service › previousIsoDate / nextIsoDate', () => {
  it('previousIsoDate', () => {
    expect(previousIsoDate('2026-05-23')).toBe('2026-05-22');
    expect(previousIsoDate('2026-03-01')).toBe('2026-02-28');
    expect(previousIsoDate('2026-01-01')).toBe('2025-12-31');
  });
  it('nextIsoDate', () => {
    expect(nextIsoDate('2026-05-22')).toBe('2026-05-23');
    expect(nextIsoDate('2026-02-28')).toBe('2026-03-01');
    expect(nextIsoDate('2025-12-31')).toBe('2026-01-01');
  });
});

describe('provys.service › computeHash', () => {
  it('is stable for the same input', () => {
    expect(computeHash(p({}))).toBe(computeHash(p({})));
  });

  it('differs when any tracked field changes', () => {
    const base = p({});
    expect(computeHash(base)).not.toBe(computeHash(p({ scheduleDate: '2026-02-18' })));
    expect(computeHash(base)).not.toBe(computeHash(p({ title: 'Other' })));
    expect(computeHash(base)).not.toBe(computeHash(p({ category: 'PROGRAM' })));
    expect(computeHash(base)).not.toBe(computeHash(p({ durationMs: 100 })));
    expect(computeHash(base)).not.toBe(computeHash(p({ sequence: 5 })));
  });
});
