import { describe, it, expect } from 'vitest';
import {
  loadSsdbConfig,
  assertSsdbConfigReady,
  type SsdbConfig,
} from './ssdb.config.js';

/** Tam-dolu env (resolver ON). Her test gerekirse alanlari override eder. */
function fullEnv(over: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    PROVYS_SSDB_RESOLVER: 'on',
    SSDB_HOST: '172.28.208.20',
    SSDB_PORT: '60813',
    SSDB_DATABASE: 'LIGTV-SSDB',
    SSDB_USER: 'read1',
    SSDB_PASSWORD: 'super-secret-PW',
    ...over,
  };
}

describe('ssdb.config > loadSsdbConfig — flag parsing', () => {
  it('PROVYS_SSDB_RESOLVER unset/empty -> enabled false', () => {
    expect(loadSsdbConfig({}).enabled).toBe(false);
    expect(loadSsdbConfig({ PROVYS_SSDB_RESOLVER: '' }).enabled).toBe(false);
  });

  it('truthy variants (1/true/yes/on, case-insensitive) -> enabled true', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'Yes', 'on', 'ON']) {
      expect(loadSsdbConfig({ PROVYS_SSDB_RESOLVER: v }).enabled).toBe(true);
    }
  });

  it('falsy non-empty values -> enabled false', () => {
    for (const v of ['0', 'false', 'no', 'off', 'random']) {
      expect(loadSsdbConfig({ PROVYS_SSDB_RESOLVER: v }).enabled).toBe(false);
    }
  });
});

describe('ssdb.config > loadSsdbConfig — disabled mode tolerates missing env', () => {
  it('flag off + tum SSDB_* eksik -> loadSsdbConfig hata vermez', () => {
    const c = loadSsdbConfig({});
    expect(c.enabled).toBe(false);
    expect(c.host).toBeNull();
    expect(c.port).toBeNull();
    expect(c.database).toBeNull();
    expect(c.user).toBeNull();
    expect(c.password).toBeNull();
  });
});

describe('ssdb.config > loadSsdbConfig — port parsing', () => {
  it('numeric in range -> integer', () => {
    expect(loadSsdbConfig(fullEnv({ SSDB_PORT: '60813' })).port).toBe(60813);
    expect(loadSsdbConfig(fullEnv({ SSDB_PORT: '1' })).port).toBe(1);
    expect(loadSsdbConfig(fullEnv({ SSDB_PORT: '65535' })).port).toBe(65535);
  });

  it('non-numeric / out-of-range -> null', () => {
    expect(loadSsdbConfig(fullEnv({ SSDB_PORT: 'abc' })).port).toBeNull();
    expect(loadSsdbConfig(fullEnv({ SSDB_PORT: '0' })).port).toBeNull();
    expect(loadSsdbConfig(fullEnv({ SSDB_PORT: '-1' })).port).toBeNull();
    expect(loadSsdbConfig(fullEnv({ SSDB_PORT: '65536' })).port).toBeNull();
    expect(loadSsdbConfig(fullEnv({ SSDB_PORT: '60813.5' })).port).toBeNull();
  });

  it('empty/unset -> null', () => {
    expect(loadSsdbConfig(fullEnv({ SSDB_PORT: '' })).port).toBeNull();
    expect(loadSsdbConfig({ ...fullEnv(), SSDB_PORT: undefined }).port).toBeNull();
  });
});

describe('ssdb.config > loadSsdbConfig — defaults', () => {
  it('SSDB_DEFAULT_FPS unset -> 25', () => {
    expect(loadSsdbConfig({}).defaultFps).toBe(25);
  });

  it('SSDB_DEFAULT_FPS explicit -> integer', () => {
    expect(loadSsdbConfig({ SSDB_DEFAULT_FPS: '50' }).defaultFps).toBe(50);
  });

  it('SSDB_DEFAULT_FPS invalid -> 25 fallback', () => {
    expect(loadSsdbConfig({ SSDB_DEFAULT_FPS: 'abc' }).defaultFps).toBe(25);
    expect(loadSsdbConfig({ SSDB_DEFAULT_FPS: '-5' }).defaultFps).toBe(25);
    expect(loadSsdbConfig({ SSDB_DEFAULT_FPS: '0' }).defaultFps).toBe(25);
  });

  it('timeout defaults: connect=10000, request=10000', () => {
    const c = loadSsdbConfig({});
    expect(c.connectTimeoutMs).toBe(10000);
    expect(c.requestTimeoutMs).toBe(10000);
  });

  it('pool defaults: max=2, min=0', () => {
    const c = loadSsdbConfig({});
    expect(c.poolMax).toBe(2);
    expect(c.poolMin).toBe(0);
  });

  it('explicit override pool/timeout', () => {
    const c = loadSsdbConfig({
      SSDB_CONNECT_TIMEOUT_MS: '15000',
      SSDB_REQUEST_TIMEOUT_MS: '20000',
      SSDB_POOL_MAX: '5',
      SSDB_POOL_MIN: '1',
    });
    expect(c.connectTimeoutMs).toBe(15000);
    expect(c.requestTimeoutMs).toBe(20000);
    expect(c.poolMax).toBe(5);
    expect(c.poolMin).toBe(1);
  });
});

describe('ssdb.config > loadSsdbConfig — trim & password preservation', () => {
  it('host/user/database trim edilir', () => {
    const c = loadSsdbConfig(fullEnv({ SSDB_HOST: '  172.28.208.20  ', SSDB_USER: '  read1  ' }));
    expect(c.host).toBe('172.28.208.20');
    expect(c.user).toBe('read1');
  });

  it('password trim YAPMAZ (boslukli sifre destegi)', () => {
    const c = loadSsdbConfig(fullEnv({ SSDB_PASSWORD: '  pass with spaces  ' }));
    expect(c.password).toBe('  pass with spaces  ');
  });

  it('empty password -> null', () => {
    const c = loadSsdbConfig(fullEnv({ SSDB_PASSWORD: '' }));
    expect(c.password).toBeNull();
  });
});

describe('ssdb.config > assertSsdbConfigReady', () => {
  it('enabled false -> explicit "disabled" error', () => {
    const c = loadSsdbConfig({});
    expect(() => assertSsdbConfigReady(c)).toThrow(/disabled/i);
  });

  it('enabled true + tum env tam -> hata yok', () => {
    const c = loadSsdbConfig(fullEnv());
    expect(() => assertSsdbConfigReady(c)).not.toThrow();
  });

  it('eksik SSDB_HOST -> mesajda env adi var', () => {
    const c = loadSsdbConfig(fullEnv({ SSDB_HOST: '' }));
    expect(() => assertSsdbConfigReady(c)).toThrow(/SSDB_HOST/);
  });

  it('eksik SSDB_PORT (non-numeric) -> mesajda env adi var', () => {
    const c = loadSsdbConfig(fullEnv({ SSDB_PORT: 'not-a-number' }));
    expect(() => assertSsdbConfigReady(c)).toThrow(/SSDB_PORT/);
  });

  it('eksik SSDB_DATABASE/SSDB_USER/SSDB_PASSWORD birarada -> hepsi mesajda', () => {
    const c = loadSsdbConfig(
      fullEnv({ SSDB_DATABASE: '', SSDB_USER: '', SSDB_PASSWORD: '' }),
    );
    let captured: string | null = null;
    try {
      assertSsdbConfigReady(c);
    } catch (err) {
      captured = (err as Error).message;
    }
    expect(captured).toMatch(/SSDB_DATABASE/);
    expect(captured).toMatch(/SSDB_USER/);
    expect(captured).toMatch(/SSDB_PASSWORD/);
  });

  it('error message ASLA password DEGERINI icermez', () => {
    const SECRET = 'TopSecretP@ssw0rd-XYZ-987';
    const c = loadSsdbConfig(fullEnv({ SSDB_PASSWORD: SECRET, SSDB_HOST: '' }));
    let captured: string | null = null;
    try {
      assertSsdbConfigReady(c);
    } catch (err) {
      captured = (err as Error).message;
    }
    expect(captured).not.toBeNull();
    expect(captured!.includes(SECRET)).toBe(false);
  });

  it('defaultFps <= 0 -> hata (env override invalid)', () => {
    // loadSsdbConfig fallback 25; defensif ek kontrol: dogrudan SsdbConfig
    // objesi 0 fps ile gelse assertReady reddetmeli (tip-guvenligi koruyucu).
    const manual: SsdbConfig = {
      ...loadSsdbConfig(fullEnv()),
      defaultFps: 0,
    };
    expect(() => assertSsdbConfigReady(manual)).toThrow(/SSDB_DEFAULT_FPS/);
  });
});
