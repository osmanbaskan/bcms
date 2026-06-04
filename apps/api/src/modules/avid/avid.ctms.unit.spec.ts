import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildStpRequestBody,
  submitStpJobEndpoint,
  tokenExtensionEndpoint,
  postSubmitStpJob,
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
    transferEngine: 'playback-engine-01', transferEngineFallback: 'playback-engine-02',
    playbackDevice: 'MCR', playbackDeviceFallback: 'MCR_YEDEK', transferPriority: 'NORMAL',
    clouduxUrl: 'https://cloudux.test', clouduxRealm: 'REALM1', clouduxToken: 'tok-secret',
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
