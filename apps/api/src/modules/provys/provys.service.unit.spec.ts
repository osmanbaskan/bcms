import { describe, it, expect } from 'vitest';
import { __internals__ } from './provys.service.js';
import type { ParsedItem } from './provys.parser.js';
import type { ProvysCategory } from '@bcms/shared';

const { buildDiff, computeHash, groupByScheduleDate } = __internals__;

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

describe('provys.service › buildDiff (channel + scheduleDate scope)', () => {
  const mtime = new Date('2026-02-17T17:00:00Z');
  const DATE = '2026-02-17';

  it('plans creates for items not in DB', () => {
    const parsed = [p({ eventId: 'A' }), p({ eventId: 'B', sequence: 1 })];
    const diff = buildDiff('beinsports1', DATE, '/f.bxf', mtime, parsed, []);
    expect(diff.toCreate).toHaveLength(2);
    expect(diff.toCreate[0]).toMatchObject({
      channelSlug: 'beinsports1',
      eventId: 'A',
    });
    // scheduleDate Date olarak yazılır (UTC midnight).
    expect((diff.toCreate[0] as { scheduleDate: Date }).scheduleDate.toISOString().slice(0, 10)).toBe(DATE);
  });

  it('plans deletes for items missing from new parse — but ONLY if sourceFile matches current', () => {
    const parsed = [p({ eventId: 'A' })];
    const FILE = '/f.bxf';
    const existing = [
      { id: 10, eventId: 'A',   payloadHash: computeHash(parsed[0]), sourceFile: FILE },
      { id: 20, eventId: 'OLD', payloadHash: 'whatever',             sourceFile: FILE },
    ];
    const diff = buildDiff('beinsports1', DATE, FILE, mtime, parsed, existing);
    expect(diff.toCreate).toHaveLength(0);
    expect(diff.toDeleteIds).toEqual([20]);
  });

  it('plans updates when payloadHash differs OR sourceFile differs', () => {
    const itemA = p({ eventId: 'A', title: 'Original' });
    const itemB = p({ eventId: 'B', sequence: 1, title: 'B-Original' });
    const itemC = p({ eventId: 'C', sequence: 2 });
    const FILE = '/current.bxf';
    const existing = [
      { id: 1, eventId: 'A', payloadHash: computeHash(itemA), sourceFile: FILE },          // unchanged
      { id: 2, eventId: 'B', payloadHash: 'stale-hash',        sourceFile: FILE },          // hash diff
      { id: 3, eventId: 'C', payloadHash: computeHash(itemC), sourceFile: '/other.bxf' },  // sourceFile diff
    ];
    const diff = buildDiff('beinsports1', DATE, FILE, mtime, [itemA, itemB, itemC], existing);
    expect(diff.toUpdate.map((u) => u.id).sort()).toEqual([2, 3]);
  });

  it('is idempotent when same input + same sourceFile produces same hashes', () => {
    const a = p({ eventId: 'A' });
    const b = p({ eventId: 'B', sequence: 1 });
    const FILE = '/f.bxf';
    const existing = [
      { id: 1, eventId: 'A', payloadHash: computeHash(a), sourceFile: FILE },
      { id: 2, eventId: 'B', payloadHash: computeHash(b), sourceFile: FILE },
    ];
    const diff = buildDiff('beinsports1', DATE, FILE, mtime, [a, b], existing);
    expect(diff.toCreate).toEqual([]);
    expect(diff.toUpdate).toEqual([]);
    expect(diff.toDeleteIds).toEqual([]);
  });

  it('mixes insert + update + delete in one diff (single sourceFile)', () => {
    const stay   = p({ eventId: 'STAY' });
    const change = p({ eventId: 'CHANGE', title: 'New title' });
    const fresh  = p({ eventId: 'FRESH',  sequence: 2 });
    const FILE = '/f.bxf';
    const existing = [
      { id: 1, eventId: 'STAY',   payloadHash: computeHash(stay), sourceFile: FILE },
      { id: 2, eventId: 'CHANGE', payloadHash: 'stale',           sourceFile: FILE },
      { id: 3, eventId: 'GONE',   payloadHash: 'whatever',        sourceFile: FILE },
    ];
    const diff = buildDiff('beinsports1', DATE, FILE, mtime, [stay, change, fresh], existing);
    expect(diff.toCreate.map((c) => c.eventId)).toEqual(['FRESH']);
    expect(diff.toUpdate.map((u) => u.id)).toEqual([2]);
    expect(diff.toDeleteIds).toEqual([3]);
  });

  it('DELETE is sourceFile-scoped — other sources for the same channel+date are NOT deleted', () => {
    // xSNW_20260521 dosyası parse edildiğinde 22 Mayıs grubunda yalnız o
    // dosyaya ait olmayan event'leri eklesin/güncellesin; aynı (channel, date)
    // için xSNW_20260522 dosyasından gelmiş satırlara DOKUNMASIN.
    const newFromCurrent = p({ eventId: 'A' });
    const CURRENT = '/xSNW_20260521.bxf';
    const OTHER   = '/xSNW_20260522.bxf';
    const existing = [
      // Diğer dosyadan gelen satır; parsed'de yok ama silinmemeli.
      { id: 100, eventId: 'OTHER1', payloadHash: 'x', sourceFile: OTHER },
      { id: 101, eventId: 'OTHER2', payloadHash: 'x', sourceFile: OTHER },
      // Current dosyadan gelmiş eski satır; parsed'de yok → silinmeli.
      { id: 200, eventId: 'CURRENT_GONE', payloadHash: 'y', sourceFile: CURRENT },
    ];
    const diff = buildDiff('beinhaber', DATE, CURRENT, mtime, [newFromCurrent], existing);
    expect(diff.toCreate.map((c) => c.eventId)).toEqual(['A']);
    expect(diff.toDeleteIds).toEqual([200]);
    // OTHER1/OTHER2 korunmalı.
    expect(diff.toDeleteIds).not.toContain(100);
    expect(diff.toDeleteIds).not.toContain(101);
  });

  it('UPDATE captures sourceFile takeover (same eventId reappears in another file)', () => {
    // Aynı eventId iki dosyada görünürse son işlenen dosya kazanır:
    // existing.sourceFile=OTHER, current=THIS → UPDATE (sourceFile takeover).
    const item = p({ eventId: 'SHARED' });
    const THIS  = '/this.bxf';
    const OTHER = '/other.bxf';
    const existing = [
      { id: 7, eventId: 'SHARED', payloadHash: computeHash(item), sourceFile: OTHER },
    ];
    const diff = buildDiff('beinhaber', DATE, THIS, mtime, [item], existing);
    // Hash aynı ama sourceFile farklı → UPDATE
    expect(diff.toUpdate.map((u) => u.id)).toEqual([7]);
    expect(diff.toDeleteIds).toEqual([]);
    expect(diff.toCreate).toEqual([]);
  });
});

describe('provys.service › groupByScheduleDate', () => {
  it('partitions parsed items by scheduleDate (genelde tek grup)', () => {
    const items = [
      p({ eventId: 'A', scheduleDate: '2026-02-17' }),
      p({ eventId: 'B', scheduleDate: '2026-02-17', sequence: 1 }),
      p({ eventId: 'C', scheduleDate: '2026-02-18', sequence: 2 }),
    ];
    const map = groupByScheduleDate(items);
    expect(map.size).toBe(2);
    expect(map.get('2026-02-17')?.map((i) => i.eventId)).toEqual(['A', 'B']);
    expect(map.get('2026-02-18')?.map((i) => i.eventId)).toEqual(['C']);
  });
});

describe('provys.service › computeHash', () => {
  it('is stable for the same input', () => {
    expect(computeHash(p({}))).toBe(computeHash(p({})));
  });

  it('differs when any tracked field changes (including scheduleDate)', () => {
    const base = p({});
    expect(computeHash(base)).not.toBe(computeHash(p({ scheduleDate: '2026-02-18' })));
    expect(computeHash(base)).not.toBe(computeHash(p({ title: 'Other' })));
    expect(computeHash(base)).not.toBe(computeHash(p({ category: 'PROGRAM' })));
    expect(computeHash(base)).not.toBe(computeHash(p({ durationMs: 100 })));
    expect(computeHash(base)).not.toBe(computeHash(p({ sequence: 5 })));
  });
});
