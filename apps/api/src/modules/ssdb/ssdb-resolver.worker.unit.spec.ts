import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runSsdbResolverTickOnce,
  isSsdbCacheOutcomeChanged,
  addDaysToIstanbulDate,
  loadSsdbWorkerConfig,
  startSsdbResolverWorker,
  _resetSsdbWorkerStateForTests,
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
  intervalMs: 60_000,
  maxPerTick: 500,
  batchSize: 50,
  ttlFoundMin: 720,
  ttlDurationUnknownMin: 120,
  ttlMissingMin: 30,
  ttlErrorMin: 5,
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

/** Prisma mock — sadece worker'in dokundugu method'lar; her cagri kaydedilir. */
function buildPrismaMock(opts: {
  provysRows?: { dcCode: string }[];
  cacheRows?: SsdbCachePrevRow[];
  affectedRows?: { channelSlug: string; scheduleDate: Date }[];
}) {
  const calls = {
    provysFindMany: [] as unknown[],
    cacheFindMany: [] as unknown[],
    cacheUpsert: [] as unknown[],
  };
  let provysCallCount = 0;
  const prisma = {
    provysItem: {
      async findMany(args: unknown) {
        provysCallCount++;
        calls.provysFindMany.push(args);
        // Ilk cagri: distinct dcCode (window+CANLI filter)
        if (provysCallCount === 1) return opts.provysRows ?? [];
        // Ikinci cagri: affected pairs
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
  it('defaults', () => {
    const c = loadSsdbWorkerConfig({});
    expect(c.windowFutureDays).toBe(14);
    expect(c.intervalMs).toBe(60_000);
    expect(c.maxPerTick).toBe(500);
    expect(c.batchSize).toBe(50);
    expect(c.ttlFoundMin).toBe(720);
    expect(c.ttlDurationUnknownMin).toBe(120);
    expect(c.ttlMissingMin).toBe(30);
    expect(c.ttlErrorMin).toBe(5);
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
      SSDB_HOST: '172.28.208.20',
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

describe('worker > runSsdbResolverTickOnce — window filter', () => {
  it('candidate query WHERE clause: scheduleDate >= todayUtc, <= todayUtc + 14d, category != CANLI, dcCode != null', async () => {
    const { prisma, calls } = buildPrismaMock({ provysRows: [], cacheRows: [] });
    await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: vi.fn(), emitNotifyFn: vi.fn(),
    });

    expect(calls.provysFindMany.length).toBeGreaterThanOrEqual(1);
    const args = (calls.provysFindMany[0] as { where: Record<string, unknown> }).where;
    expect(args.dcCode).toEqual({ not: null });
    expect(args.category).toEqual({ not: 'CANLI' });
    const sd = args.scheduleDate as { gte: Date; lte: Date };
    expect(sd.gte.toISOString()).toBe('2026-05-27T00:00:00.000Z');
    expect(sd.lte.toISOString()).toBe('2026-06-10T00:00:00.000Z'); // today + 14
  });

  it('empty provys window -> processed 0, resolver ASLA cagrilmaz', async () => {
    const resolverSpy = vi.fn().mockResolvedValue(new Map());
    const { prisma } = buildPrismaMock({ provysRows: [], cacheRows: [] });
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    expect(r).toEqual({ candidates: 0, processed: 0, changed: 0, notified: 0 });
    expect(resolverSpy).not.toHaveBeenCalled();
  });
});

describe('worker > runSsdbResolverTickOnce — TTL filter (per lookup_status)', () => {
  it('cache yok -> candidate', async () => {
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC1', makeOutcome({ dcCode: 'DC1' })]]));
    const { prisma } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }],
      cacheRows: [],
    });
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    expect(r.candidates).toBe(1);
    expect(resolverSpy).toHaveBeenCalledWith(['DC1'], expect.objectContaining({ batchSize: 50 }));
  });

  it('found cache TTL dolmamis (1 saat oncesi, ttl=720dk=12s) -> candidate DEGIL', async () => {
    const oneHourAgo = new Date(FROZEN_NOW.getTime() - 60 * 60_000);
    const resolverSpy = vi.fn();
    const { prisma } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }],
      cacheRows: [makePrev({ lookupStatus: 'found', lastCheckedAt: oneHourAgo })],
    });
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    expect(r.candidates).toBe(0);
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  it('found cache TTL dolmus (13 saat oncesi) -> candidate', async () => {
    const thirteenHoursAgo = new Date(FROZEN_NOW.getTime() - 13 * 60 * 60_000);
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC1', makeOutcome({ dcCode: 'DC1' })]]));
    const { prisma } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }],
      cacheRows: [makePrev({ lookupStatus: 'found', lastCheckedAt: thirteenHoursAgo })],
    });
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    expect(r.candidates).toBe(1);
  });

  it('missing_material TTL=30dk dolmus (45dk oncesi) -> candidate', async () => {
    const fortyFiveMinAgo = new Date(FROZEN_NOW.getTime() - 45 * 60_000);
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC1', makeOutcome({ dcCode: 'DC1', lookupStatus: 'missing_material' })]]));
    const { prisma } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }],
      cacheRows: [makePrev({ lookupStatus: 'missing_material', lastCheckedAt: fortyFiveMinAgo })],
    });
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    expect(r.candidates).toBe(1);
  });

  it('ssdb_error TTL=5dk dolmus (10dk oncesi) -> candidate', async () => {
    const tenMinAgo = new Date(FROZEN_NOW.getTime() - 10 * 60_000);
    const resolverSpy = vi.fn().mockResolvedValue(new Map([['DC1', makeOutcome({ dcCode: 'DC1' })]]));
    const { prisma } = buildPrismaMock({
      provysRows: [{ dcCode: 'DC1' }],
      cacheRows: [makePrev({ lookupStatus: 'ssdb_error', lastCheckedAt: tenMinAgo })],
    });
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: BASE_CFG,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    expect(r.candidates).toBe(1);
  });

  it('maxPerTick limiti uygulanir', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => ({ dcCode: `DC${i}` }));
    const resolverSpy = vi.fn().mockResolvedValue(new Map());
    const { prisma } = buildPrismaMock({ provysRows: codes, cacheRows: [] });
    const cfg = { ...BASE_CFG, maxPerTick: 3 };
    const r = await runSsdbResolverTickOnce({
      prisma, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      defaultFrameRate: 25, workerConfig: cfg,
      now: () => FROZEN_NOW, todayIstanbul: () => FROZEN_TODAY_ISTANBUL,
      resolver: resolverSpy, emitNotifyFn: vi.fn(),
    });
    expect(r.candidates).toBe(3);
    expect(resolverSpy).toHaveBeenCalledWith(['DC0', 'DC1', 'DC2'], expect.any(Object));
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
    // 2. provysFindMany cagrisi affected query
    const affectedArgs = (calls.provysFindMany[1] as { where: Record<string, unknown> }).where;
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
