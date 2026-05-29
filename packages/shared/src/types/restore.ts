/**
 * Restore V2 — Avid Interplay üç kademeli iş akışı, kademe 2 (restore).
 *
 * Domain: Search SELECTED asset'i Avid arşivinden Interplay workspace'e getirme.
 * DB tablo: provys_restore_jobs (Prisma model: RestoreJob).
 * Routes: /api/v1/restore/jobs (POST + GET).
 *
 * Lifecycle: QUEUED → RUNNING → DONE / FAILED. CANCELLED V3 forward-compat.
 * NOT_FOUND search domain'e taşındı (3 kademe modeli, 2026-05-28).
 *
 * Idempotency: (dcCode, scheduleDate) için aynı anda 1 aktif (QUEUED/RUNNING) job.
 *
 * Precondition (POST): search_jobs.status=SELECTED + selected_asset_id NOT NULL.
 * Backend asset bilgisini (avidAssetId, avidAssetName, channelSlug, scheduleDate,
 * dcCode) search'ten kopyalayıp restore_jobs'a yazar.
 */

export type RestoreJobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface RestoreJobDto {
  id: number;
  dcCode: string;
  channelSlug: string;
  scheduleDate: string;
  /** Search kademe SELECTED job id (FK YOK — lifecycle ayrı). */
  searchJobId: number | null;
  /** Search SELECTED'ten kopya — restore worker bu id'yi Avid'e gönderir. */
  avidAssetId: string | null;
  avidAssetName: string | null;
  /**
   * Search'ten kopya — true ise restore worker adapter'a assetOnline=true
   * geçer (Interplay no-op DONE simülasyonu). false ise DIVA→Avid restore.
   */
  avidAssetOnline: boolean | null;
  status: RestoreJobStatus;
  attemptCount: number;
  maxAttempts: number;
  avidJobId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMsg: string | null;
  requestedBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** POST body: yalnız searchJobId. Backend asset bilgisini search'ten kopyalar. */
export interface EnqueueRestoreRequest {
  searchJobId: number;
}

export interface EnqueueRestoreResponse {
  jobId: number;
  status: RestoreJobStatus;
  existing: boolean;
}

export interface RestoreJobsResponse {
  date: string;
  jobs: RestoreJobDto[];
}
