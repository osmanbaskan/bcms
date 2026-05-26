import { describe, it, expect, vi } from 'vitest';
import {
  isSsdbCacheOutcomeChanged,
  outcomeToCachePayload,
  upsertSsdbCacheOutcome,
  findAffectedTodayFuturePairs,
  notifyAffectedPairs,
  type SsdbCachePrevRow,
} from './ssdb-cache.service.js';
import type { SsdbMaterialLookupOutcome } from './ssdb-material-resolver.js';

const NOW = new Date('2026-05-27T08:00:00.000Z');

function outcome(over: Partial<SsdbMaterialLookupOutcome>): SsdbMaterialLookupOutcome {
  return {
    dcCode: 'DC1',
    lookupStatus: 'found',
    mediaGuid: 'GUID-1',
    mediaName: 'X',
    mediaAlias: 'DC1',
    originalFilename: 'DC1',
    matchMethod: 'alias',
    tcSom: 0,
    tcEom: 4464,
    ssdbDurationFrames: 4465,
    ssdbDurationTimecode: '00:02:58:15',
    frameRate: 25,
    lastError: null,
    ...over,
  };
}

function prev(over: Partial<SsdbCachePrevRow>): SsdbCachePrevRow {
  return {
    dcCode: 'DC1',
    lookupStatus: 'found',
    mediaGuid: 'GUID-1',
    matchMethod: 'alias',
    tcSom: 0,
    tcEom: 4464,
    ssdbDurationFrames: 4465,
    lastCheckedAt: new Date(NOW.getTime() - 1000),
    lastError: null,
    ...over,
  };
}

describe('ssdb-cache.service > outcomeToCachePayload', () => {
  it('found outcome: create + update lastFoundAt set', () => {
    const { create, update } = outcomeToCachePayload(outcome({}), NOW);
    expect(create.dcCode).toBe('DC1');
    expect(create.lookupStatus).toBe('found');
    expect(create.tcSom).toBe(0);
    expect(create.tcEom).toBe(4464);
    expect(create.ssdbDurationFrames).toBe(4465);
    expect(create.lastFoundAt).toEqual(NOW);
    expect(update.lastFoundAt).toEqual(NOW);
    // Provys-bagimli alan SCHEMA'da yok; payload'da da bulunmamali
    expect(create).not.toHaveProperty('materialStatus');
    expect(update).not.toHaveProperty('found_match');
  });

  it('missing_material outcome: lastFoundAt null create, update lastFoundAt YOK (kalsin)', () => {
    const { create, update } = outcomeToCachePayload(
      outcome({ lookupStatus: 'missing_material', mediaGuid: null, ssdbDurationFrames: null }),
      NOW,
    );
    expect(create.lookupStatus).toBe('missing_material');
    expect(create.lastFoundAt).toBeNull();
    expect(update).not.toHaveProperty('lastFoundAt');
  });

  it('ssdb_error outcome: lastError set', () => {
    const { create } = outcomeToCachePayload(
      outcome({ lookupStatus: 'ssdb_error', lastError: 'connect ECONNREFUSED' }),
      NOW,
    );
    expect(create.lookupStatus).toBe('ssdb_error');
    expect(create.lastError).toBe('connect ECONNREFUSED');
  });
});

describe('ssdb-cache.service > isSsdbCacheOutcomeChanged', () => {
  it('prev null -> true', () => {
    expect(isSsdbCacheOutcomeChanged(null, outcome({}))).toBe(true);
  });

  it('lastCheckedAt fark etmez (sadece anlamli alanlar)', () => {
    expect(isSsdbCacheOutcomeChanged(prev({}), outcome({}))).toBe(false);
  });

  it('lookupStatus degisirse -> true', () => {
    expect(isSsdbCacheOutcomeChanged(
      prev({ lookupStatus: 'found' }),
      outcome({ lookupStatus: 'missing_material', mediaGuid: null }),
    )).toBe(true);
  });

  it('tcSom degisirse -> true', () => {
    expect(isSsdbCacheOutcomeChanged(
      prev({ tcSom: 0 }), outcome({ tcSom: 100 }),
    )).toBe(true);
  });
});

describe('ssdb-cache.service > upsertSsdbCacheOutcome', () => {
  it('prisma.ssdbMaterialCache.upsert dogru args ile cagrilir', async () => {
    const upsertSpy = vi.fn().mockResolvedValue(null);
    const prisma = { ssdbMaterialCache: { upsert: upsertSpy }, provysItem: {} } as never;
    await upsertSsdbCacheOutcome(prisma, outcome({}), NOW);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const args = upsertSpy.mock.calls[0][0];
    expect(args.where).toEqual({ dcCode: 'DC1' });
    expect(args.create.lookupStatus).toBe('found');
    expect(args.create.tcSom).toBe(0);
    expect(args.update.lookupStatus).toBe('found');
  });
});

describe('ssdb-cache.service > findAffectedTodayFuturePairs', () => {
  const todayUtc  = new Date('2026-05-27T00:00:00.000Z');
  const futureUtc = new Date('2026-06-10T00:00:00.000Z');

  it('dcCodes bos liste -> hic query yok, [] doner', async () => {
    const findSpy = vi.fn();
    const prisma = { provysItem: { findMany: findSpy }, ssdbMaterialCache: {} } as never;
    const r = await findAffectedTodayFuturePairs(prisma, [], todayUtc, futureUtc);
    expect(r).toEqual([]);
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('where clause CANLI hariç + window + dcCode IN', async () => {
    const findSpy = vi.fn().mockResolvedValue([
      { channelSlug: 'beinsports1', scheduleDate: todayUtc },
    ]);
    const prisma = { provysItem: { findMany: findSpy }, ssdbMaterialCache: {} } as never;
    await findAffectedTodayFuturePairs(prisma, ['DC1', 'DC2'], todayUtc, futureUtc);
    const args = findSpy.mock.calls[0][0];
    expect(args.where.category).toEqual({ not: 'CANLI' });
    expect(args.where.dcCode).toEqual({ in: ['DC1', 'DC2'] });
    expect(args.where.scheduleDate).toEqual({ gte: todayUtc, lte: futureUtc });
    expect(args.distinct).toEqual(['channelSlug', 'scheduleDate']);
  });
});

describe('ssdb-cache.service > notifyAffectedPairs', () => {
  const prisma = { provysItem: {}, ssdbMaterialCache: {} } as never;
  const logger = { warn: vi.fn() };

  it('her pair icin emit cagrilir, ISO date format', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const pairs = [
      { channelSlug: 'beinsports1', scheduleDate: new Date('2026-05-27T00:00:00.000Z') },
      { channelSlug: 'beinhaber',   scheduleDate: new Date('2026-05-28T00:00:00.000Z') },
    ];
    const n = await notifyAffectedPairs(emit as never, prisma, logger, pairs);
    expect(n).toBe(2);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, prisma, logger, 'beinsports1', '2026-05-27');
    expect(emit).toHaveBeenNthCalledWith(2, prisma, logger, 'beinhaber',   '2026-05-28');
  });

  it('bir pair fail -> diger pair etkilenmez, log warn', async () => {
    const emit = vi.fn()
      .mockRejectedValueOnce(new Error('pg fail'))
      .mockResolvedValueOnce(undefined);
    const pairs = [
      { channelSlug: 'A', scheduleDate: new Date('2026-05-27T00:00:00.000Z') },
      { channelSlug: 'B', scheduleDate: new Date('2026-05-27T00:00:00.000Z') },
    ];
    const n = await notifyAffectedPairs(emit as never, prisma, logger, pairs);
    expect(n).toBe(1); // sadece B basarili
    expect(logger.warn).toHaveBeenCalled();
  });

  it('bos pair listesi -> 0, emit cagrilmaz', async () => {
    const emit = vi.fn();
    const n = await notifyAffectedPairs(emit as never, prisma, logger, []);
    expect(n).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });
});
