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
import { loadAvidConfig, assertAvidConfigReady, type AvidConfig } from './avid.config.js';

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

export function createInterplayAvidAdapter(_cfg: AvidConfig): AvidAdapter {
  const notImpl = (op: string) => () => {
    throw new Error(`Avid Interplay adapter not implemented yet (op=${op}); set RESTORE_AVID_MOCK=true`);
  };
  return {
    searchByDcCode:     notImpl('searchByDcCode'),
    requestRestore:     notImpl('requestRestore'),
    pollRestoreStatus:  notImpl('pollRestoreStatus'),
    requestTransfer:    notImpl('requestTransfer'),
    pollTransferStatus: notImpl('pollTransferStatus'),
  };
}

// ============================================================================
// Factory — module-scope singleton (mock state korunur tick-arası)
// ============================================================================

let _singleton: AvidAdapter | null = null;
let _mockState: MockState | null = null;

export function getAvidAdapter(env: NodeJS.ProcessEnv = process.env): AvidAdapter {
  if (_singleton) return _singleton;
  const cfg = loadAvidConfig(env);
  if (cfg.mockMode || !cfg.enabled) {
    _mockState = createInitialMockState();
    _singleton = createMockAvidAdapter(_mockState);
    return _singleton;
  }
  assertAvidConfigReady(cfg);
  _singleton = createInterplayAvidAdapter(cfg);
  return _singleton;
}

/** Test-only: singleton + mock state'i sıfırla (her test başı izolasyon). */
export function __resetAvidAdapterForTest(): void {
  _singleton = null;
  _mockState = null;
}
