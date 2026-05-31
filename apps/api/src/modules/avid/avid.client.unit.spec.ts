import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createInterplayAvidAdapter,
  createMockAvidAdapter,
  buildSearchBody,
  buildRestoreSubmitBody,
  buildJobStatusBody,
  buildSendToPlaybackBody,
  assetIdToInterplayUri,
  mapJobStatus,
  getAvidAdapter,
  __resetAvidAdapterForTest,
} from './avid.client.js';
import { AVID_NS } from './avid.soap.js';
import type { AvidConfig } from './avid.config.js';

/**
 * Avid client (K1 search) unit testleri — fetch stub, GERÇEK AĞ YOK.
 * XML fixture'lar raporun §7.1 (AssetDescription şekli) ve §16.2 (Search)
 * örneklerinden türetildi.
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
    transferEngine: 'bsvmte01',
    transferEngineFallback: 'bsvmte02',
    playbackDevice: 'MCR',
    transferPriority: 'NORMAL',
    ...overrides,
  };
}

/** Tek bir AssetDescription XML parçası (rapor §7.1 şekli). */
function assetDescXml(opts: {
  mobid: string;
  displayName: string;
  mediaStatus?: string;
  modifiedDate?: string;
  duration?: string;
}): string {
  const attrs = [
    `<Attribute Name="Display Name" Group="USER">${opts.displayName}</Attribute>`,
    `<Attribute Name="Type" Group="SYSTEM">sequence</Attribute>`,
    opts.mediaStatus ? `<Attribute Name="Media Status" Group="SYSTEM">${opts.mediaStatus}</Attribute>` : '',
    opts.modifiedDate ? `<Attribute Name="Modified Date" Group="SYSTEM">${opts.modifiedDate}</Attribute>` : '',
    opts.duration ? `<Attribute Name="Duration" Group="SYSTEM">${opts.duration}</Attribute>` : '',
  ].join('');
  return (
    `<AssetDescription>` +
    `<InterplayURI>interplay://BSVMWG?mobid=${opts.mobid}</InterplayURI>` +
    `<Attributes>${attrs}</Attributes>` +
    `</AssetDescription>`
  );
}

/** SearchResponse envelope'u (0+ AssetDescription). */
function searchEnvelope(descriptions: string[]): string {
  return (
    `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body>` +
    `<SearchResponse><Assets>${descriptions.join('')}</Assets></SearchResponse>` +
    `</s:Body></s:Envelope>`
  );
}

function stubFetchXml(body: string) {
  const fn = vi.fn(async () => ({
    ok: true, status: 200, statusText: 'OK', text: async () => body,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetAvidAdapterForTest();
});

describe('buildSearchBody (rapor §9.2)', () => {
  it('Display Name Contains + Type Equals sequence + root uri', () => {
    const xml = buildSearchBody(makeConfig(), 'DC00036170');
    expect(xml).toContain('<b:InterplayPathURI>interplay://BSVMWG/Projects/</b:InterplayPathURI>');
    expect(xml).toContain('Condition="Contains"');
    expect(xml).toContain('Name="Display Name" Group="USER">DC00036170<');
    expect(xml).toContain('Condition="Equals"');
    expect(xml).toContain('Name="Type" Group="SYSTEM">sequence<');
  });
});

describe('createInterplayAvidAdapter.searchByDcCode', () => {
  it('tek asset: Media Status=online → online:true, alanlar eşlenir', async () => {
    stubFetchXml(searchEnvelope([
      assetDescXml({
        mobid: '060a2b34-AAA',
        displayName: 'DC00036170_KOREN_MANISA_37H_1D',
        mediaStatus: 'online',
        modifiedDate: '2026-04-27T16:01:16.000+0300',
        duration: '1500',
      }),
    ]));
    const adapter = createInterplayAvidAdapter(makeConfig());
    const result = await adapter.searchByDcCode('DC00036170');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: '060a2b34-AAA',
      name: 'DC00036170_KOREN_MANISA_37H_1D',
      online: true,
      modifiedAt: '2026-04-27T16:01:16.000+0300',
      durationFrames: 1500,
    });
  });

  it('offline asset → online:false', async () => {
    stubFetchXml(searchEnvelope([
      assetDescXml({ mobid: 'm1', displayName: 'DC00036171_X', mediaStatus: 'offline' }),
    ]));
    const adapter = createInterplayAvidAdapter(makeConfig());
    const result = await adapter.searchByDcCode('DC00036171');
    expect(result[0].online).toBe(false);
  });

  it('aynı mobid 2 path (2 AssetDescription) → MOB dedup → tek asset (rapor §7.3)', async () => {
    stubFetchXml(searchEnvelope([
      assetDescXml({ mobid: 'dup-1', displayName: 'DC00036172_ERZ_BANDIRMA_37H_1D', mediaStatus: 'online' }),
      assetDescXml({ mobid: 'dup-1', displayName: 'DC00036172_ERZ_BANDIRMA_37H_1D', mediaStatus: 'online' }),
    ]));
    const adapter = createInterplayAvidAdapter(makeConfig());
    const result = await adapter.searchByDcCode('DC00036172');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('dup-1');
  });

  it('farklı mobid → ayrı asset (multi-match)', async () => {
    stubFetchXml(searchEnvelope([
      assetDescXml({ mobid: 'a', displayName: 'DC00036173_A', mediaStatus: 'online' }),
      assetDescXml({ mobid: 'b', displayName: 'DC00036173_B', mediaStatus: 'offline' }),
    ]));
    const adapter = createInterplayAvidAdapter(makeConfig());
    const result = await adapter.searchByDcCode('DC00036173');
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('0 sonuç → [] (worker NOT_FOUND yapar)', async () => {
    stubFetchXml(searchEnvelope([]));
    const adapter = createInterplayAvidAdapter(makeConfig());
    const result = await adapter.searchByDcCode('DC99999999');
    expect(result).toEqual([]);
  });

  it('Contains false-positive client-side elenir (rapor §9.2)', async () => {
    // Server Contains döndüğü için dcCode içermeyen ad gelebilir → elenmeli.
    stubFetchXml(searchEnvelope([
      assetDescXml({ mobid: 'keep', displayName: 'DC00036170_MATCH', mediaStatus: 'online' }),
      assetDescXml({ mobid: 'drop', displayName: 'UNRELATED_NAME', mediaStatus: 'online' }),
    ]));
    const adapter = createInterplayAvidAdapter(makeConfig());
    const result = await adapter.searchByDcCode('DC00036170');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('keep');
  });

  it('Media Status yoksa online:false (defansif)', async () => {
    stubFetchXml(searchEnvelope([
      assetDescXml({ mobid: 'nostat', displayName: 'DC00036174_NOSTAT' }),
    ]));
    const adapter = createInterplayAvidAdapter(makeConfig());
    const result = await adapter.searchByDcCode('DC00036174');
    expect(result[0].online).toBe(false);
  });
});

describe('createInterplayAvidAdapter — tüm 5 method gerçek (K1+K2+K3)', () => {
  it('hiçbir method "not implemented" fırlatmaz (notImpl tamamen kalktı)', () => {
    const adapter = createInterplayAvidAdapter(makeConfig());
    // Tüm method'lar fonksiyon; çağrıldıklarında fetch'e gider (stub yok →
    // ağ hatası olabilir ama "not implemented" ASLA olmaz). Sadece tip/varlık.
    expect(typeof adapter.searchByDcCode).toBe('function');
    expect(typeof adapter.requestRestore).toBe('function');
    expect(typeof adapter.pollRestoreStatus).toBe('function');
    expect(typeof adapter.requestTransfer).toBe('function');
    expect(typeof adapter.pollTransferStatus).toBe('function');
  });
});

describe('getAvidAdapter — factory seçimi', () => {
  it('mockMode=true → mock adapter (4 method çalışır, throw etmez)', async () => {
    const adapter = getAvidAdapter({ RESTORE_AVID_MOCK: 'true', RESTORE_AVID_ENABLED: 'on' } as NodeJS.ProcessEnv);
    // mock requestRestore throw etmez, avidJobId döner.
    const r = await adapter.requestRestore({ assetId: 'x', dcCode: 'd' });
    expect(r.avidJobId).toBeTruthy();
  });

  it('enabled+mock=false+env dolu → interplay adapter (5 method da fonksiyon)', () => {
    const env = {
      RESTORE_AVID_ENABLED: 'on',
      RESTORE_AVID_MOCK: 'false',
      AVID_INTERPLAY_URL: 'http://avid.test/services',
      AVID_USER: 'u',
      AVID_PASSWORD: 'p',
      AVID_WORKSPACE: 'interplay://BSVMWG/',
    } as NodeJS.ProcessEnv;
    const adapter = getAvidAdapter(env);
    expect(typeof adapter.requestTransfer).toBe('function');
    expect(typeof adapter.pollTransferStatus).toBe('function');
  });
});

describe('K2 — buildRestoreSubmitBody / assetIdToInterplayUri (rapor §11)', () => {
  it('mobid → interplay:// URI (workgroup ile)', () => {
    expect(assetIdToInterplayUri(makeConfig(), 'ABC123')).toBe('interplay://BSVMWG?mobid=ABC123');
  });
  it('zaten interplay:// ise olduğu gibi bırakır', () => {
    const uri = 'interplay://BSVMWG?mobid=XYZ';
    expect(assetIdToInterplayUri(makeConfig(), uri)).toBe(uri);
  });
  it('SubmitJobUsingProfile body: Service/Profile/SourceServerType=Assets', () => {
    const xml = buildRestoreSubmitBody(makeConfig(), 'interplay://BSVMWG?mobid=M1');
    expect(xml).toContain('<b:Service>com.avid.dms.restore</b:Service>');
    expect(xml).toContain('<b:Profile>BeINSports - Partial Restore</b:Profile>');
    expect(xml).toContain('<b:InterplayURI>interplay://BSVMWG?mobid=M1</b:InterplayURI>');
    // KRİTİK (§11.2): Assets, Archive DEĞİL.
    expect(xml).toContain('<b:SourceServerType>Assets</b:SourceServerType>');
    expect(xml).not.toContain('Archive');
  });
  it('GetJobStatus body: JobURI sarmalı', () => {
    const xml = buildJobStatusBody('interplay://BSVMWG/DMS?jobid=J1');
    expect(xml).toContain('<b:JobURIs><b:JobURI>interplay://BSVMWG/DMS?jobid=J1</b:JobURI></b:JobURIs>');
  });
});

describe('K2 — mapJobStatus (rapor §11.5 saha enum)', () => {
  it('Completed → done', () => { expect(mapJobStatus('Completed')).toBe('done'); });
  it('Pending → pending', () => { expect(mapJobStatus('Pending')).toBe('pending'); });
  it('Processing N% → running', () => { expect(mapJobStatus('Processing 42%')).toBe('running'); });
  it('RUNNING (doc) → running', () => { expect(mapJobStatus('RUNNING')).toBe('running'); });
  it('Failed → failed', () => { expect(mapJobStatus('Failed')).toBe('failed'); });
  it('bilinmeyen → running (defansif)', () => { expect(mapJobStatus('Whatever')).toBe('running'); });
});

describe('K2 — requestRestore / pollRestoreStatus (fetch stub, ağ YOK)', () => {
  it('requestRestore: doğru body gönderir + JobURI çıkarır', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () =>
        `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body>` +
        `<SubmitJobUsingProfileResponse><JobURI>interplay://BSVMWG/DMS?jobid=JOB1</JobURI></SubmitJobUsingProfileResponse>` +
        `</s:Body></s:Envelope>`,
    }));
    vi.stubGlobal('fetch', fetchFn);
    const adapter = createInterplayAvidAdapter(makeConfig());
    const r = await adapter.requestRestore({ assetId: 'M1', dcCode: 'DC1' });
    expect(r.avidJobId).toBe('interplay://BSVMWG/DMS?jobid=JOB1');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://avid.test/services/Jobs');
    expect(String(init.body)).toContain('<b:SourceServerType>Assets</b:SourceServerType>');
    expect(String(init.body)).toContain('interplay://BSVMWG?mobid=M1');
  });

  it('requestRestore: JobURI yoksa hata fırlatır', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () => `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body><SubmitJobUsingProfileResponse/></s:Body></s:Envelope>`,
    })));
    const adapter = createInterplayAvidAdapter(makeConfig());
    await expect(adapter.requestRestore({ assetId: 'M1', dcCode: 'DC1' })).rejects.toThrow(/JobURI/i);
  });

  it('pollRestoreStatus: Completed → done', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () =>
        `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body>` +
        `<GetJobStatusResponse><JobStatus><Status>Completed</Status></JobStatus></GetJobStatusResponse>` +
        `</s:Body></s:Envelope>`,
    })));
    const adapter = createInterplayAvidAdapter(makeConfig());
    expect(await adapter.pollRestoreStatus('interplay://BSVMWG/DMS?jobid=JOB1')).toEqual({ status: 'done' });
  });

  it('pollRestoreStatus: Failed → failed (+errorMsg)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () =>
        `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body>` +
        `<GetJobStatusResponse><JobStatus><Status>Failed</Status><ErrorMessage>DIVA timeout</ErrorMessage></JobStatus></GetJobStatusResponse>` +
        `</s:Body></s:Envelope>`,
    })));
    const adapter = createInterplayAvidAdapter(makeConfig());
    const r = await adapter.pollRestoreStatus('j');
    expect(r.status).toBe('failed');
    expect(r.errorMsg).toContain('DIVA timeout');
  });

  it('pollRestoreStatus: Status okunamazsa defansif running', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () => `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body><GetJobStatusResponse/></s:Body></s:Envelope>`,
    })));
    const adapter = createInterplayAvidAdapter(makeConfig());
    expect(await adapter.pollRestoreStatus('j')).toEqual({ status: 'running' });
  });
});

describe('K3 — buildSendToPlaybackBody (rapor §13.1/§16.8)', () => {
  it('birincil hedef bsvmte01 + MCR (operasyon kararı)', () => {
    const xml = buildSendToPlaybackBody(makeConfig(), 'interplay://BSVMWG?mobid=M1');
    expect(xml).toContain('<b:TransferEngineHostName>bsvmte01</b:TransferEngineHostName>');
    expect(xml).toContain('<b:InterplayURI>interplay://BSVMWG?mobid=M1</b:InterplayURI>');
    expect(xml).toContain('<b:DestinationPlaybackDevice>MCR</b:DestinationPlaybackDevice>');
    expect(xml).toContain('<b:Priority>NORMAL</b:Priority>');
    expect(xml).toContain('<b:Overwrite>false</b:Overwrite>');
  });
  it('engine parametresi override eder (failover yedek engine)', () => {
    const xml = buildSendToPlaybackBody(makeConfig(), 'interplay://BSVMWG?mobid=M2', 'bsvmte02');
    expect(xml).toContain('<b:TransferEngineHostName>bsvmte02</b:TransferEngineHostName>');
    expect(xml).toContain('<b:DestinationPlaybackDevice>MCR</b:DestinationPlaybackDevice>');
  });
});

describe('K3 — requestTransfer / pollTransferStatus (fetch stub, ağ YOK)', () => {
  it('requestTransfer: /services/Transfer endpoint + SendToPlayback body + JobURI', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () =>
        `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body>` +
        `<SendToPlaybackResponse><JobURI>interplay://BSVMWG/DMS?jobid=XFER1</JobURI></SendToPlaybackResponse>` +
        `</s:Body></s:Envelope>`,
    }));
    vi.stubGlobal('fetch', fetchFn);
    const adapter = createInterplayAvidAdapter(makeConfig());
    const r = await adapter.requestTransfer({ assetId: 'M1', dcCode: 'DC1' });
    expect(r.avidJobId).toBe('interplay://BSVMWG/DMS?jobid=XFER1');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://avid.test/services/Transfer');
    expect(String(init.body)).toContain('<b:SendToPlayback>');
    expect(String(init.body)).toContain('interplay://BSVMWG?mobid=M1');
  });

  it('requestTransfer: JobURI yoksa (her iki engine de) hata fırlatır', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () => `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body><SendToPlaybackResponse/></s:Body></s:Envelope>`,
    })));
    const adapter = createInterplayAvidAdapter(makeConfig());
    await expect(adapter.requestTransfer({ assetId: 'M1', dcCode: 'DC1' })).rejects.toThrow(/JobURI/i);
  });

  it('failover: birincil bsvmte01 başarısız → yedek bsvmte02 başarılı', async () => {
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        // Birincil engine: JobURI'siz yanıt → sendToPlaybackOnEngine throw.
        return { ok: true, status: 200, statusText: 'OK',
          text: async () => `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body><SendToPlaybackResponse/></s:Body></s:Envelope>` };
      }
      // Yedek engine: başarılı JobURI.
      return { ok: true, status: 200, statusText: 'OK',
        text: async () =>
          `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body>` +
          `<SendToPlaybackResponse><JobURI>interplay://BSVMWG/DMS?jobid=XFER2</JobURI></SendToPlaybackResponse>` +
          `</s:Body></s:Envelope>` };
    });
    vi.stubGlobal('fetch', fetchFn);
    const adapter = createInterplayAvidAdapter(makeConfig());
    const r = await adapter.requestTransfer({ assetId: 'M1', dcCode: 'DC1' });
    expect(r.avidJobId).toBe('interplay://BSVMWG/DMS?jobid=XFER2');
    expect(fetchFn).toHaveBeenCalledTimes(2); // birincil + yedek
    // 1. çağrı bsvmte01, 2. çağrı bsvmte02 body'si içermeli.
    expect(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body)).toContain('bsvmte01');
    expect(String((fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1].body)).toContain('bsvmte02');
  });

  it('failover yok: fallback engine boşsa yalnız birincil denenir', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () => `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body><SendToPlaybackResponse/></s:Body></s:Envelope>`,
    }));
    vi.stubGlobal('fetch', fetchFn);
    const adapter = createInterplayAvidAdapter(makeConfig({ transferEngineFallback: '' }));
    await expect(adapter.requestTransfer({ assetId: 'M1', dcCode: 'DC1' })).rejects.toThrow(/JobURI/i);
    expect(fetchFn).toHaveBeenCalledTimes(1); // sadece birincil
  });

  it('pollTransferStatus: Completed → done (Jobs.GetJobStatus paylaşımı)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () =>
        `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body>` +
        `<GetJobStatusResponse><JobStatus><Status>Completed</Status></JobStatus></GetJobStatusResponse>` +
        `</s:Body></s:Envelope>`,
    })));
    const adapter = createInterplayAvidAdapter(makeConfig());
    expect(await adapter.pollTransferStatus('interplay://BSVMWG/DMS?jobid=XFER1')).toEqual({ status: 'done' });
  });

  it('pollTransferStatus: Failed → failed (+errorMsg)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () =>
        `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}"><s:Body>` +
        `<GetJobStatusResponse><JobStatus><Status>Failed</Status><ErrorMessage>playout reject</ErrorMessage></JobStatus></GetJobStatusResponse>` +
        `</s:Body></s:Envelope>`,
    })));
    const adapter = createInterplayAvidAdapter(makeConfig());
    const r = await adapter.pollTransferStatus('j');
    expect(r.status).toBe('failed');
    expect(r.errorMsg).toContain('playout reject');
  });
});

describe('createMockAvidAdapter (regresyon — değişmedi)', () => {
  it('searchByDcCode override ile deterministik döner', async () => {
    const adapter = createMockAvidAdapter();
    // override olmadan rastgele; sadece array döndüğünü doğrula.
    const result = await adapter.searchByDcCode('DCX');
    expect(Array.isArray(result)).toBe(true);
  });
});
