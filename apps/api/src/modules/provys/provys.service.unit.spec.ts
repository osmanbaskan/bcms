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

  it('plans deletes for items missing from new parse', () => {
    const parsed = [p({ eventId: 'A' })];
    const existing = [
      { id: 10, eventId: 'A',   payloadHash: computeHash(parsed[0]) },
      { id: 20, eventId: 'OLD', payloadHash: 'whatever' },
    ];
    const diff = buildDiff('beinsports1', DATE, '/f.bxf', mtime, parsed, existing);
    expect(diff.toCreate).toHaveLength(0);
    expect(diff.toDeleteIds).toEqual([20]);
  });

  it('plans updates only when payloadHash differs', () => {
    const itemA = p({ eventId: 'A', title: 'Original' });
    const itemB = p({ eventId: 'B', sequence: 1, title: 'B-Original' });
    const existing = [
      { id: 1, eventId: 'A', payloadHash: computeHash(itemA) },
      { id: 2, eventId: 'B', payloadHash: 'stale-hash' },
    ];
    const diff = buildDiff('beinsports1', DATE, '/f.bxf', mtime, [itemA, itemB], existing);
    expect(diff.toUpdate.map((u) => u.id)).toEqual([2]);
  });

  it('is idempotent when same input produces same hashes', () => {
    const a = p({ eventId: 'A' });
    const b = p({ eventId: 'B', sequence: 1 });
    const existing = [
      { id: 1, eventId: 'A', payloadHash: computeHash(a) },
      { id: 2, eventId: 'B', payloadHash: computeHash(b) },
    ];
    const diff = buildDiff('beinsports1', DATE, '/f.bxf', mtime, [a, b], existing);
    expect(diff.toCreate).toEqual([]);
    expect(diff.toUpdate).toEqual([]);
    expect(diff.toDeleteIds).toEqual([]);
  });

  it('mixes insert + update + delete in one diff', () => {
    const stay   = p({ eventId: 'STAY' });
    const change = p({ eventId: 'CHANGE', title: 'New title' });
    const fresh  = p({ eventId: 'FRESH',  sequence: 2 });
    const existing = [
      { id: 1, eventId: 'STAY',   payloadHash: computeHash(stay) },
      { id: 2, eventId: 'CHANGE', payloadHash: 'stale' },
      { id: 3, eventId: 'GONE',   payloadHash: 'whatever' },
    ];
    const diff = buildDiff('beinsports1', DATE, '/f.bxf', mtime, [stay, change, fresh], existing);
    expect(diff.toCreate.map((c) => c.eventId)).toEqual(['FRESH']);
    expect(diff.toUpdate.map((u) => u.id)).toEqual([2]);
    expect(diff.toDeleteIds).toEqual([3]);
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
