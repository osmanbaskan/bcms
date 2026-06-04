import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runSsdbResolverTickOnce,
  isSsdbCacheOutcomeChanged,
  addDaysToIstanbulDate,
  loadSsdbWorkerConfig,
  startSsdbResolverWorker,
  requestSsdbResolverTick,
  SSDB_TRIGGER_DEBOUNCE_MS,
  _resetSsdbWorkerStateForTests,
  _setRunManualTickForTests,
  type SsdbWorkerConfig,
  type SsdbCachePrevRow,
} from './ssdb-resolver.worker.js';
import type {
  SsdbMaterialLookupOutcome,
} from './ssdb-material-resolver.js';

/**
 * Hicbir test gercek DB/SSDB acmaz. `prisma`, `resolver`, `emitNotify` ve
 * `todayIstanbul/now` injection ile yan etkiler izole edilir.
 */

const FROZEN_TODAY_ISTANBUL = '2026-05-27';
const FROZEN_NOW = new Date('2026-05-27T08:00:00.000Z');

function todayUtc(): Date { return new Date(`${FROZEN_TODAY_ISTANBUL}T00:00:00.000Z`); }
function dayUtc(iso: string): Date { return new Date(`${iso}T00:00:00.000Z`); }

const BASE_CFG: SsdbWorkerConfig = {
  windowFutureDays: 14,
  intervalMs: 3_600_000,
  maxPerTick: 100,
  batchSize: 5,
  ttlFoundMin: 60,
  ttlDurationUnknownMin: 120,
  ttlMissingMin: 30,
  ttlErrorMin: 5,
  lookupConcurrency: 5,
  cacheWriteConcurrency: 5,
};

function makeOutcome(over: Partial<SsdbMaterialLookupOutcome>): SsdbMaterialLookupOutcome {
  return {
    dcCode: 'DC1',
    lookupStatus: 'found',
    mediaGuid: null,
    mediaName: null,
    mediaAlias: null,
    originalFilename: null,
    matchMethod: null,
    tcSom: null,
    tcEom: null,
    ssdbDurationFrames: null,
    ssdbDurationTimecode: null,
    frameRate: null,
    lastError: null,
    ...over,
  };
}

function makePrev(over: Partial<SsdbCachePrevRow>): SsdbCachePrevRow {
  return {
    dcCode: 'DC1',
    lookupStatus: 'found',
    mediaGuid: 'GUID-1',
    matchMethod: 'alias',
    tcSom: 0,
    tcEom: 4464,
    ssdbDurationFrames: 4465,
    lastCheckedAt: new Date(FROZEN_NOW.getTime() - 1_000),
    lastError: null,
    ...over,
  };
}

/**
 * Prisma mock — sadece worker'in dokundugu method'lar; her cagri kaydedilir.
 *
 * Candidate discovery artik raw SQL `$queryRaw` ile yapildigi icin
 * `candidateRows` opt'u verilirse mock onu dondurur; verilmemisse fallback
 * olarak `provysRows`'dan dcCode'lari `{ dc_code }[]` shape'inde dondurur
 * (cache miss simulasyonu — eski test pattern'i ile uyumlu).
 *
 * `provysItem.findMany` artik tek cagri tasir: affected pairs query.
 */
function buildPrismaMock(opts: {
  provysRows?: { dcCode: string }[];
  candidateRows?: string[];
  cacheRows?: SsdbCachePrevRow[];
  affectedRows?: { channelSlug: string; scheduleDate: Date }[];
}) {
  const calls = {
    provysFindMany: [] as unknown[],
    cacheFindMany: [] as unknown[],
    cacheUpsert: [] as unknown[],
    queryRaw: [] as unknown[],
  };
  const candidateCodes = opts.candidateRows
    ?? (opts.provysRows ?? []).map((r) => r.dcCode);
  const prisma = {
    async $queryRaw(...args: unknown[]) {
      calls.queryRaw.push(args);
      return candidateCodes.map((dc) => ({ dc_code: dc }));
    },
    provysItem: {
      async findMany(args: unknown) {
        calls.provysFindMany.push(args);
        return opts.affectedRows ?? [];
      },
    },
    ssdbMaterialCache: {
      async findMany(args: unknown) {
        calls.cacheFindMany.push(args);
        return opts.cacheRows ?? [];
      },
      async upsert(args: unknown) {
        calls.cacheUpsert.push(args);
        return null;
      },
    },
  };
  return { prisma: prisma as never, calls };
}

beforeEach(() => {
  _resetSsdbWorkerStateForTests();
});

describe('worker > addDaysToIstanbulDate', () => {
  it('today + 14 = expected ISO', () => {
    expect(addDaysToIstanbulDate('2026-05-27', 14)).toBe('2026-06-10');
  });

  it('handles month boundary', () => {
    expect(addDaysToIstanbulDate('2026-05-30', 3)).toBe('2026-06-02');
  });

  it('handles year boundary', () => {
    expect(addDaysToIstanbulDate('2026-12-30', 5)).toBe('2027-01-04');
  });
});

describe('worker > loadSsdbWorkerConfig — defaults + override', () => {
  it('defaults (2026-05-27 revize: interval 1h, found TTL 60dk, batch/conc 5/5)', () => {
    const c = loadSsdbWorkerConfig({});
    expect(c.windowFutureDays).toBe(14);
    expect(c.intervalMs).toBe(3_600_000);
    expect(c.maxPerTick).toBe(100);
    expect(c.batchSize).toBe(5);
    expect(c.ttlFoundMin).toBe(60);
    expect(c.ttlDurationUnknownMin).toBe(120);
    expect(c.ttlMissingMin).toBe(30);
    expect(c.ttlErrorMin).toBe(5);
    expect(c.lookupConcurrency).toBe(5);
    expect(c.cacheWriteConcurrency).toBe(5);
  });

  it('concurrency env override', () => {
    const c = loadSsdbWorkerConfig({
      SSDB_LOOKUP_CONCURRENCY: '7',
      SSDB_CACHE_WRITE_CONCURRENCY: '2',
    });
    expect(c.lookupConcurrency).toBe(7);
    expect(c.cacheWriteConcurrency).toBe(2);
  });

  it('concurrency clamp: max 10 (yukari kesilir)', () => {
    const c = loadSsdbWorkerConfig({
      SSDB_LOOKUP_CONCURRENCY: '50',
      SSDB_CACHE_WRITE_CONCURRENCY: '99',
    });
    expect(c.lookupConcurrency).toBe(10);
    expect(c.cacheWriteConcurrency).toBe(10);
  });

  it('concurrency invalid -> guvenli default (5/5)', () => {
    const c = loadSsdbWorkerConfig({
      SSDB_LOOKUP_CONCURRENCY: 'abc',
      SSDB_CACHE_WRITE_CONCURRENCY: '0',
    });
    expect(c.lookupConcurrency).toBe(5);
    expect(c.cacheWriteConcurrency).toBe(5);
  });

  it('concurrency negative -> guvenli default (5/5)', () => {
    const c = loadSsdbWorkerConfig({
      SSDB_LOOKUP_CONCURRENCY: '-1',
      SSDB_CACHE_WRITE_CONCURRENCY: '-5',
    });
    expect(c.lookupConcurrency).toBe(5);
    expect(c.cacheWriteConcurrency).toBe(5);
  });

  it('explicit env override', () => {
    const c = loadSsdbWorkerConfig({
      SSDB_WINDOW_FUTURE_DAYS: '7',
      SSDB_WORKER_INTERVAL_MS: '30000',
      SSDB_BATCH_SIZE: '25',
      SSDB_TTL_FOUND_MIN: '1440',
    });
    expect(c.windowFutureDays).toBe(7);
    expect(c.intervalMs).toBe(30_000);
    expect(c.batchSize).toBe(25);
    expect(c.ttlFoundMin).toBe(1440);
  });
});

describe('worker > startSsdbResolverWorker — feature flag + env guards', () => {
  it('PROVYS_SSDB_RESOLVER off -> timer KURULMAZ, false dondurur', () => {
    const env = process.env;
    process.env = { ...env, PROVYS_SSDB_RESOLVER: '' };
    try {
      const app = {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        addHook: vi.fn(),
        prisma: {} as never,
      };
      const r = startSsdbResolverWorker(app as never);
      expect(r).toBe(false);
      expect(app.addHook).not.toHaveBeenCalled();
    } finally {
      process.env = env;
    }
  });

  it('flag on ama SSDB_HOST eksik -> worker baslamaz, warn loglar', () => {
    const env = process.env;
    process.env = {
      ...env,
      PROVYS_SSDB_RESOLVER: 'on',
      SSDB_HOST: '',
      SSDB_PORT: '60813',
      SSDB_DATABASE: 'LIGTV-SSDB',
      SSDB_USER: 'read1',
      SSDB_PASSWORD: 'pw',
    };
    try {
      const app = {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        addHook: vi.fn(),
        prisma: {} as never,
      };
      const r = startSsdbResolverWorker(app as never);
      expect(r).toBe(false);
      expect(app.log.warn).toHaveBeenCalled();
      expect(app.addHook).not.toHaveBeenCalled();
    } finally {
      process.env = env;
    }
  });

  it('flag on + tum env tam -> timer KURULUR (cleanup hook eklenir)', () => {
    const env = process.env;
    process.env = {
      ...env,
      PROVYS_SSDB_RESOLVER: 'on',
      SSDB_HOST: 'ssdb-host.example.local',
      SSDB_PORT: '60813',
      SSDB_DATABASE: 'LIGTV-SSDB',
      SSDB_USER: 'read1',
      SSDB_PASSWORD: 'pw',
    };
    try {
      const app = {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        addHook: vi.fn(),
        prisma: {} as never,
      };
      const r = startSsdbResolverWorker(app as never);
      expect(r).toBe(true);
      expect(app.addHook).toHaveBeenCalledWith('onClose', expect.any(Function));
      // Test teardown: timer'lari temizle
      _resetSsdbWorkerStateForTests();
    } finally {
      process.env = env;
    }
  });
});

describe('worker > runSsdbResolverTickOnce — candidate discovery (raw SQL)', () => {
  it('candidate $queryRaw bir kez cagrilir + Prisma.sql Sql instance + values dolu', async () => {
    const { prisma, calls } = buildPrismaMock({ candidateRows: [], cacheRows: [] });
    await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: vi.fn(), emitNotifyFn: vi.fn(),
    });

    expect(calls.queryRaw).toHaveLength(1);
    // Prisma.sql tagged template -> Prisma.Sql instance ilk argumandadir.
    const sqlArg = (calls.queryRaw[0] as unknown[])[0] as { values: unknown[] };
    expect(Array.isArray(sqlArg.values)).toBe(true);
    // 6 binding: todayUtc + futureUtc + 4 TTL bound + maxPerTick = 7
    expect(sqlArg.values.length).toBe(7);
    // Ilk iki value = todayUtc + futureUtc (Date instance, Europe/Istanbul guneden UTC midnight)
    const v = sqlArg.values as Date[];
    expect(v[0].toISOString()).toBe('2026-05-27T00:00:00.000Z');
    expect(v[1].toISOString()).toBe('2026-06-10T00:00:00.000Z'); // today + 14
    // Son value = maxPerTick
    expect(sqlArg.values[6]).toBe(BASE_CFG.maxPerTick);
  });

  it('candidate $queryRaw bos -> processed 0, resolver ASLA cagrilmaz, cache findMany cagrilmaz', async () => {
    const resolverSpy = vi.fn().mockResolvedValue(new Map());
    const { prisma, calls } = buildPrismaMock({ candidateRows: [], cacheRows: [] });
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    expect(r.candidates).toBe(0);
    expect(r.processed).toBe(0);
    expect(r.changed).toBe(0);
    expect(r.notified).toBe(0);
    expect(r.cacheWriteSucceeded).toBe(0);
    expect(r.cacheWriteFailed).toBe(0);
    expect(typeof r.durationMs).toBe('number');
    expect(resolverSpy).not.toHaveBeenCalled();
    // candidates 0 -> tick early return; existingCache fetch yapilmaz.
    expect(calls.cacheFindMany).toHaveLength(0);
  });

  it('existingCache fetch CANDIDATE listesi ile cagrilir (changed/notify regression)', async () => {
    const resolverSpy = vi.fn().mockResolvedValue(new Map([
      ['DC00055348', makeOutcome({ dcCode: 'DC00055348' })],
      ['DC00055635', makeOutcome({ dcCode: 'DC00055635' })],
    ]));
    const { prisma, calls } = buildPrismaMock({
      candidateRows: ['DC00055348', 'DC00055635'],
      cacheRows: [],
    });
    await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    // existingCache fetch CANDIDATE dcCode listesi ile yapilmali (eski bug: dcCodes idi).
    expect(calls.cacheFindMany).toHaveLength(1);
    const cacheArgs = calls.cacheFindMany[0] as {
      where: { dcCode: { in: string[] } };
      select: Record<string, true>;
    };
    expect(cacheArgs.where.dcCode.in).toEqual(['DC00055348', 'DC00055635']);
    // shape regression — SsdbCachePrevRow alanlari korunmus mu
    expect(cacheArgs.select).toEqual({
      dcCode: true, lookupStatus: true, mediaGuid: true, matchMethod: true,
      tcSom: true, tcEom: true, ssdbDurationFrames: true,
      lastCheckedAt: true, lastError: true,
    });
  });
});

describe('worker > runSsdbResolverTickOnce — candidate processing (mock seviyesinde)', () => {
  // SQL-level TTL filter ve ordering integration test'te dogrulanir
  // (ssdb-resolver.worker.starvation.integration.spec.ts). Burada akis:
  // candidate listesi -> resolver -> upsert -> changed/notify davranisi.
  it('candidate verilirse resolver bu listeyi alir + processed=count', async () => {
    const resolverSpy = vi.fn().mockResolvedValue(new Map([
      ['DC1', makeOutcome({ dcCode: 'DC1' })],
    ]));
    const { prisma } = buildPrismaMock({
      candidateRows: ['DC1'],
      cacheRows: [],
    });
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    expect(r.candidates).toBe(1);
    expect(r.processed).toBe(1);
    expect(resolverSpy).toHaveBeenCalledWith(['DC1'], expect.objectContaining({ batchSize: 5 }));
  });

  it('TTL bound parametreleri Prisma.sql values icine bind edilir', async () => {
    const { prisma, calls } = buildPrismaMock({ candidateRows: [], cacheRows: [] });
    const cfg: SsdbWorkerConfig = {
      ...BASE_CFG,
      ttlMissingMin: 1, ttlErrorMin: 1, ttlDurationUnknownMin: 30, ttlFoundMin: 60,
    };
    await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: cfg,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: vi.fn(), emitNotifyFn: vi.fn(),
    });
    const sqlArg = (calls.queryRaw[0] as unknown[])[0] as { values: unknown[] };
    // values: [todayUtc, futureUtc, missingTtlBound, errorTtlBound, durationTtlBound, foundTtlBound, maxPerTick]
    expect((sqlArg.values[2] as Date).toISOString())
      .toBe(new Date(FROZEN_NOW.getTime() - 1 * 60_000).toISOString());
    expect((sqlArg.values[3] as Date).toISOString())
      .toBe(new Date(FROZEN_NOW.getTime() - 1 * 60_000).toISOString());
    expect((sqlArg.values[4] as Date).toISOString())
      .toBe(new Date(FROZEN_NOW.getTime() - 30 * 60_000).toISOString());
    expect((sqlArg.values[5] as Date).toISOString())
      .toBe(new Date(FROZEN_NOW.getTime() - 60 * 60_000).toISOString());
  });
});

describe('worker > runSsdbResolverTickOnce — starvation regression', () => {
  // 198 distinct DC senaryosunda ileri ID'li (44058, 49103 gibi) DC'lerin
  // mock candidate set'inde olabildigini garanti eden test. Eski bug:
  // Prisma findMany + distinct + take + no orderBy -> ileri ID DC'ler
  // hicbir tick'te pickup edilmiyordu. Yeni: $queryRaw ORDER BY/LIMIT
  // SQL-level uygular; mock onu serbestce dondurur.
  it('ileri ID DC ($queryRaw donerse) resolver onu alir + cache findMany IN(candidates)', async () => {
    const resolverSpy = vi.fn().mockResolvedValue(new Map([
      ['DC00055348', makeOutcome({ dcCode: 'DC00055348', lookupStatus: 'found',
        mediaGuid: 'GUID-348', matchMethod: 'alias', tcSom: 0, tcEom: 33866, ssdbDurationFrames: 33866 })],
      ['DC00055635', makeOutcome({ dcCode: 'DC00055635', lookupStatus: 'found',
        mediaGuid: 'GUID-635', matchMethod: 'alias', tcSom: 0, tcEom: 12345, ssdbDurationFrames: 12345 })],
    ]));
    const { prisma, calls } = buildPrismaMock({
      candidateRows: ['DC00055348', 'DC00055635'],
      cacheRows: [],   // cache miss
    });
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    expect(r.candidates).toBe(2);
    expect(r.found).toBe(2);
    expect(resolverSpy).toHaveBeenCalledWith(
      ['DC00055348', 'DC00055635'],
      expect.objectContaining({ batchSize: 5 }),
    );
    // existingCache fetch CANDIDATE listesi ile cagrildi (eski bug guard).
    const cacheArgs = calls.cacheFindMany[0] as { where: { dcCode: { in: string[] } } };
    expect(cacheArgs.where.dcCode.in).toEqual(['DC00055348', 'DC00055635']);
  });

  it('changed regression: missing -> found, prev row dogru shape ile compare edilir', async () => {
    // Mevcut cache: missing_material; SSDB outcome: found + mediaGuid.
    // isSsdbCacheOutcomeChanged(prev, outcome) eski prev row uzerinden TRUE
    // donmeli; notified > 0.
    const prevMissing = makePrev({
      dcCode: 'DC00055348',
      lookupStatus: 'missing_material',
      mediaGuid: null, matchMethod: null,
      tcSom: null, tcEom: null, ssdbDurationFrames: null,
      lastCheckedAt: new Date(FROZEN_NOW.getTime() - 60 * 60_000),
    });
    const newFound = makeOutcome({
      dcCode: 'DC00055348', lookupStatus: 'found',
      mediaGuid: 'GUID-348', matchMethod: 'alias',
      tcSom: 0, tcEom: 33866, ssdbDurationFrames: 33866,
    });
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC00055348', newFound]]));
    const emitSpy = vi.fn().mockResolvedValue(undefined);
    const { prisma } = buildPrismaMock({
      candidateRows: ['DC00055348'],
      cacheRows: [prevMissing],
      affectedRows: [{ channelSlug: 'beinhaber', scheduleDate: dayUtc('2026-05-28') }],
    });
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: emitSpy,
    });
    expect(r.changed).toBe(1);
    expect(r.notified).toBe(1);
    expect(emitSpy).toHaveBeenCalledWith(prisma, expect.anything(), 'beinhaber', '2026-05-28');
  });

  it('changed regression: found -> found (alanlar ayni) -> changed=0, notify=0', async () => {
    const prevFound = makePrev({
      dcCode: 'DC00055348',
      lookupStatus: 'found',
      mediaGuid: 'GUID-348', matchMethod: 'alias',
      tcSom: 0, tcEom: 33866, ssdbDurationFrames: 33866,
      lastCheckedAt: new Date(FROZEN_NOW.getTime() - 70 * 60_000), // TTL dolmus
    });
    const sameFound = makeOutcome({
      dcCode: 'DC00055348', lookupStatus: 'found',
      mediaGuid: 'GUID-348', matchMethod: 'alias',
      tcSom: 0, tcEom: 33866, ssdbDurationFrames: 33866,
    });
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC00055348', sameFound]]));
    const emitSpy = vi.fn();
    const { prisma } = buildPrismaMock({
      candidateRows: ['DC00055348'],
      cacheRows: [prevFound],
      affectedRows: [{ channelSlug: 'beinhaber', scheduleDate: dayUtc('2026-05-28') }],
    });
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: emitSpy,
    });
    expect(r.changed).toBe(0);
    expect(r.notified).toBe(0);
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe('worker > resolver batchSize propagates', () => {
  it('cfg.batchSize resolver options.batchSize olarak gecer', async () => {
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC1', makeOutcome({ dcCode: 'DC1' })]]));
    const { prisma } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }],
      cacheRows: [],
    });
    await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25,
      workerConfig: { ...BASE_CFG, batchSize: 25 },
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    expect(resolverSpy).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ batchSize: 25, defaultFrameRate: 25 }),
    );
  });
});

describe('worker > cache upsert fields (sadece SSDB fact)', () => {
  it('found outcome -> upsert lookupStatus=found, tcSom/tcEom, ssdbDurationFrames, lastFoundAt set', async () => {
    const outcome = makeOutcome({
      dcCode: 'DC1', lookupStatus: 'found',
      mediaGuid: 'GUID-1', matchMethod: 'alias',
      tcSom: 0, tcEom: 4464, ssdbDurationFrames: 4465,
      ssdbDurationTimecode: '00:02:58:15', frameRate: 25,
    });
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC1', outcome]]));
    const { prisma, calls } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }],
      cacheRows: [],
    });
    await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    expect(calls.cacheUpsert).toHaveLength(1);
    const upsert = calls.cacheUpsert[0] as {
      create: Record<string, unknown>; update: Record<string, unknown>;
    };
    expect(upsert.create.dcCode).toBe('DC1');
    expect(upsert.create.lookupStatus).toBe('found');
    expect(upsert.create.tcSom).toBe(0);
    expect(upsert.create.tcEom).toBe(4464);
    expect(upsert.create.ssdbDurationFrames).toBe(4465);
    expect(upsert.create.ssdbDurationTimecode).toBe('00:02:58:15');
    expect(upsert.create.lastFoundAt).toEqual(FROZEN_NOW);
    expect(upsert.update.lastFoundAt).toEqual(FROZEN_NOW);
    // Provys-bagimli status alanlari yazilmamali — schema'da yok zaten
    expect(upsert.create).not.toHaveProperty('materialStatus');
    expect(upsert.create).not.toHaveProperty('found_match');
  });

  it('missing_material outcome -> upsert lookupStatus=missing_material, durations null', async () => {
    const outcome = makeOutcome({ dcCode: 'DC1', lookupStatus: 'missing_material' });
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC1', outcome]]));
    const { prisma, calls } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }], cacheRows: [],
    });
    await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    const upsert = calls.cacheUpsert[0] as { create: Record<string, unknown> };
    expect(upsert.create.lookupStatus).toBe('missing_material');
    expect(upsert.create.mediaGuid).toBeNull();
    expect(upsert.create.ssdbDurationFrames).toBeNull();
    expect(upsert.create.lastFoundAt).toBeNull();
  });

  it('duration_unknown outcome -> upsert lookupStatus=duration_unknown', async () => {
    const outcome = makeOutcome({
      dcCode: 'DC1', lookupStatus: 'duration_unknown',
      mediaGuid: 'G', matchMethod: 'alias',
    });
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC1', outcome]]));
    const { prisma, calls } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }], cacheRows: [],
    });
    await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    const upsert = calls.cacheUpsert[0] as { create: Record<string, unknown> };
    expect(upsert.create.lookupStatus).toBe('duration_unknown');
    expect(upsert.create.mediaGuid).toBe('G');
    expect(upsert.create.lastFoundAt).toBeNull();
  });

  it('ssdb_error outcome -> upsert lastError set (truncated kontrol resolver tarafinda)', async () => {
    const outcome = makeOutcome({
      dcCode: 'DC1', lookupStatus: 'ssdb_error', lastError: 'connect ECONNREFUSED',
    });
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC1', outcome]]));
    const { prisma, calls } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }], cacheRows: [],
    });
    await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    const upsert = calls.cacheUpsert[0] as { create: Record<string, unknown> };
    expect(upsert.create.lookupStatus).toBe('ssdb_error');
    expect(upsert.create.lastError).toBe('connect ECONNREFUSED');
  });
});

describe('worker > isSsdbCacheOutcomeChanged + notify behavior', () => {
  it('prev null -> changed true', () => {
    expect(isSsdbCacheOutcomeChanged(null, makeOutcome({}))).toBe(true);
  });

  it('lastCheckedAt tek basina degisirse changed DEGIL (alanlar ayni)', () => {
    const prev = makePrev({});
    const next = makeOutcome({
      dcCode: 'DC1', lookupStatus: 'found', mediaGuid: 'GUID-1',
      matchMethod: 'alias', tcSom: 0, tcEom: 4464, ssdbDurationFrames: 4465,
    });
    expect(isSsdbCacheOutcomeChanged(prev, next)).toBe(false);
  });

  it('lookupStatus degisirse changed', () => {
    const prev = makePrev({ lookupStatus: 'found' });
    const next = makeOutcome({ dcCode: 'DC1', lookupStatus: 'missing_material' });
    expect(isSsdbCacheOutcomeChanged(prev, next)).toBe(true);
  });

  it('outcome degismediyse emitNotify cagrilmaz', async () => {
    const prev = makePrev({});
    const outcome = makeOutcome({
      dcCode: 'DC1', lookupStatus: 'found', mediaGuid: 'GUID-1',
      matchMethod: 'alias', tcSom: 0, tcEom: 4464, ssdbDurationFrames: 4465,
    });
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC1', outcome]]));
    const emitSpy = vi.fn();
    // TTL dolmus olsun ki resolver cagrilsin
    const expiredPrev = { ...prev, lastCheckedAt: new Date(FROZEN_NOW.getTime() - 13 * 60 * 60_000) };
    const { prisma } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }],
      cacheRows: [expiredPrev],
      affectedRows: [{ channelSlug: 'beinsports1', scheduleDate: todayUtc() }],
    });
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: emitSpy,
    });
    expect(r.changed).toBe(0);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('outcome degistiyse affected (channel, date) ciftleri icin emitNotify cagrilir', async () => {
    const expiredPrev = makePrev({
      lookupStatus: 'missing_material',
      lastCheckedAt: new Date(FROZEN_NOW.getTime() - 60 * 60_000),
    });
    const newOutcome = makeOutcome({
      dcCode: 'DC1', lookupStatus: 'found',
      mediaGuid: 'GUID-NEW', matchMethod: 'alias',
      tcSom: 0, tcEom: 4464, ssdbDurationFrames: 4465,
    });
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC1', newOutcome]]));
    const emitSpy = vi.fn().mockResolvedValue(undefined);
    const { prisma } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }],
      cacheRows: [expiredPrev],
      affectedRows: [
        { channelSlug: 'beinsports1', scheduleDate: todayUtc() },
        { channelSlug: 'beinhaber',   scheduleDate: dayUtc('2026-05-28') },
      ],
    });
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: emitSpy,
    });
    expect(r.changed).toBe(1);
    expect(r.notified).toBe(2);
    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(emitSpy).toHaveBeenCalledWith(prisma, expect.anything(), 'beinsports1', '2026-05-27');
    expect(emitSpy).toHaveBeenCalledWith(prisma, expect.anything(), 'beinhaber', '2026-05-28');
  });

  it('affected query non-CANLI + window filter uygular', async () => {
    const newOutcome = makeOutcome({ dcCode: 'DC1', lookupStatus: 'found',
      mediaGuid: 'G', matchMethod: 'alias', tcSom: 0, tcEom: 100, ssdbDurationFrames: 101 });
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC1', newOutcome]]));
    const { prisma, calls } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }],
      cacheRows: [],
      affectedRows: [{ channelSlug: 'beinsports1', scheduleDate: todayUtc() }],
    });
    await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn().mockResolvedValue(undefined),
    });
    // provysFindMany tek cagri: affected pairs query (candidate query artik $queryRaw).
    const affectedArgs = (calls.provysFindMany[0] as { where: Record<string, unknown> }).where;
    expect(affectedArgs.category).toEqual({ not: 'CANLI' });
    expect(affectedArgs.dcCode).toEqual({ in: ['DC1'] });
    const sd = affectedArgs.scheduleDate as { gte: Date; lte: Date };
    expect(sd.gte.toISOString()).toBe('2026-05-27T00:00:00.000Z');
    expect(sd.lte.toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });
});

describe('worker > aynı dcCode birden fazla satirda (multi channel/date)', () => {
  it('tek resolver lookup; her affected pair icin ayri emitNotify', async () => {
    const newOutcome = makeOutcome({
      dcCode: 'DC1', lookupStatus: 'found',
      mediaGuid: 'G', matchMethod: 'alias',
      tcSom: 0, tcEom: 100, ssdbDurationFrames: 101,
    });
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC1', newOutcome]]));
    const emitSpy = vi.fn().mockResolvedValue(undefined);
    const { prisma } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }],  // distinct -> tek satir
      cacheRows: [],
      affectedRows: [
        { channelSlug: 'beinsports1', scheduleDate: todayUtc() },
        { channelSlug: 'beinhaber',   scheduleDate: todayUtc() },
        { channelSlug: 'beinsports1', scheduleDate: dayUtc('2026-05-28') },
      ],
    });
    await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: emitSpy,
    });
    expect(resolverSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledTimes(3);
  });
});

describe('worker > cache write concurrency + per-item failure isolation', () => {
  /** Upsert peak in-flight'ı sayan minimal prisma mock — concurrency limit test'i için. */
  function buildConcurrencyTrackingPrisma(opts: {
    perItemDelayMs: number;
    failIndices?: Set<number>;
    failError?: Error;
  }) {
    let counter = 0;
    let inFlight = 0;
    let peak = 0;
    const upsertOrder: string[] = [];
    let candidateCodes: string[] = [];
    const prisma = {
      async $queryRaw() {
        return candidateCodes.map((dc) => ({ dc_code: dc }));
      },
      provysItem: {
        async findMany() { return []; },
      },
      ssdbMaterialCache: {
        async findMany() { return []; },
        async upsert(args: { where: { dcCode: string } }) {
          const idx = counter++;
          inFlight++;
          peak = Math.max(peak, inFlight);
          try {
            await new Promise((r) => setTimeout(r, opts.perItemDelayMs));
            if (opts.failIndices?.has(idx)) {
              throw opts.failError ?? new Error('P2024 simulated');
            }
            upsertOrder.push(args.where.dcCode);
          } finally {
            inFlight--;
          }
          return null;
        },
      },
    } as never;
    return {
      prisma,
      setCandidateCodes(codes: string[]) { candidateCodes = codes; },
      snapshot: () => ({ peak, count: counter, order: upsertOrder }),
    };
  }

  it('cache write concurrency limit (3) — peak in-flight 3 asar geçmez', async () => {
    // 10 DC, her upsert 30 ms bekler. Sınırsızda peak=10; cfg=3 ile peak<=3.
    const codes = Array.from({ length: 10 }, (_, i) => `DC${i}`);
    const outcomes = new Map(codes.map((c) => [c, makeOutcome({ dcCode: c })]));
    const { prisma, snapshot, setCandidateCodes } = buildConcurrencyTrackingPrisma({ perItemDelayMs: 30 });
    setCandidateCodes(codes);
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: { ...BASE_CFG, cacheWriteConcurrency: 3 },
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: vi.fn().mockResolvedValue(outcomes),
      emitNotifyFn: vi.fn().mockResolvedValue(undefined),
    });
    const snap = snapshot();
    expect(snap.peak).toBeLessThanOrEqual(3);
    expect(snap.peak).toBeGreaterThan(1); // gerçekten paralel çalıştı
    expect(r.cacheWriteSucceeded).toBe(10);
    expect(r.cacheWriteFailed).toBe(0);
  });

  it('cache write concurrency limit clamp = 10 (absolute max)', async () => {
    const codes = Array.from({ length: 20 }, (_, i) => `DC${i}`);
    const outcomes = new Map(codes.map((c) => [c, makeOutcome({ dcCode: c })]));
    const { prisma, snapshot, setCandidateCodes } = buildConcurrencyTrackingPrisma({ perItemDelayMs: 20 });
    setCandidateCodes(codes);
    await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25,
      // env'den 50 verilse bile config.cacheWriteConcurrency clamp ile 10.
      workerConfig: { ...BASE_CFG, cacheWriteConcurrency: 10 },
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: vi.fn().mockResolvedValue(outcomes),
      emitNotifyFn: vi.fn().mockResolvedValue(undefined),
    });
    expect(snapshot().peak).toBeLessThanOrEqual(10);
  });

  it('tek upsert hatası tüm tick\'i öldürmez; cacheWriteFailed sayılır', async () => {
    const codes = ['DC1', 'DC2', 'DC3', 'DC4', 'DC5'];
    const outcomes = new Map(codes.map((c) => [c, makeOutcome({ dcCode: c })]));
    const { prisma, setCandidateCodes } = buildConcurrencyTrackingPrisma({
      perItemDelayMs: 5,
      failIndices: new Set([1, 3]), // 2 fail (idx 1 + 3); 3 success
      failError: new Error('Timed out fetching a new connection from the connection pool'),
    });
    setCandidateCodes(codes);
    const warnSpy = vi.fn();
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: warnSpy, error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: vi.fn().mockResolvedValue(outcomes),
      emitNotifyFn: vi.fn().mockResolvedValue(undefined),
    });
    expect(r.cacheWriteSucceeded).toBe(3);
    expect(r.cacheWriteFailed).toBe(2);
    expect(r.candidates).toBe(5);
    expect(r.processed).toBe(5);
    // Tick throw etmedi → r döndü; warn iki kere çağrıldı
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('tick result summary tüm alanları içerir', async () => {
    const codes = ['DC1', 'DC2', 'DC3'];
    const outcomes = new Map<string, ReturnType<typeof makeOutcome>>([
      ['DC1', makeOutcome({ dcCode: 'DC1', lookupStatus: 'found',
        mediaGuid: 'G1', matchMethod: 'alias', tcSom: 0, tcEom: 100, ssdbDurationFrames: 101 })],
      ['DC2', makeOutcome({ dcCode: 'DC2', lookupStatus: 'missing_material',
        mediaGuid: null, tcSom: null, tcEom: null, ssdbDurationFrames: null })],
      ['DC3', makeOutcome({ dcCode: 'DC3', lookupStatus: 'ssdb_error',
        lastError: 'connect ECONNREFUSED', mediaGuid: null,
        tcSom: null, tcEom: null, ssdbDurationFrames: null })],
    ]);
    const { prisma, setCandidateCodes } = buildConcurrencyTrackingPrisma({ perItemDelayMs: 2 });
    setCandidateCodes(codes);
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: vi.fn().mockResolvedValue(outcomes),
      emitNotifyFn: vi.fn().mockResolvedValue(undefined),
    });
    expect(r.candidates).toBe(3);
    expect(r.processed).toBe(3);
    expect(r.found).toBe(1);
    expect(r.missing).toBe(1);
    expect(r.error).toBe(1);
    expect(r.durationUnknown).toBe(0);
    expect(r.cacheWriteSucceeded).toBe(3);
    expect(r.cacheWriteFailed).toBe(0);
    expect(typeof r.durationMs).toBe('number');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('worker > requestSsdbResolverTick — coalesce + isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetSsdbWorkerStateForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetSsdbWorkerStateForTests();
  });

  it('worker disabled iken trigger NO-OP (runManualTick null)', () => {
    // Hiç set edilmedi → null. Trigger çağrılır, hiçbir yan etki yok.
    expect(() => requestSsdbResolverTick('test:disabled')).not.toThrow();
    vi.advanceTimersByTime(SSDB_TRIGGER_DEBOUNCE_MS + 100);
    // Çağrılabilir bir tick olmadığı için exception yok; sessiz no-op.
  });

  it('kısa sürede çok trigger TEK tick\'e coalesce (debounce 5sn)', async () => {
    const ticks: string[] = [];
    _setRunManualTickForTests(async (reason) => { ticks.push(reason); });

    requestSsdbResolverTick('r1');
    requestSsdbResolverTick('r2');
    requestSsdbResolverTick('r3');

    // Debounce penceresinden önce hiç tick yok
    vi.advanceTimersByTime(SSDB_TRIGGER_DEBOUNCE_MS - 100);
    expect(ticks).toEqual([]);

    // Debounce dolunca tek tick — en son reason coalesced
    vi.advanceTimersByTime(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(ticks.length).toBe(1);
    expect(ticks[0]).toBe('r3');
  });

  it('tick çalışırken yeni trigger paralel başlatmaz; pending → bitince yeniden tetikler', async () => {
    const ticks: string[] = [];
    // İlk tick uzun süren (pending Promise)
    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((r) => { resolveFirst = r; });
    let count = 0;
    _setRunManualTickForTests(async (reason) => {
      count++;
      ticks.push(reason);
      if (count === 1) await firstDone;
    });

    requestSsdbResolverTick('first');
    vi.advanceTimersByTime(SSDB_TRIGGER_DEBOUNCE_MS + 10);
    await Promise.resolve();
    await Promise.resolve();
    expect(ticks).toEqual(['first']);

    // Çalışırken ikinci trigger — pending bayrağı set olmalı, ikinci tick başlamaz
    requestSsdbResolverTick('second');
    vi.advanceTimersByTime(SSDB_TRIGGER_DEBOUNCE_MS + 100);
    await Promise.resolve();
    expect(ticks).toEqual(['first']);  // hâlâ tek tick

    // İlk tick'i bitir, pending tetiklenmeli
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
    // Pending trigger yeni debounce başlatır
    vi.advanceTimersByTime(SSDB_TRIGGER_DEBOUNCE_MS + 10);
    await Promise.resolve();
    await Promise.resolve();
    expect(ticks.length).toBe(2);
    // Pending reason 'second' (en son trigger)
    expect(ticks[1]).toBe('second');
  });
});
