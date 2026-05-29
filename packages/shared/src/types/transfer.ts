/**
 * Restore V2 — Avid Interplay üç kademeli iş akışı, kademe 3 (transfer).
 *
 * Domain: Online asset'i Avid Interplay'den BCMS production storage'a aktarma.
 * DB tablo: provys_transfer_jobs (Prisma model: TransferJob).
 * Routes: /api/v1/transfer/jobs (POST + GET).
 *
 * Lifecycle: QUEUED → RUNNING → DONE / FAILED. CANCELLED V3 forward-compat.
 *
 * Precondition (POST): restore_jobs.status=DONE + avid_asset_id NOT NULL.
 * Backend asset bilgisini restore'dan kopyalayıp transfer_jobs'a yazar.
 *
 * DONE branch → requestSsdbResolverTick('transfer-completed:${dcCode}')
 * → SSDB cache yenilenir → Provys "Var" görür.
 */

export type TransferJobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface TransferJobDto {
  id: number;
  dcCode: string;
  channelSlug: string;
  scheduleDate: string;
  /** Restore DONE job id (FK YOK — lifecycle ayrı). */
  restoreJobId: number | null;
  /** Restore'dan kopya — transfer worker bu id'yi Avid'e gönderir. */
  avidAssetId: string | null;
  avidAssetName: string | null;
  /** Restore'dan kopya (bilgi/audit; transfer kademesinde davranış etkilemez). */
  avidAssetOnline: boolean | null;
  status: TransferJobStatus;
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

/** POST body: yalnız restoreJobId. Backend asset bilgisini restore'dan kopyalar. */
export interface EnqueueTransferRequest {
  restoreJobId: number;
}

export interface EnqueueTransferResponse {
  jobId: number;
  status: TransferJobStatus;
  existing: boolean;
}

export interface TransferJobsResponse {
  date: string;
  jobs: TransferJobDto[];
}
