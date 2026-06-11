import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildStpRequestBody,
  submitStpJobEndpoint,
  tokenExtensionEndpoint,
  ropcLoginEndpoint,
  postSubmitStpJob,
  postRopcLogin,
  createCtmsTokenManager,
  AvidCtmsError,
} from './avid.ctms.js';
import type { AvidConfig } from './avid.config.js';

/**
 * CTMS (Cloud UX submitSTPJob) unit testleri — fetch stub, GERÇEK AĞ YOK.
 * Gövde/endpoint/token yöneticisi davranışı. 2026-06-01 HAR'dan türetildi.
 */

function makeConfig(overrides: Partial<AvidConfig> = {}): AvidConfig {
  return {
    enabled: true, mockMode: false,
    interplayUrl: 'http://avid.test/services', user: 'u', password: 'p',
    workspace: 'interplay://BSVMWG/', requestTimeoutMs: 5000,
    searchRootUri: 'interplay://BSVMWG/Projects/', workgroup: 'BSVMWG',
    restoreProfile: 'P', restoreService: 'com.avid.dms.restore',
    clouduxUrl: 'https://cloudux.test', clouduxRealm: 'REALM1', clouduxToken: 'tok-secret',
    clouduxUser: null, clouduxPassword: null, clouduxClientBasic: null,
    stpDevice: 'MCR', stpProfile: 'MCR', clouduxInsecureTls: true,
    ...overrides,
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('buildStpRequestBody', () => {
  it('HAR ile birebir alanlar (mobId ham, nodeId, processName, videoId)', () => {
    const json = buildStpRequestBody({
      realm: 'REALM1', mobId: 'MOB1', processName: 'PROC', videoId: 'DC1',
      device: 'MCR', profile: 'MCR',
    });
    const o = JSON.parse(json) as { stpRequestDTO: Record<string, unknown> };
    expect(o.stpRequestDTO).toEqual({
      device: 'MCR', burnGraphics: false, highPriority: false, overwrite: false,
      mobId: 'MOB1', nodeId: 'interplay:REALM1:sequence:MOB1',
      processName: 'PROC', profile: 'MCR', videoId: 'DC1',
    });
  });
});

describe('endpoint builders', () => {
  it('submitStpJobEndpoint realm gömer + trailing slash temizler', () => {
    expect(submitStpJobEndpoint('https://x.test/', 'R')).toBe(
      'https://x.test/apis/avid.pam.stp;version=1;realm=R/submitSTPJob',
    );
  });
  it('tokenExtensionEndpoint', () => {
    expect(tokenExtensionEndpoint('https://x.test')).toBe('https://x.test/auth/tokens/current/extension');
  });
});

describe('postSubmitStpJob', () => {
  it('başarı: jobId + mcdsStatusURL parse eder', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () => JSON.stringify({
        errorSet: [], errors: [],
        responseData: JSON.stringify({ jobId: 'J1', mcdsStatusURL: 'https://mcds-host:8443/STPService/jobs/status/' }),
      }),
    })));
    const r = await postSubmitStpJob(makeConfig(), 'tok-secret', {
      realm: 'REALM1', mobId: 'M1', processName: 'P', videoId: 'DC1', device: 'MCR', profile: 'MCR',
    });
    expect(r).toEqual({ jobId: 'J1', mcdsStatusURL: 'https://mcds-host:8443/STPService/jobs/status/' });
  });

  it('cookie auth + JSON content-type header', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () => JSON.stringify({ errorSet: [], errors: [], responseData: JSON.stringify({ jobId: 'J' }) }),
    }));
    vi.stubGlobal('fetch', fetchFn);
    await postSubmitStpJob(makeConfig(), 'TOKEN123', {
      realm: 'R', mobId: 'M', processName: 'P', videoId: 'V', device: 'MCR', profile: 'MCR',
    });
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }])[1];
    expect(init.headers.Cookie).toBe('avidAccessToken=TOKEN123');
    expect(init.headers['Content-Type']).toMatch(/application\/json/);
  });

  it('errorSet dolu → AvidCtmsError(CTMS_ERROR)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () => JSON.stringify({ errorSet: [{ message: 'x' }], errors: [], responseData: '' }),
    })));
    await expect(postSubmitStpJob(makeConfig(), 't', {
      realm: 'R', mobId: 'M', processName: 'P', videoId: 'V', device: 'MCR', profile: 'MCR',
    })).rejects.toThrowError(AvidCtmsError);
  });

  it('401 → AUTH; token mesaja sızmaz', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'tok-secret leak?' })));
    await expect(postSubmitStpJob(makeConfig(), 'tok-secret', {
      realm: 'R', mobId: 'M', processName: 'P', videoId: 'V', device: 'MCR', profile: 'MCR',
    })).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('jobId yoksa CTMS_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () => JSON.stringify({ errorSet: [], errors: [], responseData: JSON.stringify({ noJob: true }) }),
    })));
    await expect(postSubmitStpJob(makeConfig(), 't', {
      realm: 'R', mobId: 'M', processName: 'P', videoId: 'V', device: 'MCR', profile: 'MCR',
    })).rejects.toThrow(/jobId yok/i);
  });
});

describe('createCtmsTokenManager', () => {
  it('getToken başlangıç token döner', () => {
    const m = createCtmsTokenManager(makeConfig());
    expect(m.getToken()).toBe('tok-secret');
  });

  it('extendOnce: extension POST çağırır, ok ise true', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ accessToken: 'tok-secret' }) }));
    vi.stubGlobal('fetch', fetchFn);
    const m = createCtmsTokenManager(makeConfig());
    expect(await m.extendOnce()).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cloudux.test/auth/tokens/current/extension');
    expect(init.method).toBe('POST');
  });

  it('extendOnce: non-ok → false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    const m = createCtmsTokenManager(makeConfig());
    expect(await m.extendOnce()).toBe(false);
  });

  it('start: interval ile periyodik extendOnce; stop durdurur', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchFn);
    const m = createCtmsTokenManager(makeConfig(), { intervalMs: 1000 });
    m.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(3);
    m.stop();
    const after = fetchFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchFn.mock.calls.length).toBe(after); // stop sonrası artmaz
  });
});

describe('ropcLoginEndpoint + postRopcLogin', () => {
  it('endpoint = /auth/sso/login/oauth2/ad', () => {
    expect(ropcLoginEndpoint('https://x.test/')).toBe('https://x.test/auth/sso/login/oauth2/ad');
  });

  it('login: Set-Cookie token + expiresAt parse; Basic + grant=password + scope=openid gönderir', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      headers: { getSetCookie: () => ['avidAccessToken=TOK123; Path=/; HttpOnly'], get: () => null },
      text: async () => JSON.stringify({ accessToken: 'TOK123', iamToken: { expiresAt: '2099-01-01T00:00:00.000Z' } }),
    }));
    vi.stubGlobal('fetch', fetchFn);
    const r = await postRopcLogin(makeConfig({ clouduxClientBasic: 'BASICVAL' }), {
      username: 'u', password: 'pw', clientBasic: 'BASICVAL',
    });
    expect(r.token).toBe('TOK123');
    expect(r.expiresAtMs).toBe(Date.parse('2099-01-01T00:00:00.000Z'));
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://cloudux.test/auth/sso/login/oauth2/ad');
    expect(init.headers.Authorization).toBe('Basic BASICVAL');
    expect(init.body).toContain('grant_type=password');
    expect(init.body).toContain('no_refresh_token=true');
    expect(init.body).toContain('scope=openid');
  });

  it('401 → AUTH', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401, statusText: 'Unauthorized',
      headers: { getSetCookie: () => [], get: () => null }, text: async () => 'x',
    })));
    await expect(postRopcLogin(makeConfig({ clouduxClientBasic: 'B' }), { username: 'u', password: 'pw', clientBasic: 'B' }))
      .rejects.toMatchObject({ code: 'AUTH' });
  });
});

describe('token manager — self-heal (ensureToken / forceRelogin)', () => {
  const loginCfg = () => makeConfig({ clouduxToken: null, clouduxUser: 'u', clouduxPassword: 'pw', clouduxClientBasic: 'BASIC' });
  const loginFetch = (seq?: () => string) => vi.fn(async () => ({
    ok: true, status: 200,
    headers: { getSetCookie: () => [`avidAccessToken=${seq ? seq() : 'NEWTOK'}`], get: () => null },
    text: async () => JSON.stringify({ iamToken: { expiresAt: '2099-01-01T00:00:00.000Z' } }),
  }));

  it('ensureToken: token yokken ROPC login eder', async () => {
    vi.stubGlobal('fetch', loginFetch());
    const m = createCtmsTokenManager(loginCfg());
    expect(await m.ensureToken()).toBe('NEWTOK');
    expect(m.getToken()).toBe('NEWTOK');
  });

  it('forceRelogin: yeni token üretir (401 retry senaryosu)', async () => {
    let n = 0;
    vi.stubGlobal('fetch', loginFetch(() => { n += 1; return `TOK${n}`; }));
    const m = createCtmsTokenManager(loginCfg());
    expect(await m.ensureToken()).toBe('TOK1');
    expect(await m.forceRelogin()).toBe('TOK2');
  });

  it('ensureToken: süresi geçerli token tekrar login etmez', async () => {
    const fetchFn = loginFetch();
    vi.stubGlobal('fetch', fetchFn);
    const m = createCtmsTokenManager(loginCfg());
    await m.ensureToken();
    await m.ensureToken();
    expect(fetchFn.mock.calls.length).toBe(1);
  });
});
