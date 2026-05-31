import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  postSoap,
  buildEnvelope,
  serviceEndpoint,
  escapeXml,
  AVID_NS,
  AvidSoapError,
} from './avid.soap.js';
import type { AvidConfig } from './avid.config.js';

/**
 * Avid SOAP transport unit testleri — fetch tamamen stub'lanır, GERÇEK AĞ YOK.
 * Envelope kurma, namespace tuzağı, hata yolları (<Errors>/<Fault>), timeout ve
 * parola redaction davranışı izole doğrulanır.
 */

function makeConfig(overrides: Partial<AvidConfig> = {}): AvidConfig {
  return {
    enabled: true,
    mockMode: false,
    interplayUrl: 'http://avid.test/services',
    user: 'test-user',
    password: 'Secret123',
    workspace: 'interplay://BSVMWG/',
    requestTimeoutMs: 5000,
    searchRootUri: 'interplay://BSVMWG/Projects/',
    workgroup: 'BSVMWG',
    restoreProfile: 'BeINSports - Partial Restore',
    restoreService: 'com.avid.dms.restore',
    ...overrides,
  };
}

/** fetch() yerine geçen sahte; verilen status + body text döner. */
function stubFetch(opts: { status?: number; statusText?: string; body: string }) {
  const fn = vi.fn(async () => ({
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    text: async () => opts.body,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('escapeXml', () => {
  it('XML özel karakterlerini escape eder', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });
});

describe('serviceEndpoint', () => {
  it('base URL sonundaki slash temizlenip servis eklenir', () => {
    expect(serviceEndpoint('http://x/services', 'Assets')).toBe('http://x/services/Assets');
    expect(serviceEndpoint('http://x/services/', 'Jobs')).toBe('http://x/services/Jobs');
  });
});

describe('buildEnvelope — namespace tuzağı (rapor §3)', () => {
  it('UserCredentials assets/types (c:), body ayrı ns (b:)', () => {
    const xml = buildEnvelope({
      username: 'u',
      password: 'p',
      bodyNs: AVID_NS.jobsTypes,
      bodyXml: '<b:GetJobStatus/>',
    });
    // credentials c: prefix + assets/types ns
    expect(xml).toContain(`xmlns:c="${AVID_NS.assetsTypes}"`);
    expect(xml).toContain('<c:UserCredentials>');
    expect(xml).toContain('<c:Username>u</c:Username>');
    expect(xml).toContain('<c:Password>p</c:Password>');
    // body b: prefix + jobs/types ns (servise göre)
    expect(xml).toContain(`xmlns:b="${AVID_NS.jobsTypes}"`);
    expect(xml).toContain('<s:Body><b:GetJobStatus/></s:Body>');
  });

  it('credentials içindeki özel karakter escape edilir', () => {
    const xml = buildEnvelope({ username: 'a<b', password: 'p&q', bodyNs: AVID_NS.assetsTypes, bodyXml: '<b:X/>' });
    expect(xml).toContain('<c:Username>a&lt;b</c:Username>');
    expect(xml).toContain('<c:Password>p&amp;q</c:Password>');
  });
});

describe('postSoap — HTTP davranışı', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('POST + text/xml + boş SOAPAction ile çağırır (rapor §4)', async () => {
    const fetchFn = stubFetch({
      body: `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body><SearchResponse/></s:Body></s:Envelope>`,
    });
    const cfg = makeConfig();
    await postSoap(cfg, { service: 'Assets', bodyNs: AVID_NS.assetsTypes, bodyXml: '<b:Search/>' });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://avid.test/services/Assets');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/xml; charset=utf-8');
    expect((init.headers as Record<string, string>).SOAPAction).toBe('""');
    expect(String(init.body)).toContain('<b:Search/>');
  });

  it('temiz yanıtta Envelope.Body içeriğini döndürür', async () => {
    stubFetch({
      body: `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body><Foo><Bar>1</Bar></Foo></s:Body></s:Envelope>`,
    });
    const body = await postSoap(makeConfig(), { service: 'Assets', bodyNs: AVID_NS.assetsTypes, bodyXml: '<b:X/>' });
    expect(body).toHaveProperty('Foo');
  });

  it('HTTP 200 + <Errors><Error Code> → AvidSoapError (rapor §4)', async () => {
    stubFetch({
      status: 200,
      body:
        `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body>` +
        `<Errors><Error Code="INVALID_PARAMETER"><Message>bad cond</Message><Details>dbg</Details></Error></Errors>` +
        `</s:Body></s:Envelope>`,
    });
    await expect(
      postSoap(makeConfig(), { service: 'Assets', bodyNs: AVID_NS.assetsTypes, bodyXml: '<b:X/>' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMETER' });
  });

  it('HTTP 500 + SOAP <Fault> → AvidSoapError', async () => {
    stubFetch({
      status: 500,
      statusText: 'Internal Server Error',
      body:
        `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body>` +
        `<s:Fault><faultcode>s:Server</faultcode><faultstring>boom</faultstring></s:Fault>` +
        `</s:Body></s:Envelope>`,
    });
    await expect(
      postSoap(makeConfig(), { service: 'Jobs', bodyNs: AVID_NS.jobsTypes, bodyXml: '<b:X/>' }),
    ).rejects.toBeInstanceOf(AvidSoapError);
  });

  it('hata yok ama HTTP non-2xx → HTTP_ERROR', async () => {
    stubFetch({ status: 404, statusText: 'Not Found', body: '<html>nope</html>' });
    await expect(
      postSoap(makeConfig(), { service: 'Assets', bodyNs: AVID_NS.assetsTypes, bodyXml: '<b:X/>' }),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  });

  it('timeout → TIMEOUT kodlu hata', async () => {
    // fetch çağrısı AbortError fırlatsın (controller.abort sonrası native davranış).
    const fn = vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    vi.stubGlobal('fetch', fn);
    await expect(
      postSoap(makeConfig({ requestTimeoutMs: 10 }), { service: 'Assets', bodyNs: AVID_NS.assetsTypes, bodyXml: '<b:X/>' }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('parola hata mesajına SIZMAZ (redaction)', async () => {
    // fetch network hatası fırlatsın; mesaj parolayı içerirse redact edilmeli.
    const fn = vi.fn(async () => { throw new Error('connect failed for Secret123'); });
    vi.stubGlobal('fetch', fn);
    const err = await postSoap(makeConfig({ password: 'Secret123' }), {
      service: 'Assets', bodyNs: AVID_NS.assetsTypes, bodyXml: '<b:X/>',
    }).catch((e) => e as AvidSoapError);
    expect(err).toBeInstanceOf(AvidSoapError);
    expect(err.message).not.toContain('Secret123');
    expect(err.message).toContain('***');
  });
});
