import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ssdbRoutes } from './ssdb.routes.js';
import type { SsdbMaterialLookupOutcome } from './ssdb-material-resolver.js';

/**
 * Fastify lightweight harness — gercek DB veya SSDB acmaz; Prisma decorator
 * olarak mock injection. preHandler `requireGroup` stub (auth bypass).
 */

const FROZEN_NOW = new Date('2026-05-27T08:00:00.000Z');

interface PrismaMockOpts {
  cacheStats?: { lookupStatus: string; _count: { _all: number } }[];
  latestRow?: { lastCheckedAt: Date } | null;
  prevCacheRow?: unknown;
  /** Bulk endpoint icin — `findMany IN [...]` cevabi. */
  prevCacheRows?: unknown[];
  affectedRows?: { channelSlug: string; scheduleDate: Date }[];
  cacheTableError?: Error;
}

function buildPrismaMock(opts: PrismaMockOpts = {}) {
  const calls = {
    cacheGroupBy: [] as unknown[],
    cacheFindFirst: [] as unknown[],
    cacheFindUnique: [] as unknown[],
    cacheFindMany: [] as unknown[],
    cacheUpsert: [] as unknown[],
    provysFindMany: [] as unknown[],
    executeRaw: [] as unknown[],
  };
  return {
    ssdbMaterialCache: {
      async groupBy(args: unknown) {
        calls.cacheGroupBy.push(args);
        if (opts.cacheTableError) throw opts.cacheTableError;
        return opts.cacheStats ?? [];
      },
      async findFirst(args: unknown) {
        calls.cacheFindFirst.push(args);
        if (opts.cacheTableError) throw opts.cacheTableError;
        return opts.latestRow ?? null;
      },
      async findUnique(args: unknown) {
        calls.cacheFindUnique.push(args);
        return opts.prevCacheRow ?? null;
      },
      async findMany(args: unknown) {
        calls.cacheFindMany.push(args);
        return opts.prevCacheRows ?? [];
      },
      async upsert(args: unknown) {
        calls.cacheUpsert.push(args);
        return null;
      },
    },
    provysItem: {
      async findMany(args: unknown) {
        calls.provysFindMany.push(args);
        return opts.affectedRows ?? [];
      },
    },
    $executeRaw: vi.fn(async (...args: unknown[]) => {
      calls.executeRaw.push(args);
    }),
    calls,
  };
}

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

async function buildApp(args: {
  prisma: ReturnType<typeof buildPrismaMock>;
  resolverOutcomes?: Map<string, SsdbMaterialLookupOutcome>;
  resolverThrow?: Error;
  emitFn?: ReturnType<typeof vi.fn>;
  env?: Record<string, string>;
}): Promise<{
  app: FastifyInstance;
  resolverSpy: ReturnType<typeof vi.fn>;
  emitSpy: ReturnType<typeof vi.fn>;
}> {
  const app = Fastify({ logger: false });
  app.decorate('prisma', args.prisma as never);
  app.decorate('requireGroup', () => async () => undefined);
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', issues: error.issues });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ statusCode: status, error: (error as Error).message });
  });

  const resolverSpy = vi.fn().mockImplementation(async (codes: string[]) => {
    if (args.resolverThrow) throw args.resolverThrow;
    return args.resolverOutcomes ?? new Map(codes.map((c) => [c, outcome({ dcCode: c })]));
  });
  const emitSpy = args.emitFn ?? vi.fn().mockResolvedValue(undefined);

  await app.register(ssdbRoutes, {
    prefix: '/api/v1/ssdb',
    resolver: resolverSpy as never,
    emitNotifyFn: emitSpy as never,
    now: () => FROZEN_NOW,
    todayIstanbul: () => '2026-05-27',
  } as never);
  await app.ready();
  return { app, resolverSpy, emitSpy };
}

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  // Clean ssdb env defaults
  delete process.env.PROVYS_SSDB_RESOLVER;
  delete process.env.SSDB_HOST;
  delete process.env.SSDB_PORT;
  delete process.env.SSDB_DATABASE;
  delete process.env.SSDB_USER;
  delete process.env.SSDB_PASSWORD;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('GET /ssdb/health', () => {
  it('flag off -> enabled:false, cacheTableReachable true (table mevcut), stats 0', async () => {
    const prisma = buildPrismaMock({ cacheStats: [] });
    const { app } = await buildApp({ prisma });
    const r = await app.inject({ method: 'GET', url: '/api/v1/ssdb/health' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.enabled).toBe(false);
    expect(body.configured).toBe(false);
    expect(body.cacheTableReachable).toBe(true);
    expect(body.cacheStats.total).toBe(0);
    expect(body.latestCheckedAt).toBeNull();
    await app.close();
  });

  it('flag on + config tam -> enabled:true configured:true', async () => {
    process.env.PROVYS_SSDB_RESOLVER = 'on';
    process.env.SSDB_HOST = 'h'; process.env.SSDB_PORT = '60813';
    process.env.SSDB_DATABASE = 'db'; process.env.SSDB_USER = 'u';
    process.env.SSDB_PASSWORD = 'pw';
    const prisma = buildPrismaMock({ cacheStats: [] });
    const { app } = await buildApp({ prisma });
    const r = await app.inject({ method: 'GET', url: '/api/v1/ssdb/health' });
    const body = r.json();
    expect(body.enabled).toBe(true);
    expect(body.configured).toBe(true);
    await app.close();
  });

  it('cache groupBy ile stats hesaplanir (her 4 status)', async () => {
    const prisma = buildPrismaMock({
      cacheStats: [
        { lookupStatus: 'found',             _count: { _all: 100 } },
        { lookupStatus: 'missing_material',  _count: { _all: 12 } },
        { lookupStatus: 'duration_unknown',  _count: { _all: 3 } },
        { lookupStatus: 'ssdb_error',        _count: { _all: 2 } },
      ],
      latestRow: { lastCheckedAt: new Date('2026-05-27T07:30:00.000Z') },
    });
    const { app } = await buildApp({ prisma });
    const r = await app.inject({ method: 'GET', url: '/api/v1/ssdb/health' });
    const body = r.json();
    expect(body.cacheStats).toEqual({
      total: 117, found: 100, missingMaterial: 12, durationUnknown: 3, ssdbError: 2,
    });
    expect(body.latestCheckedAt).toBe('2026-05-27T07:30:00.000Z');
    await app.close();
  });

  it('cache table unreachable (migration apply edilmemis) -> cacheTableReachable:false, API crash YOK', async () => {
    const prisma = buildPrismaMock({
      cacheTableError: new Error('relation "ssdb_material_cache" does not exist'),
    });
    const { app } = await buildApp({ prisma });
    const r = await app.inject({ method: 'GET', url: '/api/v1/ssdb/health' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.cacheTableReachable).toBe(false);
    expect(body.cacheStats.total).toBe(0);
    expect(body.latestCheckedAt).toBeNull();
    await app.close();
  });

  it('health endpoint SSDB SQL Server resolver cagirmaz', async () => {
    const prisma = buildPrismaMock({});
    const { app, resolverSpy } = await buildApp({ prisma });
    await app.inject({ method: 'GET', url: '/api/v1/ssdb/health' });
    expect(resolverSpy).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /ssdb/cache/refresh — validation + flag guards', () => {
  it('body missing dcCode -> 400 (Zod)', async () => {
    const prisma = buildPrismaMock({});
    const { app } = await buildApp({ prisma });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh',
      payload: {}, headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('body dcCode empty/whitespace -> 400', async () => {
    const prisma = buildPrismaMock({});
    const { app } = await buildApp({ prisma });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh',
      payload: { dcCode: '   ' }, headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('flag off -> 503, resolver ASLA cagrilmaz', async () => {
    const prisma = buildPrismaMock({});
    const { app, resolverSpy } = await buildApp({ prisma });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh',
      payload: { dcCode: 'DC1' }, headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().message).toMatch(/disabled/i);
    expect(resolverSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('flag on + SSDB_HOST eksik -> 503, resolver ASLA cagrilmaz', async () => {
    process.env.PROVYS_SSDB_RESOLVER = 'on';
    // SSDB_HOST eksik
    process.env.SSDB_PORT = '60813';
    process.env.SSDB_DATABASE = 'db';
    process.env.SSDB_USER = 'u';
    process.env.SSDB_PASSWORD = 'pw';
    const prisma = buildPrismaMock({});
    const { app, resolverSpy } = await buildApp({ prisma });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh',
      payload: { dcCode: 'DC1' }, headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().message).toMatch(/config incomplete/i);
    expect(resolverSpy).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /ssdb/cache/refresh — happy path + notify', () => {
  function setEnvFull() {
    process.env.PROVYS_SSDB_RESOLVER = 'on';
    process.env.SSDB_HOST = 'h'; process.env.SSDB_PORT = '60813';
    process.env.SSDB_DATABASE = 'db'; process.env.SSDB_USER = 'u';
    process.env.SSDB_PASSWORD = 'pw';
  }

  it('resolver found + cache empty (no prev) -> upsert + response, changed=true', async () => {
    setEnvFull();
    const prisma = buildPrismaMock({
      prevCacheRow: null,
      affectedRows: [{ channelSlug: 'beinsports1', scheduleDate: new Date('2026-05-27T00:00:00.000Z') }],
    });
    const outcomes = new Map([['DC1', outcome({ dcCode: 'DC1', mediaGuid: 'NEW' })]]);
    const { app, emitSpy } = await buildApp({ prisma, resolverOutcomes: outcomes });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh',
      payload: { dcCode: 'DC1' }, headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.dcCode).toBe('DC1');
    expect(body.lookupStatus).toBe('found');
    expect(body.mediaGuid).toBe('NEW');
    expect(body.ssdbDurationFrames).toBe(4465);
    expect(body.ssdbDurationTimecode).toBe('00:02:58:15');
    expect(body.changed).toBe(true);
    expect(prisma.calls.cacheUpsert).toHaveLength(1);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('resolver outcome aynisi -> changed=false, emitNotify cagrilmaz', async () => {
    setEnvFull();
    const sameOutcome = outcome({ dcCode: 'DC1', mediaGuid: 'GUID-1' });
    const prevSame = {
      dcCode: 'DC1', lookupStatus: 'found', mediaGuid: 'GUID-1',
      matchMethod: 'alias', tcSom: 0, tcEom: 4464,
      ssdbDurationFrames: 4465,
      lastCheckedAt: new Date(FROZEN_NOW.getTime() - 60 * 60_000),
      lastError: null,
    };
    const prisma = buildPrismaMock({
      prevCacheRow: prevSame,
      affectedRows: [{ channelSlug: 'beinsports1', scheduleDate: new Date('2026-05-27T00:00:00.000Z') }],
    });
    const { app, emitSpy } = await buildApp({
      prisma,
      resolverOutcomes: new Map([['DC1', sameOutcome]]),
    });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh',
      payload: { dcCode: 'DC1' }, headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().changed).toBe(false);
    expect(prisma.calls.cacheUpsert).toHaveLength(1); // upsert yine yapilir (lastCheckedAt bump)
    expect(emitSpy).not.toHaveBeenCalled();
    expect(prisma.calls.provysFindMany).toHaveLength(0); // affected query yok
    await app.close();
  });

  it('resolver missing_material -> cache upsert + response lookupStatus missing_material', async () => {
    setEnvFull();
    const prisma = buildPrismaMock({});
    const outcomes = new Map([
      ['DC404', outcome({ dcCode: 'DC404', lookupStatus: 'missing_material',
        mediaGuid: null, matchMethod: null, tcSom: null, tcEom: null,
        ssdbDurationFrames: null, ssdbDurationTimecode: null, frameRate: null })],
    ]);
    const { app } = await buildApp({ prisma, resolverOutcomes: outcomes });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh',
      payload: { dcCode: 'DC404' }, headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().lookupStatus).toBe('missing_material');
    expect(r.json().mediaGuid).toBeNull();
    expect(prisma.calls.cacheUpsert).toHaveLength(1);
    const upsertArgs = prisma.calls.cacheUpsert[0] as { create: { lastFoundAt: unknown } };
    expect(upsertArgs.create.lastFoundAt).toBeNull();
    await app.close();
  });

  it('resolver ssdb_error -> cache upsert lastError, response lookupStatus ssdb_error', async () => {
    setEnvFull();
    const prisma = buildPrismaMock({});
    const outcomes = new Map([
      ['DC1', outcome({ dcCode: 'DC1', lookupStatus: 'ssdb_error',
        mediaGuid: null, tcSom: null, tcEom: null,
        ssdbDurationFrames: null, ssdbDurationTimecode: null,
        lastError: 'connect ECONNREFUSED' })],
    ]);
    const { app } = await buildApp({ prisma, resolverOutcomes: outcomes });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh',
      payload: { dcCode: 'DC1' }, headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().lookupStatus).toBe('ssdb_error');
    const upsertArgs = prisma.calls.cacheUpsert[0] as { create: { lastError: unknown } };
    expect(upsertArgs.create.lastError).toBe('connect ECONNREFUSED');
    await app.close();
  });

  it('affected query WHERE: CANLI hariç + today..today+14 window', async () => {
    setEnvFull();
    const prisma = buildPrismaMock({
      prevCacheRow: null,
      affectedRows: [{ channelSlug: 'beinsports1', scheduleDate: new Date('2026-05-27T00:00:00.000Z') }],
    });
    const { app } = await buildApp({
      prisma,
      resolverOutcomes: new Map([['DC1', outcome({ dcCode: 'DC1' })]]),
    });
    await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh',
      payload: { dcCode: 'DC1' }, headers: { 'content-type': 'application/json' },
    });
    expect(prisma.calls.provysFindMany).toHaveLength(1);
    const affectedArgs = prisma.calls.provysFindMany[0] as {
      where: Record<string, unknown>;
    };
    expect(affectedArgs.where.category).toEqual({ not: 'CANLI' });
    expect(affectedArgs.where.dcCode).toEqual({ in: ['DC1'] });
    const sd = affectedArgs.where.scheduleDate as { gte: Date; lte: Date };
    expect(sd.gte.toISOString()).toBe('2026-05-27T00:00:00.000Z');
    expect(sd.lte.toISOString()).toBe('2026-06-10T00:00:00.000Z');
    await app.close();
  });

  it('changed=true ama affected pair yok (geçmiş tarih veya tüm CANLI) -> notify=0', async () => {
    setEnvFull();
    const prisma = buildPrismaMock({
      prevCacheRow: null,
      affectedRows: [], // hiç eligible pair yok
    });
    const { app, emitSpy } = await buildApp({
      prisma,
      resolverOutcomes: new Map([['DC1', outcome({ dcCode: 'DC1' })]]),
    });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh',
      payload: { dcCode: 'DC1' }, headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().changed).toBe(true);
    expect(emitSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('changed=true + 2 affected pair -> 2 emitNotify cagrisi', async () => {
    setEnvFull();
    const prisma = buildPrismaMock({
      prevCacheRow: null,
      affectedRows: [
        { channelSlug: 'beinsports1', scheduleDate: new Date('2026-05-27T00:00:00.000Z') },
        { channelSlug: 'beinhaber',   scheduleDate: new Date('2026-05-28T00:00:00.000Z') },
      ],
    });
    const { app, emitSpy } = await buildApp({
      prisma,
      resolverOutcomes: new Map([['DC1', outcome({ dcCode: 'DC1' })]]),
    });
    await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh',
      payload: { dcCode: 'DC1' }, headers: { 'content-type': 'application/json' },
    });
    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(emitSpy).toHaveBeenCalledWith(prisma, expect.anything(), 'beinsports1', '2026-05-27');
    expect(emitSpy).toHaveBeenCalledWith(prisma, expect.anything(), 'beinhaber',   '2026-05-28');
    await app.close();
  });
});

describe('POST /ssdb/cache/refresh/bulk', () => {
  it('body dcCodes bos array -> 400 (Zod min(1))', async () => {
    const prisma = buildPrismaMock();
    const { app, resolverSpy } = await buildApp({ prisma });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh/bulk',
      payload: { dcCodes: [] },
    });
    expect(r.statusCode).toBe(400);
    expect(resolverSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('body dcCodes 101 eleman -> 400 (Zod max(100))', async () => {
    const prisma = buildPrismaMock();
    const { app, resolverSpy } = await buildApp({ prisma });
    const codes = Array.from({ length: 101 }, (_, i) => `DC${i}`);
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh/bulk',
      payload: { dcCodes: codes },
    });
    expect(r.statusCode).toBe(400);
    expect(resolverSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('SSDB disabled -> 503, resolver ASLA cagrilmaz', async () => {
    delete process.env.PROVYS_SSDB_RESOLVER;
    const prisma = buildPrismaMock();
    const { app, resolverSpy } = await buildApp({ prisma });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh/bulk',
      payload: { dcCodes: ['DC1', 'DC2'] },
    });
    expect(r.statusCode).toBe(503);
    expect(resolverSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('duplicate dcCode dedup edilir + input sirasi korunur', async () => {
    process.env.PROVYS_SSDB_RESOLVER = 'on';
    process.env.SSDB_HOST = '1.2.3.4';
    process.env.SSDB_PORT = '60813';
    process.env.SSDB_DATABASE = 'X';
    process.env.SSDB_USER = 'u';
    process.env.SSDB_PASSWORD = 'p';
    const prisma = buildPrismaMock({ prevCacheRows: [] });
    const resolverOutcomes = new Map<string, SsdbMaterialLookupOutcome>([
      ['DC1', outcome({ dcCode: 'DC1' })],
      ['DC2', outcome({ dcCode: 'DC2' })],
    ]);
    const { app, resolverSpy } = await buildApp({ prisma, resolverOutcomes });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh/bulk',
      payload: { dcCodes: ['DC1', 'DC2', 'DC1', 'DC2'] }, // 2 dedup
    });
    expect(r.statusCode).toBe(200);
    // Resolver sadece dedup edilmis array ile cagrilir
    expect(resolverSpy).toHaveBeenCalledTimes(1);
    expect(resolverSpy.mock.calls[0][0]).toEqual(['DC1', 'DC2']);
    const body = r.json() as { results: { dcCode: string }[] };
    expect(body.results.map((x) => x.dcCode)).toEqual(['DC1', 'DC2']);
    await app.close();
  });

  it('multi DC + karisik changed -> notify SADECE changed icin tek call', async () => {
    process.env.PROVYS_SSDB_RESOLVER = 'on';
    process.env.SSDB_HOST = '1.2.3.4';
    process.env.SSDB_PORT = '60813';
    process.env.SSDB_DATABASE = 'X';
    process.env.SSDB_USER = 'u';
    process.env.SSDB_PASSWORD = 'p';
    // DC1 prev: missing_material -> outcome found = CHANGED
    // DC2 prev: found GUID-2 -> outcome found GUID-2 = SAME (changed=false)
    const prevRows = [
      { dcCode: 'DC1', lookupStatus: 'missing_material', mediaGuid: null,
        matchMethod: null, tcSom: null, tcEom: null, ssdbDurationFrames: null,
        lastCheckedAt: new Date(FROZEN_NOW.getTime() - 60_000), lastError: null },
      { dcCode: 'DC2', lookupStatus: 'found', mediaGuid: 'GUID-2',
        matchMethod: 'alias', tcSom: 0, tcEom: 100, ssdbDurationFrames: 101,
        lastCheckedAt: new Date(FROZEN_NOW.getTime() - 60_000), lastError: null },
    ];
    const prisma = buildPrismaMock({
      prevCacheRows: prevRows,
      affectedRows: [{ channelSlug: 'beinsports1', scheduleDate: new Date('2026-05-27T00:00:00Z') }],
    });
    const resolverOutcomes = new Map<string, SsdbMaterialLookupOutcome>([
      ['DC1', outcome({ dcCode: 'DC1', lookupStatus: 'found',
        mediaGuid: 'GUID-1', matchMethod: 'alias', tcSom: 0, tcEom: 100, ssdbDurationFrames: 101 })],
      ['DC2', outcome({ dcCode: 'DC2', lookupStatus: 'found',
        mediaGuid: 'GUID-2', matchMethod: 'alias', tcSom: 0, tcEom: 100, ssdbDurationFrames: 101 })],
    ]);
    const emitSpy = vi.fn().mockResolvedValue(undefined);
    const { app } = await buildApp({ prisma, resolverOutcomes, emitFn: emitSpy });
    const r = await app.inject({
      method: 'POST', url: '/api/v1/ssdb/cache/refresh/bulk',
      payload: { dcCodes: ['DC1', 'DC2'] },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      results: { dcCode: string; changed: boolean }[];
      notified: number;
    };
    // DC1 changed (missing -> found), DC2 unchanged (found -> found ayni alanlar)
    const dc1 = body.results.find((x) => x.dcCode === 'DC1')!;
    const dc2 = body.results.find((x) => x.dcCode === 'DC2')!;
    expect(dc1.changed).toBe(true);
    expect(dc2.changed).toBe(false);
    // Notify yalniz DC1 icin tek pair (affected query bir kere)
    expect(prisma.calls.provysFindMany).toHaveLength(1);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(body.notified).toBe(1);
    // Upsert iki kez (her DC icin)
    expect(prisma.calls.cacheUpsert).toHaveLength(2);
    await app.close();
  });
});
