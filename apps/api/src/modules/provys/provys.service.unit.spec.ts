import { describe, it, expect } from 'vitest';
import { __internals__ } from './provys.service.js';
import type { ParsedItem } from './provys.parser.js';
import type { ProvysCategory } from '@bcms/shared';

const { buildDiff, computeHash } = __internals__;

function p(overrides: Partial<ParsedItem>): ParsedItem {
  return {
    eventId: 'E1',
    sequence: 0,
    startAt: new Date('2026-05-22T18:00:00Z'),
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

describe('provys.service › buildDiff', () => {
  const mtime = new Date('2026-05-22T17:00:00Z');

  it('plans creates for items not in DB', () => {
    const parsed = [p({ eventId: 'A' }), p({ eventId: 'B', sequence: 1 })];
    const diff = buildDiff('beinsports1', '/f.bxf', mtime, parsed, []);
    expect(diff.toCreate).toHaveLength(2);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toDeleteIds).toHaveLength(0);
  });

  it('plans deletes for items missing from new parse', () => {
    const parsed = [p({ eventId: 'A' })];
    const existing = [
      { id: 10, eventId: 'A', payloadHash: computeHash(parsed[0]) },
      { id: 20, eventId: 'OLD', payloadHash: 'whatever' },
    ];
    const diff = buildDiff('beinsports1', '/f.bxf', mtime, parsed, existing);
    expect(diff.toCreate).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toDeleteIds).toEqual([20]);
  });

  it('plans updates only when payloadHash differs', () => {
    const itemA = p({ eventId: 'A', title: 'Original' });
    const itemB = p({ eventId: 'B', sequence: 1, title: 'B-Original' });
    const existing = [
      { id: 1, eventId: 'A', payloadHash: computeHash(itemA) },         // unchanged
      { id: 2, eventId: 'B', payloadHash: 'stale-hash' },               // needs update
    ];
    const diff = buildDiff('beinsports1', '/f.bxf', mtime, [itemA, itemB], existing);
    expect(diff.toCreate).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0].id).toBe(2);
    expect(diff.toDeleteIds).toHaveLength(0);
  });

  it('is idempotent: parsing the same input twice yields no changes when hashes match', () => {
    const itemA = p({ eventId: 'A' });
    const itemB = p({ eventId: 'B', sequence: 1 });
    const existing = [
      { id: 1, eventId: 'A', payloadHash: computeHash(itemA) },
      { id: 2, eventId: 'B', payloadHash: computeHash(itemB) },
    ];
    const diff = buildDiff('beinsports1', '/f.bxf', mtime, [itemA, itemB], existing);
    expect(diff.toCreate).toEqual([]);
    expect(diff.toUpdate).toEqual([]);
    expect(diff.toDeleteIds).toEqual([]);
  });

  it('mixes insert + update + delete in one diff', () => {
    const stay = p({ eventId: 'STAY' });
    const change = p({ eventId: 'CHANGE', title: 'New title' });
    const fresh = p({ eventId: 'FRESH', sequence: 2 });
    const existing = [
      { id: 1, eventId: 'STAY',    payloadHash: computeHash(stay) },
      { id: 2, eventId: 'CHANGE',  payloadHash: 'stale' },
      { id: 3, eventId: 'GONE',    payloadHash: 'whatever' },
    ];
    const diff = buildDiff('beinsports1', '/f.bxf', mtime, [stay, change, fresh], existing);
    expect(diff.toCreate.map((c) => c.eventId)).toEqual(['FRESH']);
    expect(diff.toUpdate.map((u) => u.id)).toEqual([2]);
    expect(diff.toDeleteIds).toEqual([3]);
  });
});

describe('provys.service › computeHash', () => {
  it('is stable for the same input', () => {
    const item = p({});
    expect(computeHash(item)).toBe(computeHash(item));
  });

  it('differs when any tracked field changes', () => {
    const base = p({});
    expect(computeHash(base)).not.toBe(computeHash(p({ title: 'Other' })));
    expect(computeHash(base)).not.toBe(computeHash(p({ category: 'PROGRAM' })));
    expect(computeHash(base)).not.toBe(computeHash(p({ durationMs: 100 })));
    expect(computeHash(base)).not.toBe(computeHash(p({ sequence: 5 })));
  });
});
