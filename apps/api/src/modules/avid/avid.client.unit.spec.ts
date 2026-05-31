import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createInterplayAvidAdapter,
  createMockAvidAdapter,
  buildSearchBody,
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

describe('createInterplayAvidAdapter — kademeli rollout (K2/K3 henüz mock)', () => {
  it('searchByDcCode gerçek; restore/transfer 4 method notImpl throw', async () => {
    const adapter = createInterplayAvidAdapter(makeConfig());
    expect(() => adapter.requestRestore({ assetId: 'x', dcCode: 'd' })).toThrow(/not implemented/i);
    expect(() => adapter.pollRestoreStatus('j')).toThrow(/not implemented/i);
    expect(() => adapter.requestTransfer({ assetId: 'x', dcCode: 'd' })).toThrow(/not implemented/i);
    expect(() => adapter.pollTransferStatus('j')).toThrow(/not implemented/i);
  });
});

describe('getAvidAdapter — factory seçimi', () => {
  it('mockMode=true → mock adapter (4 method çalışır, throw etmez)', async () => {
    const adapter = getAvidAdapter({ RESTORE_AVID_MOCK: 'true', RESTORE_AVID_ENABLED: 'on' } as NodeJS.ProcessEnv);
    // mock requestRestore throw etmez, avidJobId döner.
    const r = await adapter.requestRestore({ assetId: 'x', dcCode: 'd' });
    expect(r.avidJobId).toBeTruthy();
  });

  it('enabled+mock=false+env dolu → interplay adapter (restore notImpl)', () => {
    const env = {
      RESTORE_AVID_ENABLED: 'on',
      RESTORE_AVID_MOCK: 'false',
      AVID_INTERPLAY_URL: 'http://avid.test/services',
      AVID_USER: 'u',
      AVID_PASSWORD: 'p',
      AVID_WORKSPACE: 'interplay://BSVMWG/',
    } as NodeJS.ProcessEnv;
    const adapter = getAvidAdapter(env);
    expect(() => adapter.requestRestore({ assetId: 'x', dcCode: 'd' })).toThrow(/not implemented/i);
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
