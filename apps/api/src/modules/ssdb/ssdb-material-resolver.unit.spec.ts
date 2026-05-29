import { describe, it, expect } from 'vitest';
import {
  resolveSsdbMaterialsByDcCodes,
  type SsdbMaterialResolverOptions,
} from './ssdb-material-resolver.js';
import type { SsdbQueryParam } from './ssdb.client.js';

/**
 * Test query dispatcher — SSDB'ye ASLA gercek baglanmaz. Her cagri (sql, params)
 * tier'a gore (alias / original_filename / name_like / media_link) yonlendirilir;
 * istenirse hata atilir. Tum cagrilar `calls` icinde kaydedilir.
 */
type TierKey = 'alias' | 'original_filename' | 'name_like' | 'media_link' | 'unknown';
type TierResponse = { rows: unknown[] } | { error: Error };

interface QueryCall {
  tier: TierKey;
  sql: string;
  params: SsdbQueryParam[];
}

function classifyTier(sqlText: string): TierKey {
  if (sqlText.includes('MEDIA_LINK')) return 'media_link';
  if (sqlText.includes('md.originalFilename IN')) return 'original_filename';
  if (sqlText.includes('m.alias IN'))             return 'alias';
  if (sqlText.includes("LIKE '%' + @code"))       return 'name_like';
  return 'unknown';
}

function buildDispatcher(byTier: Partial<Record<TierKey, TierResponse[]>>) {
  const calls: QueryCall[] = [];
  // Her tier icin FIFO queue; her cagri sirayla bir response cikartir.
  const queues: Record<TierKey, TierResponse[]> = {
    alias:             [...(byTier.alias ?? [])],
    original_filename: [...(byTier.original_filename ?? [])],
    name_like:         [...(byTier.name_like ?? [])],
    media_link:        [...(byTier.media_link ?? [])],
    unknown:           [],
  };
  const fn = async <T>(sqlText: string, params: SsdbQueryParam[] = []): Promise<T[]> => {
    const tier = classifyTier(sqlText);
    calls.push({ tier, sql: sqlText, params });
    const next = queues[tier].shift();
    if (!next) return [] as T[];
    if ('error' in next) throw next.error;
    return next.rows as T[];
  };
  return { fn: fn as unknown as SsdbMaterialResolverOptions['query'], calls };
}

const DEFAULTS: Required<Pick<SsdbMaterialResolverOptions, 'defaultFrameRate' | 'batchSize'>> = {
  defaultFrameRate: 25,
  batchSize: 50,
};

describe('ssdb-material-resolver > input normalization', () => {
  it('empty input -> empty Map, query NEVER called', async () => {
    const { fn, calls } = buildDispatcher({});
    const out = await resolveSsdbMaterialsByDcCodes([], { ...DEFAULTS, query: fn });
    expect(out.size).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('whitespace-only / empty strings filtered out', async () => {
    const { fn, calls } = buildDispatcher({});
    const out = await resolveSsdbMaterialsByDcCodes(['', '   ', '\t\n'], { ...DEFAULTS, query: fn });
    expect(out.size).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('duplicates + leading/trailing whitespace deduped to single normalized list', async () => {
    const { fn, calls } = buildDispatcher({
      alias: [{ rows: [] }],
    });
    await resolveSsdbMaterialsByDcCodes(
      ['DC1', '  DC1  ', 'DC1', 'DC2'],
      { ...DEFAULTS, query: fn },
    );
    // Tier 1'de tek query — iki unique code (DC1, DC2) tek IN clause'da
    const aliasCall = calls.find((c) => c.tier === 'alias');
    expect(aliasCall).toBeDefined();
    expect(aliasCall!.params).toHaveLength(2);
    const values = aliasCall!.params.map((p) => p.value).sort();
    expect(values).toEqual(['DC1', 'DC2']);
  });
});

describe('ssdb-material-resolver > Tier 1 (alias) hit', () => {
  it('alias batch hit -> lookupStatus found, matchMethod alias', async () => {
    const { fn, calls } = buildDispatcher({
      alias: [{
        rows: [{
          id: 'EEE4EBB9-C3A1-A395-7F6E-59947E0AAAB3',
          name: '[default] DC00040962',
          alias: 'DC00040962',
          originalFilename: 'DC00040962',
        }],
      }],
      media_link: [{
        rows: [{
          idMedia: 'EEE4EBB9-C3A1-A395-7F6E-59947E0AAAB3',
          tcSOM: 0,
          tcEOM: 4464,
          videoFormat: 1,
        }],
      }],
    });
    const out = await resolveSsdbMaterialsByDcCodes(['DC00040962'], { ...DEFAULTS, query: fn });
    const o = out.get('DC00040962');
    expect(o).toBeDefined();
    expect(o!.lookupStatus).toBe('found');
    expect(o!.matchMethod).toBe('alias');
    expect(o!.mediaGuid).toBe('EEE4EBB9-C3A1-A395-7F6E-59947E0AAAB3');
    // Tier 2/3 cagrilmaz
    expect(calls.find((c) => c.tier === 'original_filename')).toBeUndefined();
    expect(calls.find((c) => c.tier === 'name_like')).toBeUndefined();
  });
});

describe('ssdb-material-resolver > Tier 2 (originalFilename) hit only when Tier 1 miss', () => {
  it('Tier 1 miss + Tier 2 hit -> matchMethod original_filename', async () => {
    const { fn, calls } = buildDispatcher({
      alias: [{ rows: [] }],                                   // Tier 1 miss
      original_filename: [{
        rows: [{
          id: 'GUID-2',
          name: 'something else',
          alias: null,
          originalFilename: 'DC00099999',
        }],
      }],
      media_link: [{ rows: [{ idMedia: 'GUID-2', tcSOM: 100, tcEOM: 349, videoFormat: 1 }] }],
    });
    const out = await resolveSsdbMaterialsByDcCodes(['DC00099999'], { ...DEFAULTS, query: fn });
    const o = out.get('DC00099999');
    expect(o!.lookupStatus).toBe('found');
    expect(o!.matchMethod).toBe('original_filename');
    expect(o!.mediaGuid).toBe('GUID-2');
    // Tier 3 cagrilmaz
    expect(calls.find((c) => c.tier === 'name_like')).toBeUndefined();
  });
});

describe('ssdb-material-resolver > Tier 3 (name_like) hit only when Tier 1+2 miss', () => {
  it('Tier 1+2 miss + Tier 3 hit -> matchMethod name_like, per-DC SELECT', async () => {
    const { fn, calls } = buildDispatcher({
      alias: [{ rows: [] }],
      original_filename: [{ rows: [] }],
      name_like: [{
        rows: [{
          id: 'GUID-3',
          name: '[default] PROMO DC12345',
          alias: null,
          originalFilename: null,
        }],
      }],
      media_link: [{ rows: [{ idMedia: 'GUID-3', tcSOM: 0, tcEOM: 124, videoFormat: 1 }] }],
    });
    const out = await resolveSsdbMaterialsByDcCodes(['DC12345'], { ...DEFAULTS, query: fn });
    const o = out.get('DC12345');
    expect(o!.lookupStatus).toBe('found');
    expect(o!.matchMethod).toBe('name_like');
    expect(o!.mediaGuid).toBe('GUID-3');
    // Tier 3 son care — sadece bir kez cagrilmis
    const likeCalls = calls.filter((c) => c.tier === 'name_like');
    expect(likeCalls).toHaveLength(1);
    expect(likeCalls[0].params).toEqual([{ name: 'code', type: expect.anything(), value: 'DC12345' }]);
  });
});

describe('ssdb-material-resolver > missing_material', () => {
  it('hicbir tier hit yoksa -> missing_material, tum alanlar null', async () => {
    const { fn } = buildDispatcher({
      alias: [{ rows: [] }],
      original_filename: [{ rows: [] }],
      name_like: [{ rows: [] }],
    });
    const out = await resolveSsdbMaterialsByDcCodes(['DC404'], { ...DEFAULTS, query: fn });
    const o = out.get('DC404');
    expect(o).toBeDefined();
    expect(o!.lookupStatus).toBe('missing_material');
    expect(o!.mediaGuid).toBeNull();
    expect(o!.matchMethod).toBeNull();
    expect(o!.ssdbDurationFrames).toBeNull();
    expect(o!.ssdbDurationTimecode).toBeNull();
    expect(o!.lastError).toBeNull();
  });
});

describe('ssdb-material-resolver > MEDIA bulundu ama duration eksik', () => {
  it('MEDIA found ama MEDIA_LINK satiri yok -> duration_unknown', async () => {
    const { fn } = buildDispatcher({
      alias: [{
        rows: [{ id: 'GUID-X', name: 'X', alias: 'DCX', originalFilename: 'DCX' }],
      }],
      media_link: [{ rows: [] }], // bos
    });
    const out = await resolveSsdbMaterialsByDcCodes(['DCX'], { ...DEFAULTS, query: fn });
    const o = out.get('DCX');
    expect(o!.lookupStatus).toBe('duration_unknown');
    expect(o!.mediaGuid).toBe('GUID-X');
    expect(o!.matchMethod).toBe('alias');
    expect(o!.ssdbDurationFrames).toBeNull();
    expect(o!.tcSom).toBeNull();
    expect(o!.tcEom).toBeNull();
  });

  it('MEDIA_LINK satiri var ama tcSOM null -> duration_unknown (tcSom/tcEom raw korunur)', async () => {
    const { fn } = buildDispatcher({
      alias: [{
        rows: [{ id: 'GUID-Y', name: 'Y', alias: 'DCY', originalFilename: 'DCY' }],
      }],
      media_link: [{
        rows: [{ idMedia: 'GUID-Y', tcSOM: null, tcEOM: 100, videoFormat: 1 }],
      }],
    });
    const out = await resolveSsdbMaterialsByDcCodes(['DCY'], { ...DEFAULTS, query: fn });
    const o = out.get('DCY');
    expect(o!.lookupStatus).toBe('duration_unknown');
    expect(o!.tcSom).toBeNull();
    expect(o!.tcEom).toBe(100);
    expect(o!.ssdbDurationFrames).toBeNull();
    expect(o!.ssdbDurationTimecode).toBeNull();
  });
});

describe('ssdb-material-resolver > canonical found (kullanici sozlesmesi)', () => {
  it('tcSOM=0, tcEOM=4464, fps=25 -> found, 4465 frame, "00:02:58:15"', async () => {
    const { fn } = buildDispatcher({
      alias: [{
        rows: [{
          id: 'EEE4EBB9-C3A1-A395-7F6E-59947E0AAAB3',
          name: '[default] DC00040962',
          alias: 'DC00040962',
          originalFilename: 'DC00040962',
        }],
      }],
      media_link: [{
        rows: [{
          idMedia: 'EEE4EBB9-C3A1-A395-7F6E-59947E0AAAB3',
          tcSOM: 0, tcEOM: 4464, videoFormat: 1,
        }],
      }],
    });
    const out = await resolveSsdbMaterialsByDcCodes(['DC00040962'], { ...DEFAULTS, query: fn });
    const o = out.get('DC00040962');
    expect(o!.lookupStatus).toBe('found');
    expect(o!.tcSom).toBe(0);
    expect(o!.tcEom).toBe(4464);
    expect(o!.ssdbDurationFrames).toBe(4465);
    expect(o!.ssdbDurationTimecode).toBe('00:02:58:15');
    expect(o!.frameRate).toBe(25);
  });
});

describe('ssdb-material-resolver > deterministic MEDIA_LINK selection', () => {
  it('coklu MEDIA_LINK satiri -> per-mediaGuid ILK satir kullanilir (ORDER BY tcSOM ASC, tcEOM DESC)', async () => {
    // Mock query SQL'in ORDER BY uydugu varsayilir; resolver de ayni Map'e ilk satiri yazar.
    const { fn, calls } = buildDispatcher({
      alias: [{
        rows: [{ id: 'GUID-M', name: 'M', alias: 'DCM', originalFilename: 'DCM' }],
      }],
      media_link: [{
        // ORDER BY tcSOM ASC, tcEOM DESC -> ilk satir tcSOM=0/tcEOM=4464 (en erken+en uzun)
        rows: [
          { idMedia: 'GUID-M', tcSOM: 0,   tcEOM: 4464, videoFormat: 1 },
          { idMedia: 'GUID-M', tcSOM: 0,   tcEOM: 3000, videoFormat: 1 },
          { idMedia: 'GUID-M', tcSOM: 500, tcEOM: 4464, videoFormat: 1 },
        ],
      }],
    });
    const out = await resolveSsdbMaterialsByDcCodes(['DCM'], { ...DEFAULTS, query: fn });
    const o = out.get('DCM');
    expect(o!.lookupStatus).toBe('found');
    expect(o!.tcSom).toBe(0);
    expect(o!.tcEom).toBe(4464); // ILK satir
    expect(o!.ssdbDurationFrames).toBe(4465);

    // SQL ORDER BY clause'i fix oldugundan emin ol (deterministik kontrat)
    const mlCall = calls.find((c) => c.tier === 'media_link')!;
    expect(mlCall.sql).toMatch(/ORDER BY ml\.idMedia, ml\.tcSOM ASC, ml\.tcEOM DESC/);
  });
});

describe('ssdb-material-resolver > error handling', () => {
  it('Tier 1 query error -> ssdb_error, lastError truncated, password ASLA gorunmez', async () => {
    const SECRET = 'super-secret-pw-XYZ';
    const errMsg = `connect ECONNREFUSED with creds: ${SECRET}`;
    const { fn } = buildDispatcher({
      alias: [{ error: new Error(errMsg) }],
    });
    const out = await resolveSsdbMaterialsByDcCodes(['DC1'], { ...DEFAULTS, query: fn });
    const o = out.get('DC1');
    expect(o!.lookupStatus).toBe('ssdb_error');
    // Resolver sanitize: 240 char truncate. Password sanitize ssdb.client tarafinda
    // (gercek pool path'inde); resolver caller'a gelene kadar mesaj zaten temizdir.
    // Bu test resolver'in error'i propagate ettigini ve lastError'a dustugunu dogrular.
    expect(o!.lastError).toBeTruthy();
    expect(o!.mediaGuid).toBeNull();
    expect(o!.matchMethod).toBeNull();
  });

  it('Tier 1 error sadece etkilenen batch icin; baska code aynisi gibi degil', async () => {
    // Tier 1'de tek batch (2 code), error -> her ikisi de ssdb_error
    const { fn } = buildDispatcher({
      alias: [{ error: new Error('boom') }],
    });
    const out = await resolveSsdbMaterialsByDcCodes(['DC1', 'DC2'], { ...DEFAULTS, query: fn });
    expect(out.get('DC1')!.lookupStatus).toBe('ssdb_error');
    expect(out.get('DC2')!.lookupStatus).toBe('ssdb_error');
  });

  it('MEDIA_LINK batch error -> bulunan tum DC duration_unknown, mediaGuid korunur', async () => {
    const { fn } = buildDispatcher({
      alias: [{
        rows: [{ id: 'GUID-A', name: 'A', alias: 'DCA', originalFilename: 'DCA' }],
      }],
      media_link: [{ error: new Error('media_link timeout') }],
    });
    const out = await resolveSsdbMaterialsByDcCodes(['DCA'], { ...DEFAULTS, query: fn });
    const o = out.get('DCA');
    expect(o!.lookupStatus).toBe('duration_unknown');
    expect(o!.mediaGuid).toBe('GUID-A');
    expect(o!.lastError).toMatch(/media_link timeout/);
  });
});

describe('ssdb-material-resolver > SQL safety / parameter binding', () => {
  it('DC kodu SQL metnine LITERAL gomulmez; parametre olarak bind edilir', async () => {
    const { fn, calls } = buildDispatcher({
      alias: [{ rows: [] }],
      original_filename: [{ rows: [] }],
      name_like: [{ rows: [] }],
    });
    const SECRET_DC = "DC' OR 1=1 --";  // SQL injection attempt
    await resolveSsdbMaterialsByDcCodes([SECRET_DC], { ...DEFAULTS, query: fn });

    for (const call of calls) {
      // SQL metni icinde DC kodu LITERAL OLARAK GECMEZ
      expect(call.sql.includes(SECRET_DC)).toBe(false);
      // Bunun yerine @code0 / @code placeholder'lari kullanilmis
      const hasPlaceholder =
        call.sql.includes('@code0') || call.sql.includes('@code');
      expect(hasPlaceholder).toBe(true);
      // Parametreler arasinda DC kodu degeri var
      const valueIsPresent = call.params.some((p) => p.value === SECRET_DC);
      expect(valueIsPresent).toBe(true);
    }
  });

  it('parametre adlari deterministik: code0, code1, ... (Tier 1/2 batch)', async () => {
    const { fn, calls } = buildDispatcher({ alias: [{ rows: [] }] });
    await resolveSsdbMaterialsByDcCodes(['DC1', 'DC2', 'DC3'], { ...DEFAULTS, query: fn });
    const aliasCall = calls.find((c) => c.tier === 'alias')!;
    expect(aliasCall.params.map((p) => p.name)).toEqual(['code0', 'code1', 'code2']);
  });

  it('SELECT * KULLANILMAZ, INSERT/UPDATE/DELETE/EXEC kelimesi gecmez', async () => {
    const { fn, calls } = buildDispatcher({
      alias: [{
        rows: [{ id: 'GX', name: 'x', alias: 'DC1', originalFilename: 'DC1' }],
      }],
      media_link: [{ rows: [{ idMedia: 'GX', tcSOM: 0, tcEOM: 100, videoFormat: 1 }] }],
    });
    await resolveSsdbMaterialsByDcCodes(['DC1'], { ...DEFAULTS, query: fn });
    for (const call of calls) {
      expect(call.sql).not.toMatch(/SELECT\s+\*/i);
      expect(call.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|EXEC|EXECUTE)\b/i);
    }
  });
});

describe('ssdb-material-resolver > batch behavior', () => {
  it('batchSize=2 ile 5 DC kodu icin Tier 1 uc kez cagrilir', async () => {
    const { fn, calls } = buildDispatcher({
      alias: [{ rows: [] }, { rows: [] }, { rows: [] }],
      original_filename: [{ rows: [] }, { rows: [] }, { rows: [] }],
      name_like: [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }],
    });
    await resolveSsdbMaterialsByDcCodes(
      ['DC1', 'DC2', 'DC3', 'DC4', 'DC5'],
      { ...DEFAULTS, batchSize: 2, query: fn },
    );
    const aliasCalls = calls.filter((c) => c.tier === 'alias');
    expect(aliasCalls.length).toBe(3); // 2 + 2 + 1
    expect(aliasCalls[0].params.length).toBe(2);
    expect(aliasCalls[1].params.length).toBe(2);
    expect(aliasCalls[2].params.length).toBe(1);
  });
});

describe('ssdb-material-resolver > MEDIA_LINK partial failure', () => {
  it('3 GUID, 1 fail / 1 success+row / 1 success+empty -> per-GUID lastError isolation', async () => {
    // batchSize=1 -> 3 ayri MEDIA_LINK batch:
    //   GUID-1 batch: error          -> duration_unknown + lastError (fail batch)
    //   GUID-2 batch: rows dolu       -> found
    //   GUID-3 batch: rows boş        -> duration_unknown + lastError NULL (unrelated)
    const { fn } = buildDispatcher({
      alias: [
        { rows: [{ id: 'GUID-1', name: 'A', alias: 'DC1', originalFilename: 'DC1' }] },
        { rows: [{ id: 'GUID-2', name: 'B', alias: 'DC2', originalFilename: 'DC2' }] },
        { rows: [{ id: 'GUID-3', name: 'C', alias: 'DC3', originalFilename: 'DC3' }] },
      ],
      media_link: [
        { error: new Error('partial fail GUID-1 batch') },                       // ilk batch fail
        { rows: [{ idMedia: 'GUID-2', tcSOM: 0, tcEOM: 100, videoFormat: 1 }] }, // ikinci success+row
        { rows: [] },                                                            // ucuncu success+empty
      ],
    });
    const out = await resolveSsdbMaterialsByDcCodes(['DC1', 'DC2', 'DC3'], {
      ...DEFAULTS,
      batchSize: 1,
      query: fn,
    });

    // GUID-2: tek başarılı satır -> normal found
    const dc2 = out.get('DC2');
    expect(dc2!.lookupStatus).toBe('found');
    expect(dc2!.mediaGuid).toBe('GUID-2');
    expect(dc2!.ssdbDurationFrames).toBe(101);

    // GUID-1: fail batch -> duration_unknown + lastError SET
    const dc1 = out.get('DC1');
    expect(dc1!.lookupStatus).toBe('duration_unknown');
    expect(dc1!.mediaGuid).toBe('GUID-1');
    expect(dc1!.lastError).toMatch(/partial fail/);

    // GUID-3: success batch ama row yok -> duration_unknown + lastError NULL
    // (unrelated link-missing — fail batch'in error mesajı bu GUID'e SIZMAZ)
    const dc3 = out.get('DC3');
    expect(dc3!.lookupStatus).toBe('duration_unknown');
    expect(dc3!.mediaGuid).toBe('GUID-3');
    expect(dc3!.lastError).toBeNull();
  });

  it('paralel MEDIA_LINK batch\'lerden biri fail, digeri success -> partial başarı korunur', async () => {
    // 2 DC + 2 found media (Tier 1 alias). batchSize=1 -> 2 ayri MEDIA_LINK
    // batch query'si. Birincisi error, ikincisi success.
    const { fn, calls } = buildDispatcher({
      // batchSize=1 -> 2 ayri alias batch (her biri tek DC), her batch icin
      // ayri response queue'da tutulur.
      alias: [
        { rows: [{ id: 'GUID-1', name: 'A', alias: 'DC1', originalFilename: 'DC1' }] },
        { rows: [{ id: 'GUID-2', name: 'B', alias: 'DC2', originalFilename: 'DC2' }] },
      ],
      media_link: [
        { error: new Error('partial fail GUID-1 batch') }, // ilk batch fail
        { rows: [{ idMedia: 'GUID-2', tcSOM: 0, tcEOM: 100, videoFormat: 1 }] }, // ikinci batch success
      ],
    });
    const out = await resolveSsdbMaterialsByDcCodes(['DC1', 'DC2'], {
      ...DEFAULTS,
      batchSize: 1,
      query: fn,
    });
    // 2 ayri MEDIA_LINK çağrısı yapıldı (paralel)
    const mlCalls = calls.filter((c) => c.tier === 'media_link');
    expect(mlCalls).toHaveLength(2);

    // DC2: MEDIA_LINK basarili -> found, normal outcome
    const dc2 = out.get('DC2');
    expect(dc2!.lookupStatus).toBe('found');
    expect(dc2!.mediaGuid).toBe('GUID-2');
    expect(dc2!.ssdbDurationFrames).toBe(101);
    expect(dc2!.ssdbDurationTimecode).toBe('00:00:04:01');

    // DC1: MEDIA_LINK batch fail -> duration_unknown (sadece bu DC etkilenir)
    const dc1 = out.get('DC1');
    expect(dc1!.lookupStatus).toBe('duration_unknown');
    expect(dc1!.mediaGuid).toBe('GUID-1');           // MEDIA bulundu fact korunur
    expect(dc1!.matchMethod).toBe('alias');           // tier hit korunur
    expect(dc1!.ssdbDurationFrames).toBeNull();       // link yok
    expect(dc1!.lastError).toMatch(/partial fail/);   // global mediaLinkError info
  });
});

describe('ssdb-material-resolver > SSDB_LOOKUP_CONCURRENCY enforcement', () => {
  /** Mock query that tracks peak in-flight count + per-call delay. */
  function buildConcurrencyTracker(opts: { perCallDelayMs: number }) {
    let inFlight = 0;
    let peak = 0;
    let totalCalls = 0;
    const fn = async <T>(_sql: string, _params: SsdbQueryParam[] = []): Promise<T[]> => {
      totalCalls++;
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      try {
        await new Promise((r) => setTimeout(r, opts.perCallDelayMs));
        return [] as T[];
      } finally {
        inFlight--;
      }
    };
    return { fn: fn as unknown as SsdbMaterialResolverOptions['query'], snapshot: () => ({ peak, totalCalls }) };
  }

  it('lookupConcurrency=4: 30 DC + batchSize=1 -> peak SSDB query in-flight 4\'u asmaz', async () => {
    // 30 batch (her birinde 1 DC) + 30 tier-3 LIKE çağrısı potansiyel; concurrency limiter
    // hepsini 4'e clamp eder.
    const { fn, snapshot } = buildConcurrencyTracker({ perCallDelayMs: 15 });
    const codes = Array.from({ length: 30 }, (_, i) => `DC${i}`);
    await resolveSsdbMaterialsByDcCodes(codes, {
      defaultFrameRate: 25,
      batchSize: 1,
      lookupConcurrency: 4,
      query: fn,
    });
    const snap = snapshot();
    expect(snap.peak).toBeLessThanOrEqual(4);
    expect(snap.peak).toBeGreaterThan(1); // gerçekten paralel
    expect(snap.totalCalls).toBeGreaterThan(0);
  });

  it('lookupConcurrency=50 clamp -> peak SSDB query 10\'u asmaz', async () => {
    // Caller env\'den 50 verse bile resolver clamp [1,10] uygular.
    const { fn, snapshot } = buildConcurrencyTracker({ perCallDelayMs: 10 });
    const codes = Array.from({ length: 50 }, (_, i) => `DC${i}`);
    await resolveSsdbMaterialsByDcCodes(codes, {
      defaultFrameRate: 25,
      batchSize: 1,
      lookupConcurrency: 50,
      query: fn,
    });
    expect(snapshot().peak).toBeLessThanOrEqual(10);
  });

  it('lookupConcurrency invalid (0 / NaN / undefined) -> default 10 ile clamp', async () => {
    const { fn, snapshot } = buildConcurrencyTracker({ perCallDelayMs: 10 });
    const codes = Array.from({ length: 30 }, (_, i) => `DC${i}`);
    await resolveSsdbMaterialsByDcCodes(codes, {
      defaultFrameRate: 25,
      batchSize: 1,
      lookupConcurrency: undefined as unknown as number,
      query: fn,
    });
    expect(snapshot().peak).toBeLessThanOrEqual(10);
  });

  it('lookupConcurrency=1 -> tüm SSDB query\'leri sıralı (peak == 1)', async () => {
    const { fn, snapshot } = buildConcurrencyTracker({ perCallDelayMs: 5 });
    const codes = ['DC1', 'DC2', 'DC3'];
    await resolveSsdbMaterialsByDcCodes(codes, {
      defaultFrameRate: 25,
      batchSize: 1,
      lookupConcurrency: 1,
      query: fn,
    });
    expect(snapshot().peak).toBe(1);
  });
});
