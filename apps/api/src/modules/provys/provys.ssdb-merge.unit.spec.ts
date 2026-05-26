import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildSsdbInfoForRow,
  fetchSsdbCacheMap,
  pickEligibleDcCodes,
  isSsdbResolverEnabled,
  type ProvysRowForMerge,
  type SsdbCacheReader,
  type SsdbCacheRowForMerge,
} from './provys.ssdb-merge.js';

/**
 * Hicbir test gercek DB ne SSDB acmaz. Prisma minimal contract
 * `SsdbCacheReader` mock'lanir; env override `process.env` ile yapilir.
 */

function row(over: Partial<ProvysRowForMerge>): ProvysRowForMerge {
  return {
    category: 'PROGRAM',
    dcCode: 'DC00040962',
    durationMs: 178_560,
    durationTimecode: '00:02:58:14',
    frameRate: 25,
    ...over,
  };
}

function cacheRow(over: Partial<SsdbCacheRowForMerge>): SsdbCacheRowForMerge {
  return {
    dcCode: 'DC00040962',
    lookupStatus: 'found',
    mediaGuid: 'EEE4EBB9-C3A1-A395-7F6E-59947E0AAAB3',
    matchMethod: 'alias',
    ssdbDurationFrames: 4465,
    ssdbDurationTimecode: '00:02:58:15',
    frameRate: 25,
    lastCheckedAt: new Date('2026-05-27T08:00:00.000Z'),
    lastError: null,
    ...over,
  };
}

function buildPrismaMock(rows: SsdbCacheRowForMerge[]): {
  prisma: SsdbCacheReader;
  callCount: () => number;
  lastArgs: () => unknown;
} {
  let count = 0;
  let lastArgs: unknown = null;
  const prisma: SsdbCacheReader = {
    ssdbMaterialCache: {
      async findMany(args) {
        count++;
        lastArgs = args;
        return rows;
      },
    },
  };
  return { prisma, callCount: () => count, lastArgs: () => lastArgs };
}

describe('provys.ssdb-merge > pickEligibleDcCodes', () => {
  it('CANLI satirlari filtreler', () => {
    const rows = [
      row({ category: 'CANLI', dcCode: 'DC1' }),
      row({ category: 'PROGRAM', dcCode: 'DC2' }),
    ];
    expect(pickEligibleDcCodes(rows)).toEqual(['DC2']);
  });

  it('dcCode null/empty/whitespace satirlari filtreler', () => {
    const rows = [
      row({ category: 'PROGRAM', dcCode: null }),
      row({ category: 'PROGRAM', dcCode: '' }),
      row({ category: 'PROGRAM', dcCode: '   ' }),
      row({ category: 'PROGRAM', dcCode: 'DC1' }),
    ];
    expect(pickEligibleDcCodes(rows)).toEqual(['DC1']);
  });

  it('duplicate dcCode\'lari dedupe eder', () => {
    const rows = [
      row({ dcCode: 'DC1' }),
      row({ dcCode: 'DC1' }),
      row({ dcCode: '  DC1  ' }),
      row({ dcCode: 'DC2' }),
    ];
    expect(pickEligibleDcCodes(rows).sort()).toEqual(['DC1', 'DC2']);
  });
});

describe('provys.ssdb-merge > fetchSsdbCacheMap — flag/eligibility guards', () => {
  it('flag OFF -> Prisma cache findMany ASLA cagrilmaz', async () => {
    const { prisma, callCount } = buildPrismaMock([]);
    const map = await fetchSsdbCacheMap(prisma, [row({ dcCode: 'DC1' })], false);
    expect(map.size).toBe(0);
    expect(callCount()).toBe(0);
  });

  it('flag ON ama eligible code yoksa Prisma cagrilmaz', async () => {
    const { prisma, callCount } = buildPrismaMock([]);
    // Tum satirlar CANLI veya dcCode null
    const rows = [
      row({ category: 'CANLI', dcCode: 'DC1' }),
      row({ category: 'PROGRAM', dcCode: null }),
    ];
    const map = await fetchSsdbCacheMap(prisma, rows, true);
    expect(map.size).toBe(0);
    expect(callCount()).toBe(0);
  });

  it('flag ON + eligible codes -> tek findMany cagrisi, dcCode IN listesi', async () => {
    const { prisma, callCount, lastArgs } = buildPrismaMock([cacheRow({})]);
    const rows = [
      row({ dcCode: 'DC00040962' }),
      row({ dcCode: 'DC00040962' }), // duplicate
      row({ category: 'CANLI', dcCode: 'DC-LIVE' }),
      row({ dcCode: null }),
    ];
    const map = await fetchSsdbCacheMap(prisma, rows, true);
    expect(callCount()).toBe(1);
    const args = lastArgs() as { where: { dcCode: { in: string[] } } };
    expect(args.where.dcCode.in).toEqual(['DC00040962']);
    expect(map.get('DC00040962')?.mediaGuid).toBe('EEE4EBB9-C3A1-A395-7F6E-59947E0AAAB3');
  });
});

describe('provys.ssdb-merge > buildSsdbInfoForRow — cache miss defaults', () => {
  it('flag off / cache miss + CANLI + dcCode null -> live_not_applicable', () => {
    const ssdb = buildSsdbInfoForRow(row({ category: 'CANLI', dcCode: null }), null);
    expect(ssdb.materialStatus).toBe('live_not_applicable');
    expect(ssdb.statusLabel).toBe('Canlı');
    expect(ssdb.lookupStatus).toBeNull();
    expect(ssdb.mediaGuid).toBeNull();
    expect(ssdb.provysDurationFrames).toBeNull(); // CANLI'da cache alanlari + provys frame null
  });

  it('cache miss + PROGRAM + dcCode null -> dc_not_applicable (SSDB kapsamı dışı)', () => {
    const ssdb = buildSsdbInfoForRow(row({ category: 'PROGRAM', dcCode: null }), null);
    expect(ssdb.materialStatus).toBe('dc_not_applicable');
    expect(ssdb.statusLabel).toBe('DC kod yok; SSDB MAM materyal kontrolü yapılmaz');
    expect(ssdb.lookupStatus).toBeNull();
  });

  it('cache miss + PROGRAM + dcCode dolu -> unchecked', () => {
    const ssdb = buildSsdbInfoForRow(row({ category: 'PROGRAM', dcCode: 'DC1' }), null);
    expect(ssdb.materialStatus).toBe('unchecked');
    expect(ssdb.statusLabel).toBe('Kontrol bekliyor');
    expect(ssdb.lookupStatus).toBeNull();
    // Provys duration tabandan hesaplandi (durationTimecode '00:02:58:14' @25 = 4464)
    expect(ssdb.provysDurationFrames).toBe(4464);
  });
});

describe('provys.ssdb-merge > buildSsdbInfoForRow — cache hit branches', () => {
  it('cache missing_material -> missing_material', () => {
    const ssdb = buildSsdbInfoForRow(
      row({ category: 'PROGRAM', dcCode: 'DC1' }),
      cacheRow({ lookupStatus: 'missing_material', mediaGuid: null, ssdbDurationFrames: null,
        ssdbDurationTimecode: null }),
    );
    expect(ssdb.materialStatus).toBe('missing_material');
    expect(ssdb.lookupStatus).toBe('missing_material');
    expect(ssdb.mediaGuid).toBeNull();
  });

  it('cache duration_unknown -> found_duration_unknown', () => {
    const ssdb = buildSsdbInfoForRow(
      row({ dcCode: 'DC1' }),
      cacheRow({ lookupStatus: 'duration_unknown', ssdbDurationFrames: null, ssdbDurationTimecode: null }),
    );
    expect(ssdb.materialStatus).toBe('found_duration_unknown');
    expect(ssdb.statusLabel).toBe('Materyal var, süre yok');
  });

  it('cache ssdb_error -> ssdb_error', () => {
    const ssdb = buildSsdbInfoForRow(
      row({ dcCode: 'DC1' }),
      cacheRow({ lookupStatus: 'ssdb_error', lastError: 'login failed' }),
    );
    expect(ssdb.materialStatus).toBe('ssdb_error');
    expect(ssdb.lastError).toBe('login failed');
  });

  it('cache found + Provys/SSDB duration equal -> found_match', () => {
    // Provys durationTimecode '00:02:58:15' @25 = 4465; SSDB 4465 -> equal
    const ssdb = buildSsdbInfoForRow(
      row({ durationTimecode: '00:02:58:15', durationMs: null, frameRate: 25 }),
      cacheRow({ lookupStatus: 'found', ssdbDurationFrames: 4465, ssdbDurationTimecode: '00:02:58:15' }),
    );
    expect(ssdb.materialStatus).toBe('found_match');
    expect(ssdb.statusLabel).toBe('Materyal var');
    expect(ssdb.provysDurationFrames).toBe(4465);
    expect(ssdb.ssdbDurationFrames).toBe(4465);
  });

  it('cache found + Provys duration 4465, SSDB 4467 (2 frame fark) -> found_duration_mismatch', () => {
    const ssdb = buildSsdbInfoForRow(
      row({ durationTimecode: '00:02:58:15', durationMs: null, frameRate: 25 }),
      cacheRow({ lookupStatus: 'found', ssdbDurationFrames: 4467 }),
    );
    expect(ssdb.materialStatus).toBe('found_duration_mismatch');
    expect(ssdb.provysDurationFrames).toBe(4465);
    expect(ssdb.ssdbDurationFrames).toBe(4467);
  });

  it('cache found + 1 frame fark -> found_match (tolerance icinde)', () => {
    const ssdb = buildSsdbInfoForRow(
      row({ durationTimecode: '00:02:58:14', durationMs: null, frameRate: 25 }), // 4464
      cacheRow({ lookupStatus: 'found', ssdbDurationFrames: 4465 }),
    );
    expect(ssdb.materialStatus).toBe('found_match');
  });

  it('lastCheckedAt ISO formatinda doner', () => {
    const dt = new Date('2026-05-27T08:00:00.000Z');
    const ssdb = buildSsdbInfoForRow(row({ dcCode: 'DC1' }),
      cacheRow({ lastCheckedAt: dt }));
    expect(ssdb.lastCheckedAt).toBe('2026-05-27T08:00:00.000Z');
  });
});

describe('provys.ssdb-merge > CANLI short-circuit (cache var olsa bile)', () => {
  it('CANLI + cache found + duration mismatch -> live_not_applicable, cache DTO\'ya tasinmaz', () => {
    const ssdb = buildSsdbInfoForRow(
      row({ category: 'CANLI', dcCode: 'DC1',
        durationTimecode: '00:02:58:14', durationMs: null, frameRate: 25 }),
      cacheRow({ lookupStatus: 'found', ssdbDurationFrames: 6000, mediaGuid: 'G-LIVE' }),
    );
    expect(ssdb.materialStatus).toBe('live_not_applicable');
    expect(ssdb.statusLabel).toBe('Canlı');
    // Cache fields ASLA DTO'ya tasinmaz
    expect(ssdb.lookupStatus).toBeNull();
    expect(ssdb.mediaGuid).toBeNull();
    expect(ssdb.matchMethod).toBeNull();
    expect(ssdb.ssdbDurationFrames).toBeNull();
    expect(ssdb.ssdbDurationTimecode).toBeNull();
    expect(ssdb.provysDurationFrames).toBeNull();
    expect(ssdb.frameRate).toBeNull();
    expect(ssdb.lastCheckedAt).toBeNull();
    expect(ssdb.lastError).toBeNull();
  });

  it('CANLI + cache missing_material -> live_not_applicable (alarm UREMEZ)', () => {
    const ssdb = buildSsdbInfoForRow(
      row({ category: 'CANLI', dcCode: 'DC1' }),
      cacheRow({ lookupStatus: 'missing_material', mediaGuid: null }),
    );
    expect(ssdb.materialStatus).toBe('live_not_applicable');
  });
});

describe('provys.ssdb-merge > aynı DC iki satirda (multi category)', () => {
  it('PROGRAM cache karari alir, CANLI live_not_applicable kalir', () => {
    const cache = cacheRow({ lookupStatus: 'found', ssdbDurationFrames: 4465 });
    const programRow = row({
      category: 'PROGRAM', dcCode: 'DC1',
      durationTimecode: '00:02:58:15', durationMs: null, frameRate: 25,
    });
    const liveRow = row({ category: 'CANLI', dcCode: 'DC1' });

    const programInfo = buildSsdbInfoForRow(programRow, cache);
    const liveInfo = buildSsdbInfoForRow(liveRow, cache);

    expect(programInfo.materialStatus).toBe('found_match');
    expect(programInfo.mediaGuid).toBe(cache.mediaGuid);
    expect(liveInfo.materialStatus).toBe('live_not_applicable');
    expect(liveInfo.mediaGuid).toBeNull();
  });

  it('aynı DC icin Prisma cache findMany sadece 1 kez cagrilir', async () => {
    const { prisma, callCount, lastArgs } = buildPrismaMock([cacheRow({ dcCode: 'DC1' })]);
    const rows = [
      row({ category: 'PROGRAM', dcCode: 'DC1' }),
      row({ category: 'CANLI', dcCode: 'DC1' }),
      row({ category: 'PROGRAM', dcCode: 'DC1' }),
    ];
    await fetchSsdbCacheMap(prisma, rows, true);
    expect(callCount()).toBe(1);
    const args = lastArgs() as { where: { dcCode: { in: string[] } } };
    // CANLI hariç, duplicate dedupe -> tek DC
    expect(args.where.dcCode.in).toEqual(['DC1']);
  });
});

describe('provys.ssdb-merge > isSsdbResolverEnabled (env-driven)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('PROVYS_SSDB_RESOLVER unset -> false', () => {
    delete process.env.PROVYS_SSDB_RESOLVER;
    expect(isSsdbResolverEnabled()).toBe(false);
  });

  it('PROVYS_SSDB_RESOLVER=on -> true', () => {
    process.env.PROVYS_SSDB_RESOLVER = 'on';
    expect(isSsdbResolverEnabled()).toBe(true);
  });

  it('PROVYS_SSDB_RESOLVER=off -> false', () => {
    process.env.PROVYS_SSDB_RESOLVER = 'off';
    expect(isSsdbResolverEnabled()).toBe(false);
  });
});
