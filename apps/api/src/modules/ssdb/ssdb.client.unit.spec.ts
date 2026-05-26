import { describe, it, expect, beforeEach } from 'vitest';
import sql from 'mssql';
import {
  querySsdb,
  getSsdbPool,
  _resetSsdbClientStateForTests,
  _hasSsdbPoolForTests,
  type SsdbQueryParam,
} from './ssdb.client.js';
import { loadSsdbConfig } from './ssdb.config.js';

/**
 * Tum testler poolFactory inject ederek mssql network'ten tamamen kacinir.
 * Production caller'lari `getSsdbPool` default'una guvenmeli; bu testler
 * helper'in input binding ve query rounting davranisini izole dogrular.
 */

interface InputCall {
  name: string;
  type: unknown;
  value: unknown;
}

function fakePool(opts: {
  recordset?: unknown[];
  onQuery?: (q: string) => void;
  throwOnQuery?: Error;
}) {
  const inputs: InputCall[] = [];
  const queries: string[] = [];
  const pool = {
    connected: true,
    request: () => ({
      input(name: string, type: unknown, value: unknown) {
        inputs.push({ name, type, value });
        return this;
      },
      async query(q: string) {
        queries.push(q);
        opts.onQuery?.(q);
        if (opts.throwOnQuery) throw opts.throwOnQuery;
        return { recordset: opts.recordset ?? [] };
      },
    }),
  } as unknown as sql.ConnectionPool;
  return { pool, inputs, queries };
}

beforeEach(() => {
  _resetSsdbClientStateForTests();
});

describe('ssdb.client > querySsdb — parameter binding', () => {
  it('hicbir param yoksa request.input cagrilmaz, query verilen string ile aynen calisir', async () => {
    const { pool, inputs, queries } = fakePool({ recordset: [{ x: 1 }] });
    const result = await querySsdb<{ x: number }>('SELECT 1 AS x', [], async () => pool);
    expect(inputs).toEqual([]);
    expect(queries).toEqual(['SELECT 1 AS x']);
    expect(result).toEqual([{ x: 1 }]);
  });

  it('coklu param request.input ile sirayla bind edilir', async () => {
    const { pool, inputs, queries } = fakePool({ recordset: [] });
    const params: SsdbQueryParam[] = [
      { name: 'code0', type: sql.NVarChar(40), value: 'DC00040962' },
      { name: 'code1', type: sql.NVarChar(40), value: 'DC00052002' },
    ];
    await querySsdb(
      'SELECT m.id FROM dbo.MEDIA m WHERE m.alias IN (@code0, @code1)',
      params,
      async () => pool,
    );
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ name: 'code0', value: 'DC00040962' });
    expect(inputs[1]).toMatchObject({ name: 'code1', value: 'DC00052002' });
    expect(queries[0]).toContain('@code0');
    expect(queries[0]).toContain('@code1');
  });

  it('recordset jenerik tip ile return edilir', async () => {
    const { pool } = fakePool({ recordset: [{ id: 'GUID-1', alias: 'DC00040962' }] });
    interface Row { id: string; alias: string; }
    const r = await querySsdb<Row>('SELECT id, alias FROM dbo.MEDIA', [], async () => pool);
    expect(r[0].alias).toBe('DC00040962');
  });

  it('query exception caller\'a propagate edilir', async () => {
    const { pool } = fakePool({ throwOnQuery: new Error('login failed for read1') });
    await expect(
      querySsdb('SELECT 1', [], async () => pool),
    ).rejects.toThrow(/login failed/);
  });
});

describe('ssdb.client > getSsdbPool — lazy / disabled guard', () => {
  it('config disabled iken getSsdbPool ASLA pool olusturmaz — explicit hata', async () => {
    expect(_hasSsdbPoolForTests()).toBe(false);
    const disabled = loadSsdbConfig({}); // PROVYS_SSDB_RESOLVER unset -> enabled:false
    await expect(getSsdbPool(disabled)).rejects.toThrow(/disabled/i);
    // Hata sonrasi state temiz; pool init edilmedi.
    expect(_hasSsdbPoolForTests()).toBe(false);
  });

  it('config enabled ama eksik env -> "missing required env" hatasi', async () => {
    const partial = loadSsdbConfig({
      PROVYS_SSDB_RESOLVER: 'on',
      SSDB_HOST: '172.28.208.20',
      // PORT/DATABASE/USER/PASSWORD eksik
    });
    await expect(getSsdbPool(partial)).rejects.toThrow(/missing required env/);
    expect(_hasSsdbPoolForTests()).toBe(false);
  });

  it('eksik env hata mesajinda password DEGERI ASLA gorunmez', async () => {
    const SECRET = 'TopSecret-PW-987';
    const partial = loadSsdbConfig({
      PROVYS_SSDB_RESOLVER: 'on',
      SSDB_HOST: '',
      SSDB_PORT: '60813',
      SSDB_DATABASE: 'LIGTV-SSDB',
      SSDB_USER: 'read1',
      SSDB_PASSWORD: SECRET,
    });
    try {
      await getSsdbPool(partial);
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/SSDB_HOST/);
      expect(msg.includes(SECRET)).toBe(false);
    }
    expect(_hasSsdbPoolForTests()).toBe(false);
  });
});

describe('ssdb.client > poolFactory injection (querySsdb)', () => {
  it('querySsdb poolFactory ile config.enabled=false olsa BILE network acmadan calisir', async () => {
    // Bu davranis test-only inject sayesinde; production caller'lari default
    // getSsdbPool kullanir ve enabled=false reddedilir.
    const { pool } = fakePool({ recordset: [{ probe: 1 }] });
    const result = await querySsdb('SELECT 1 AS probe', [], async () => pool);
    expect(result).toEqual([{ probe: 1 }]);
    expect(_hasSsdbPoolForTests()).toBe(false);
  });
});
