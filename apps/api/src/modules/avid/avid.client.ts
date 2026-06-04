/**
 * Avid Interplay adapter — üç kademeli iş akışı interface'i.
 *
 * Search   (kademe 1): DC kod ile Avid arşivinde arama; 0..N AvidAsset döner.
 * Restore  (kademe 2): Seçilen asset'i Avid arşivinden Interplay workspace'e getir.
 * Transfer (kademe 3): Online asset'i Interplay'den production storage'a aktar.
 *
 * Tek interface, search + iki method çifti (request + poll). Factory
 * `getAvidAdapter` config'e göre mock veya gerçek client döner. V2'de gerçek
 * Interplay client stub (`throw 'not implemented'`); ayrı PR'da SOAP/REST
 * doldurulur — interface değişmez.
 *
 * Test-friendly: factory NEW instance her çağrıda dönmez; module-scope state
 * (mock adapter için job map) korunur. Test'te `__resetAvidAdapterForTest`
 * helper'ı ile state sıfırlanır.
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  loadAvidConfig, applyAvidOverrides, assertAvidConfigReady, assertCtmsConfigReady,
  type AvidConfig,
} from './avid.config.js';
import { readAvidSettings } from './avid.settings.js';
import { postSoap, AVID_NS, escapeXml } from './avid.soap.js';
import { postSubmitStpJob, createCtmsTokenManager, type CtmsTokenManager } from './avid.ctms.js';

export type AvidJobPhaseStatus = 'pending' | 'running' | 'done' | 'failed';

export interface AvidJobStatusResult {
  status: AvidJobPhaseStatus;
  errorMsg?: string;
}

/** Avid Interplay asset metadata — search sonucu + operatör seçim listesi. */
export interface AvidAsset {
  /** Interplay asset ID (MOB ID veya benzeri). Restore/Transfer çağrılarında kullanılır. */
  id: string;
  /** Asset name (genelde DC kod ya da ona benzer; UI'da listede görünür). */
  name: string;
  /** ISO timestamp — operatör birden çok sonuçtan seçim yaparken karar verici alan. */
  modifiedAt: string;
  /**
   * Interplay'de binary online mı? Interplay metadata kataloğudur — asset her
   * zaman metadata olarak bulunur ama binary `true` (Avid'de) veya `false`
   * (DIVA arşivinde) olabilir.
   */
  online: boolean;
  /** Opsiyonel süre bilgisi (frame cinsi); mock fixture'da set edilir. */
  durationFrames?: number;
}

export interface AvidRestoreTransferInput {
  /** Search SELECTED'ten kopyalanır; worker tarafında zorunlu. */
  assetId: string;
  /**
   * Asset Interplay'de zaten online mı? Restore worker bunu adapter'a geçer.
   * Mock: true → 1-2sn DONE (Interplay no-op); false → 5-30sn DIVA restore.
   * Sadece restore kademesinde anlamlı; transfer ignore eder.
   */
  assetOnline?: boolean;
  /** Audit/log için DC kod; adapter çağrısına bilgi amaçlı geçer. */
  dcCode: string;
  channelSlug?: string;
  /**
   * Asset display name (transfer_jobs.avidAssetName). K3 CTMS submitSTPJob
   * `processName` alanı için. Yoksa dcCode kullanılır. Restore/search ignore eder.
   */
  assetName?: string;
}

export interface AvidAdapter {
  /** DC kod ile arşivde arama. 0..N sonuç döner. */
  searchByDcCode(dcCode: string): Promise<AvidAsset[]>;

  requestRestore(input: AvidRestoreTransferInput): Promise<{ avidJobId: string }>;
  pollRestoreStatus(avidJobId: string): Promise<AvidJobStatusResult>;

  requestTransfer(input: AvidRestoreTransferInput): Promise<{ avidJobId: string }>;
  pollTransferStatus(avidJobId: string): Promise<AvidJobStatusResult>;
}

// ============================================================================
// Mock adapter — V2 default davranış (gerçek Interplay bağlantısı yokken)
// ============================================================================

interface MockJobState {
  dcCode: string;
  channelSlug?: string;
  enqueuedAt: number;
  finishesAt: number;
  outcome: 'done' | 'failed';
  errorMsg?: string;
}

interface MockState {
  restoreJobs: Map<string, MockJobState>;
  transferJobs: Map<string, MockJobState>;
  /** Test seam: override search behavior by DC code (deterministic specs). */
  searchOverrides: Map<string, AvidAsset[]>;
}

function createInitialMockState(): MockState {
  return { restoreJobs: new Map(), transferJobs: new Map(), searchOverrides: new Map() };
}

function randomDelayMs(): number {
  // 5-30 sn arası rastgele — operasyonel testte gerçekçi süre.
  return 5_000 + Math.floor(Math.random() * 25_000);
}

function randomOutcome(): { outcome: 'done' | 'failed'; errorMsg?: string } {
  // %90 success, %10 failure — UI failure path ve retry test edilebilsin.
  if (Math.random() < 0.1) {
    return { outcome: 'failed', errorMsg: 'mock: simulated avid failure' };
  }
  return { outcome: 'done' };
}

/**
 * Mock search davranış dağılımı (kullanıcı kararı 2026-05-28):
 *  %70  → 1 asset (single match — operatör tek seçenek onayı)
 *  %20  → 2 veya 3 asset (multi match — operatör seçim dialog'u)
 *  %10  → 0 asset (not_found — search terminal NOT_FOUND)
 *
 * Her asset için online dağılımı: %60 online / %40 offline.
 *
 * Deterministic test için `state.searchOverrides.set(dcCode, [...])` ile
 * override edilebilir.
 */
function mockSearchResults(dcCode: string): AvidAsset[] {
  const r = Math.random();
  if (r < 0.10) {
    return []; // not_found
  }
  const now = Date.now();
  const rollOnline = () => Math.random() < 0.60;
  const single: AvidAsset = {
    id: `mock-asset-${randomUUID().slice(0, 8)}`,
    name: dcCode,
    modifiedAt: new Date(now - Math.floor(Math.random() * 86_400_000)).toISOString(),
    online: rollOnline(),
    durationFrames: 1500 + Math.floor(Math.random() * 27_500),
  };
  if (r < 0.10 + 0.70) {
    return [single]; // single match
  }
  // multi-match (2-3 öğe) — her birinin kendi online flag'i
  const extraCount = Math.random() < 0.5 ? 1 : 2;
  const extras: AvidAsset[] = Array.from({ length: extraCount }, (_, idx) => ({
    id: `mock-asset-${randomUUID().slice(0, 8)}`,
    name: `${dcCode} (v${idx + 2})`,
    modifiedAt: new Date(now - (idx + 1) * 86_400_000).toISOString(),
    online: rollOnline(),
    durationFrames: single.durationFrames,
  }));
  return [single, ...extras];
}

function pollMockJob(map: Map<string, MockJobState>, avidJobId: string): AvidJobStatusResult {
  const job = map.get(avidJobId);
  if (!job) {
    // Mock map silinmiş veya hiç set edilmemiş; defansif "failed" döner.
    return { status: 'failed', errorMsg: 'mock: avid job not found' };
  }
  if (Date.now() < job.finishesAt) {
    return { status: 'running' };
  }
  return job.outcome === 'done'
    ? { status: 'done' }
    : { status: 'failed', errorMsg: job.errorMsg };
}

export function createMockAvidAdapter(state: MockState = createInitialMockState()): AvidAdapter {
  return {
    async searchByDcCode(dcCode) {
      const override = state.searchOverrides.get(dcCode);
      if (override) return override;
      return mockSearchResults(dcCode);
    },

    async requestRestore(input) {
      const avidJobId = randomUUID();
      const now = Date.now();
      // Online asset → Interplay no-op simülasyonu (1-2sn, kesin başarılı).
      // Offline asset → normal DIVA restore (5-30sn, %90 success).
      const onlineNoOp = input.assetOnline === true;
      const outcomeInfo = onlineNoOp
        ? { outcome: 'done' as const, errorMsg: undefined }
        : randomOutcome();
      const delayMs = onlineNoOp
        ? 1_000 + Math.floor(Math.random() * 1_000) // 1-2sn
        : randomDelayMs();
      state.restoreJobs.set(avidJobId, {
        dcCode: input.dcCode,
        channelSlug: input.channelSlug,
        enqueuedAt: now,
        finishesAt: now + delayMs,
        outcome: outcomeInfo.outcome,
        errorMsg: outcomeInfo.errorMsg,
      });
      return { avidJobId };
    },

    async pollRestoreStatus(avidJobId) {
      return pollMockJob(state.restoreJobs, avidJobId);
    },

    async requestTransfer(input) {
      const avidJobId = randomUUID();
      const now = Date.now();
      const { outcome, errorMsg } = randomOutcome();
      state.transferJobs.set(avidJobId, {
        dcCode: input.dcCode,
        channelSlug: input.channelSlug,
        enqueuedAt: now,
        finishesAt: now + randomDelayMs(),
        outcome,
        errorMsg,
      });
      return { avidJobId };
    },

    async pollTransferStatus(avidJobId) {
      return pollMockJob(state.transferJobs, avidJobId);
    },
  };
}

// ============================================================================
// Gerçek Interplay adapter — V2 stub (ayrı PR'da doldurulur)
// ============================================================================

export function createInterplayAvidAdapter(cfg: AvidConfig): AvidAdapter {
  // K1 search + K2 restore = IPWS SOAP. K3 transfer = CTMS submitSTPJob (Cloud UX).
  // CTMS token yöneticisi: env token'ı /extension ile canlı tutar (transfer için).
  // Token yalnız transfer kullanılınca gerekli — lazy: ilk requestTransfer'da
  // assertCtmsConfigReady + manager.start().
  let ctmsToken: CtmsTokenManager | null = null;
  const ensureCtms = (): CtmsTokenManager => {
    if (!ctmsToken) {
      assertCtmsConfigReady(cfg);
      ctmsToken = createCtmsTokenManager(cfg);
      ctmsToken.start();
    }
    return ctmsToken;
  };

  return {
    // K1 (search) — gerçek IPWS Assets.Search bağlı.
    searchByDcCode:     (dcCode: string) => interplaySearchByDcCode(cfg, dcCode),
    // K2 (restore) — gerçek IPWS Jobs.SubmitJobUsingProfile + GetJobStatus.
    requestRestore:     (input: AvidRestoreTransferInput) => interplayRequestRestore(cfg, input),
    pollRestoreStatus:  (avidJobId: string) => interplayPollJobStatus(cfg, avidJobId),
    // K3 (transfer) — CTMS submitSTPJob (CDS mixdown+encode+playback orkestra eder).
    requestTransfer:    (input: AvidRestoreTransferInput) => ctmsRequestTransfer(cfg, ensureCtms(), input),
    pollTransferStatus: (avidJobId: string) => ctmsPollTransferStatus(cfg, avidJobId),
  };
}

// ----------------------------------------------------------------------------
// K1 — Assets.Search implementasyonu (rapor §9, §16.2, §7.1)
// ----------------------------------------------------------------------------

/**
 * Assets.Search body XML'i kur. İki AND koşulu:
 *  - Display Name `Contains` dcCode (Group=USER) — rapor §9.2: yalnız
 *    Equals/Contains çalışır.
 *  - Type `Equals` sequence (Group=SYSTEM).
 */
export function buildSearchBody(cfg: AvidConfig, dcCode: string, maxResults = 50): string {
  return (
    `<b:Search>` +
    `<b:InterplayPathURI>${escapeXml(cfg.searchRootUri)}</b:InterplayPathURI>` +
    `<b:SearchGroup Operator="AND">` +
    `<b:AttributeCondition Condition="Contains">` +
    `<b:Attribute Name="Display Name" Group="USER">${escapeXml(dcCode)}</b:Attribute>` +
    `</b:AttributeCondition>` +
    `<b:AttributeCondition Condition="Equals">` +
    `<b:Attribute Name="Type" Group="SYSTEM">sequence</b:Attribute>` +
    `</b:AttributeCondition>` +
    `</b:SearchGroup>` +
    `<b:MaxResults>${maxResults}</b:MaxResults>` +
    `</b:Search>`
  );
}

/** Parse ağacında tüm `AssetDescription` düğümlerini topla (ns-agnostik, recursive). */
function collectAssetDescriptions(node: unknown, out: Record<string, unknown>[]): void {
  if (node == null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if ('AssetDescription' in obj && obj.AssetDescription) {
    const list = Array.isArray(obj.AssetDescription) ? obj.AssetDescription : [obj.AssetDescription];
    for (const item of list) {
      if (item && typeof item === 'object') out.push(item as Record<string, unknown>);
    }
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) collectAssetDescriptions(item, out);
    } else if (value && typeof value === 'object') {
      collectAssetDescriptions(value, out);
    }
  }
}

/** Bir AssetDescription'ın <Attributes> içini { name: value } map'e çevir (rapor §7.1). */
function attributesToMap(assetDesc: Record<string, unknown>): Record<string, string> {
  const map: Record<string, string> = {};
  const attrsNode = assetDesc.Attributes as Record<string, unknown> | undefined;
  if (!attrsNode) return map;
  const raw = attrsNode.Attribute;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const ar = a as Record<string, unknown>;
    const name = typeof ar['@_Name'] === 'string' ? ar['@_Name'] : null;
    if (!name) continue;
    // Element metni: #text (attribute'lu element); yoksa primitive değer.
    const value =
      typeof ar['#text'] === 'string' ? ar['#text']
      : typeof ar['#text'] === 'number' ? String(ar['#text'])
      : typeof ar['#text'] === 'boolean' ? String(ar['#text'])
      : '';
    map[name] = value;
  }
  return map;
}

/** Bir element düğümünün metin içeriğini al (#text; yoksa primitive değer). */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (node && typeof node === 'object') {
    const t = (node as Record<string, unknown>)['#text'];
    if (typeof t === 'string') return t;
    if (typeof t === 'number' || typeof t === 'boolean') return String(t);
  }
  return '';
}

/** InterplayURI'den mobid= parçasını çıkar (rapor §7.3 dedup anahtarı). */
function extractMobId(interplayUri: string): string {
  const idx = interplayUri.indexOf('mobid=');
  return idx >= 0 ? interplayUri.slice(idx + 'mobid='.length) : interplayUri;
}

async function interplaySearchByDcCode(cfg: AvidConfig, dcCode: string): Promise<AvidAsset[]> {
  const bodyXml = buildSearchBody(cfg, dcCode);
  const body = await postSoap(cfg, {
    service: 'Assets',
    bodyNs: AVID_NS.assetsTypes,
    bodyXml,
  });

  const descriptions: Record<string, unknown>[] = [];
  collectAssetDescriptions(body, descriptions);

  // MOB-dedup (rapor §7.3): aynı mobid birden çok path'te ayrı AssetDescription
  // olarak dönebilir → tek asset say.
  const byMob = new Map<string, AvidAsset>();
  for (const desc of descriptions) {
    const uriRaw = desc.InterplayURI;
    const uri = typeof uriRaw === 'string' ? uriRaw
      : (uriRaw && typeof uriRaw === 'object' && typeof (uriRaw as Record<string, unknown>)['#text'] === 'string')
        ? (uriRaw as Record<string, unknown>)['#text'] as string
        : '';
    if (!uri) continue;

    const attrs = attributesToMap(desc);
    const name = attrs['Display Name'] ?? '';

    // Defansif client-side filtre (rapor §9.2: server Contains; false-positive
    // ihtimaline karşı dcCode gerçekten adda mı?).
    if (dcCode && !name.includes(dcCode)) continue;

    const id = extractMobId(uri);
    const online = (attrs['Media Status'] ?? '').toLowerCase() === 'online';
    const modifiedAt = attrs['Modified Date'] ?? '';

    const asset: AvidAsset = { id, name, modifiedAt, online };
    const durationRaw = attrs['Duration'];
    if (durationRaw) {
      const n = Number(durationRaw);
      if (Number.isFinite(n)) asset.durationFrames = n;
    }

    // Aynı mobid varsa ilkini koru (path varyasyonu sadece kopya).
    if (!byMob.has(id)) byMob.set(id, asset);
  }

  return Array.from(byMob.values());
}

// ----------------------------------------------------------------------------
// K2 — Jobs.SubmitJobUsingProfile (restore) + Jobs.GetJobStatus (rapor §11, §16.5/6)
// ----------------------------------------------------------------------------

/**
 * assetId (mobid) → tam InterplayURI. K1 search'te id alanına mobid sakladık;
 * restore submit için `interplay://<workgroup>?mobid=<id>` formatına geri kurarız.
 * assetId zaten tam `interplay://...` ise olduğu gibi kullan (defansif).
 */
export function assetIdToInterplayUri(cfg: AvidConfig, assetId: string): string {
  if (assetId.startsWith('interplay://')) return assetId;
  return `interplay://${cfg.workgroup}?mobid=${assetId}`;
}

/**
 * SubmitJobUsingProfile body (rapor §11.1, §16.5). KRİTİK (§11.2):
 * SourceServerType=Assets — Archive sahada INVALID_PARAMETER döner.
 * Profile string birebir eşleşmeli (§11.3, env'den).
 */
export function buildRestoreSubmitBody(cfg: AvidConfig, interplayUri: string): string {
  return (
    `<b:SubmitJobUsingProfile>` +
    `<b:Service>${escapeXml(cfg.restoreService)}</b:Service>` +
    `<b:Profile>${escapeXml(cfg.restoreProfile)}</b:Profile>` +
    `<b:InterplayURI>${escapeXml(interplayUri)}</b:InterplayURI>` +
    `<b:SourceServerType>Assets</b:SourceServerType>` +
    `</b:SubmitJobUsingProfile>`
  );
}

/** GetJobStatus body (rapor §16.6). Tek JobURI sorgular. */
export function buildJobStatusBody(jobUri: string): string {
  return (
    `<b:GetJobStatus>` +
    `<b:JobURIs><b:JobURI>${escapeXml(jobUri)}</b:JobURI></b:JobURIs>` +
    `</b:GetJobStatus>`
  );
}

/**
 * Saha job status string'ini AvidJobPhaseStatus'a çevir (rapor §11.5).
 * Saha enum'u: Pending → Processing N% → Completed. Doc `RUNNING` der; ikisi de
 * tanınır. Failed/Aborted/Cancelled → failed. Tanınmayan → running (defansif;
 * sonraki tick tekrar bakar — yanlışlıkla terminal'e düşmesin).
 */
export function mapJobStatus(raw: string): AvidJobPhaseStatus {
  const s = raw.trim().toLowerCase();
  if (s === 'completed' || s === 'complete' || s === 'done' || s === 'finished') return 'done';
  if (s === 'pending' || s === 'queued' || s === 'submitted') return 'pending';
  if (s.startsWith('processing') || s === 'running' || s === 'inprogress' || s === 'in progress') return 'running';
  if (s === 'failed' || s === 'aborted' || s === 'cancelled' || s === 'canceled' || s === 'error') return 'failed';
  return 'running';
}

/** Parse ağacında ilk JobURI / JobStatus düğümünü bul (ns-agnostik, recursive). */
function findFirstKey(node: unknown, key: string): unknown {
  if (node == null || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  if (key in obj && obj[key] != null) return obj[key];
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findFirstKey(item, key);
        if (found !== undefined) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findFirstKey(value, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

async function interplayRequestRestore(
  cfg: AvidConfig,
  input: AvidRestoreTransferInput,
): Promise<{ avidJobId: string }> {
  const interplayUri = assetIdToInterplayUri(cfg, input.assetId);
  const bodyXml = buildRestoreSubmitBody(cfg, interplayUri);
  const body = await postSoap(cfg, {
    service: 'Jobs',
    bodyNs: AVID_NS.jobsTypes,
    bodyXml,
  });

  // Yanıt: JobURI (örn. interplay://BSVMWG/DMS?jobid=...). ns-agnostik ara.
  const jobUriRaw = findFirstKey(body, 'JobURI');
  const jobUri = textOf(jobUriRaw);
  if (!jobUri) {
    throw new Error('Avid SubmitJobUsingProfile yanıtında JobURI yok (restore submit başarısız?)');
  }
  return { avidJobId: jobUri };
}

async function interplayPollJobStatus(
  cfg: AvidConfig,
  avidJobId: string,
): Promise<AvidJobStatusResult> {
  const bodyXml = buildJobStatusBody(avidJobId);
  const body = await postSoap(cfg, {
    service: 'Jobs',
    bodyNs: AVID_NS.jobsTypes,
    bodyXml,
  });

  // JobStatus düğümü: { Status, PercentComplete?, ErrorMessage? } (ns-agnostik).
  const statusRaw = textOf(findFirstKey(body, 'Status'));
  if (!statusRaw) {
    // Status okunamadı → defansif running (terminal'e düşürme).
    return { status: 'running' };
  }
  const phase = mapJobStatus(statusRaw);
  if (phase === 'failed') {
    const errMsg = textOf(findFirstKey(body, 'ErrorMessage')) || `avid job status=${statusRaw}`;
    return { status: 'failed', errorMsg: errMsg };
  }
  return { status: phase };
}

// ----------------------------------------------------------------------------
// K3 — Transfer.SendToPlayback (transfer) — Jobs.GetJobStatus ile izlenir
//      (rapor §13.1, §16.8). ⚠️ Avid DIŞI yayın havuzuna gönderir; hedef
//      (engine+device) OP-TEYİDİ bekliyor. SendToPlayback canlı doğrulanMADI.
// ----------------------------------------------------------------------------

/**
 * SendToPlayback body (rapor §13.1/§16.8). Device-driven: hedef =
 * (TransferEngineHostName + DestinationPlaybackDevice). FTP yolu engine
 * config'inde gömülü, API'ye geçmez (rapor §13.2).
 *
 * `engine` + `device` parametre (failover için): birincil/yedek farklı
 * (engine, device) çiftine gönderir. ⚠️ Yedek engine'de device adı farklı
 * olabilir (playback-engine-02 → MCR_YEDEK, MCR değil). Verilmezse cfg birincil değerleri.
 */
export function buildSendToPlaybackBody(
  cfg: AvidConfig,
  interplayUri: string,
  engine: string = cfg.transferEngine,
  device: string = cfg.playbackDevice,
): string {
  return (
    `<b:SendToPlayback>` +
    `<b:TransferEngineHostName>${escapeXml(engine)}</b:TransferEngineHostName>` +
    `<b:InterplayURI>${escapeXml(interplayUri)}</b:InterplayURI>` +
    `<b:DestinationPlaybackDevice>${escapeXml(device)}</b:DestinationPlaybackDevice>` +
    `<b:Priority>${escapeXml(cfg.transferPriority)}</b:Priority>` +
    `<b:Overwrite>false</b:Overwrite>` +
    `</b:SendToPlayback>`
  );
}

/** SendToPlayback hedefi — (engine, device) çifti. */
interface PlaybackTarget { engine: string; device: string; }

/** Tek bir (engine, device) hedefine SendToPlayback dener; JobURI döner veya throw. */
async function sendToPlaybackOnTarget(
  cfg: AvidConfig,
  interplayUri: string,
  target: PlaybackTarget,
): Promise<string> {
  const bodyXml = buildSendToPlaybackBody(cfg, interplayUri, target.engine, target.device);
  const body = await postSoap(cfg, {
    service: 'Transfer',
    bodyNs: AVID_NS.transferTypes,
    bodyXml,
  });
  const jobUri = textOf(findFirstKey(body, 'JobURI'));
  if (!jobUri) {
    throw new Error(`Avid SendToPlayback (${target.engine}/${target.device}) yanıtında JobURI yok`);
  }
  return jobUri;
}

async function interplayRequestTransfer(
  cfg: AvidConfig,
  input: AvidRestoreTransferInput,
): Promise<{ avidJobId: string }> {
  // V1 basit: restore'dan gelen assetId doğrudan kullanılır. Rapor §10.5
  // ".transfer companion kanonik" notu ileride eklenebilir (ayrı iş).
  const interplayUri = assetIdToInterplayUri(cfg, input.assetId);

  // Failover hedefleri (operasyon kararı 2026-05-31, canlı doğrulandı):
  //   birincil playback-engine-01/MCR → yedek playback-engine-02/MCR_YEDEK.
  // ⚠️ Yedekte device adı FARKLI (MCR yok, MCR_YEDEK var).
  const targets: PlaybackTarget[] = [
    { engine: cfg.transferEngine, device: cfg.playbackDevice },
  ];
  if (cfg.transferEngineFallback && cfg.transferEngineFallback !== cfg.transferEngine) {
    targets.push({
      engine: cfg.transferEngineFallback,
      device: cfg.playbackDeviceFallback || cfg.playbackDevice,
    });
  }

  let lastErr: unknown;
  for (const target of targets) {
    try {
      const jobUri = await sendToPlaybackOnTarget(cfg, interplayUri, target);
      return { avidJobId: jobUri };
    } catch (err) {
      lastErr = err;
      // Sonraki hedefe düş (varsa). Tümü tükenirse son hatayı fırlat.
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('Avid SendToPlayback tüm hedeflerde başarısız');
}

// ----------------------------------------------------------------------------
// K3 GERÇEK YOLU — CTMS submitSTPJob (Cloud UX). IPWS SendToPlayback "Cannot
// import" verdiği için yukarıdaki kod KULLANILMIYOR (referans/rollback için
// tutuluyor). CDS Service mixdown+encode+playback'i kendi orkestra eder.
// 2026-06-01 BCMS'ten canlı doğrulandı.
// ----------------------------------------------------------------------------

/**
 * CTMS submitSTPJob ile transfer başlat. Token yöneticisinden canlı token alır.
 *  - mobId = HAM sequence (input.assetId) — companion gerekmez.
 *  - processName = input.assetName ?? input.dcCode (GUI'de görünen ad).
 *  - videoId = input.dcCode (TapeID; kullanıcı kararı: düz DC kodu).
 * Dönen CTMS uuid jobId `avidJobId` olarak saklanır (DB değişmez).
 */
async function ctmsRequestTransfer(
  cfg: AvidConfig,
  tokenManager: CtmsTokenManager,
  input: AvidRestoreTransferInput,
): Promise<{ avidJobId: string }> {
  const result = await postSubmitStpJob(cfg, tokenManager.getToken(), {
    realm: cfg.clouduxRealm,
    mobId: input.assetId,
    processName: input.assetName ?? input.dcCode,
    videoId: input.dcCode,
    device: cfg.stpDevice,
    profile: cfg.stpProfile,
  });
  return { avidJobId: result.jobId };
}

/**
 * CTMS transfer status izleme — V1 (optimistic-submit).
 *
 * ⚠️ Per-job REST status endpoint'i YOK (mcds-host:8443 erişilemez; CTMS'te REST
 * status rel'i yok; UI websocket kullanıyor — 2026-06-01 keşif). submitSTPJob 200
 * = transfer CDS kuyruğuna kabul edildi. Gerçek RUNNING→COMPLETED takibi sonraki
 * faz (WS broadcastNotifications veya Process job-list REST'i).
 *
 * V1 davranışı: kabul edilen job `done` sayılır (transfer Avid'e teslim edildi
 * semantiği). Operatör nihai sonucu Cloud UX Process ekranından görür. Bu sınır
 * dokümana yazıldı.
 */
async function ctmsPollTransferStatus(
  _cfg: AvidConfig,
  _avidJobId: string,
): Promise<AvidJobStatusResult> {
  return { status: 'done' };
}

// ============================================================================
// Factory — module-scope singleton (mock state korunur tick-arası)
// ============================================================================

let _singleton: AvidAdapter | null = null;
let _mockState: MockState | null = null;
/** Cache imzası: DB `avid_settings.updatedAt` ISO (yoksa 'env'). Değişince rebuild. */
let _sig: string | null = null;

/**
 * Adapter factory — DB-farkında, imza-cache'li.
 *
 * `prisma` verilirse `avid_settings` satırı env üstüne bindirilir
 * (`applyAvidOverrides`); satır yok/boşsa davranış = bugünkü env. Ayar değişince
 * (`updatedAt` farklı) adapter bir sonraki çağrıda yeniden kurulur — worker bir
 * sonraki tick'te yeni bilgiyi alır (restart gerekmez, cross-container DB ortak).
 *
 * `prisma` yoksa (testler / eski çağrı) → env-only, bugünkü davranış. DB okuma
 * hatası → sessizce env'e düşülür (canlı akış kesilmez).
 */
export async function getAvidAdapter(
  prisma?: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AvidAdapter> {
  let overrides = null;
  let updatedAt: Date | null = null;
  if (prisma) {
    try {
      const r = await readAvidSettings(prisma);
      if (r) { overrides = r.overrides; updatedAt = r.updatedAt; }
    } catch { /* DB okunamadı → env'e düş (canlı akış kesilmesin) */ }
  }
  const sig = updatedAt ? updatedAt.toISOString() : 'env';
  if (_singleton && _sig === sig) return _singleton;

  const cfg = applyAvidOverrides(loadAvidConfig(env), overrides);
  if (cfg.mockMode || !cfg.enabled) {
    _mockState = createInitialMockState();
    _singleton = createMockAvidAdapter(_mockState);
  } else {
    assertAvidConfigReady(cfg);
    _singleton = createInterplayAvidAdapter(cfg);
  }
  _sig = sig;
  return _singleton;
}

/** Test-only: singleton + mock state + cache imzasını sıfırla (her test başı izolasyon). */
export function __resetAvidAdapterForTest(): void {
  _singleton = null;
  _mockState = null;
  _sig = null;
}
