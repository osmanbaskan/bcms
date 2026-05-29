/**
 * Restore V2 — Avid Interplay üç kademeli iş akışı, kademe 1 (search).
 *
 * Domain: DC kod ile Avid arşivinde arama + operatör seçim onayı.
 * DB tablo: provys_search_jobs (Prisma model: SearchJob).
 * Routes: /api/v1/search/jobs (POST + GET) + /api/v1/search/jobs/:id/select (PATCH).
 *
 * Lifecycle: QUEUED → RUNNING → AWAITING_SELECTION → SELECTED (terminal happy)
 *                                                  → NOT_FOUND  (terminal sad)
 *                                                  → FAILED     (terminal error)
 *
 * Idempotency: (dcCode, scheduleDate) için aynı anda 1 aktif (QUEUED/RUNNING/
 * AWAITING_SELECTION) job — partial unique index. Terminal kayıtlar yan yana.
 *
 * SELECTED sonrası restore kademe (POST /restore/jobs body { searchJobId })
 * bu satırdan asset bilgisini kopyalar.
 */

export type SearchJobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'AWAITING_SELECTION'
  | 'SELECTED'
  | 'NOT_FOUND'
  | 'FAILED'
  | 'CANCELLED';

/** Avid Interplay asset metadata — search sonucu + operatör seçim listesi. */
export interface AvidAsset {
  /** Interplay asset ID (MOB ID veya benzeri). PATCH select whitelist için anahtar. */
  id: string;
  /** Asset name (genelde DC kod ile aynı; UI listede görünür). */
  name: string;
  /** ISO timestamp — operatör seçim için karar verici alan. */
  modifiedAt: string;
  /**
   * Interplay'de binary online mı? Interplay metadata kataloğudur — asset
   * her zaman metadata olarak bulunur ama binary `true` (Avid'de hazır) veya
   * `false` (DIVA arşivinde) olabilir. Selection dialog rozet gösterir;
   * restore worker adapter'a geçirir.
   */
  online: boolean;
  /** Opsiyonel süre bilgisi (frame cinsi). */
  durationFrames?: number;
}

export interface SearchJobDto {
  id: number;
  dcCode: string;
  channelSlug: string;
  scheduleDate: string;
  status: SearchJobStatus;
  attemptCount: number;
  maxAttempts: number;
  /** AWAITING_SELECTION'da dolu; NOT_FOUND iken []; FAILED iken null kalabilir. */
  avidAssets: AvidAsset[] | null;
  selectedAssetId: string | null;
  selectedAssetName: string | null;
  /** Whitelist'ten eşleşen AvidAsset.online kopyası — SELECTED öncesi NULL. */
  selectedAssetOnline: boolean | null;
  selectedAt: string | null;
  selectedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMsg: string | null;
  requestedBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueSearchRequest {
  channelSlug: string;
  scheduleDate: string;
  dcCode: string;
}

export interface EnqueueSearchResponse {
  jobId: number;
  status: SearchJobStatus;
  /** Idempotent enqueue: aktif job varsa true. */
  existing: boolean;
}

export interface SelectAssetRequest {
  avidAssetId: string;
  avidAssetName: string;
}

export interface SearchJobsResponse {
  date: string;
  jobs: SearchJobDto[];
}
