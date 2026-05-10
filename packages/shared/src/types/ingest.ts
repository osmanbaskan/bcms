export type IngestStatus = 'PENDING' | 'PROCESSING' | 'PROXY_GEN' | 'QC' | 'COMPLETED' | 'FAILED';
export type IngestPlanStatus = 'WAITING' | 'RECEIVED' | 'INGEST_STARTED' | 'COMPLETED' | 'ISSUE';

export interface IngestJob {
  id: number;
  sourcePath: string;
  targetId?: number;
  status: IngestStatus;
  checksum?: string;
  proxyPath?: string;
  errorMsg?: string;
  /**
   * @deprecated A4 (DECISION V1 §4.A4, 2026-05-10) — backend artık metadata'yı
   * persiste etmiyor ve API response'unda dönmüyor (kolon DROP edildi). Alan
   * sadece frontend cleanup PR'ı atılana kadar geçici compile uyumluluğu için
   * korunuyor. Yeni kod metadata field'ına bağımlılık eklemesin.
   */
  metadata?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  qcReport?: QcReport;
}

export interface QcReport {
  id: number;
  jobId: number;
  codec?: string;
  resolution?: string;
  duration?: number;
  frameRate?: number;
  bitrate?: number;
  loudness?: number;
  errors?: unknown[];
  warnings?: unknown[];
  passed: boolean;
  createdAt: string;
}

export interface CreateIngestJobDto {
  sourcePath: string;
  targetId?: number;
  /** Phase A2 + A4 (DECISION-BACKEND-CANONICAL-DATA-MODEL-V1 §4.A2/§4.A4):
   *  IngestPlanItem'a tek canonical FK. A2 PR-2c metadata.ingestPlanSourceKey
   *  fallback'ini, A4 metadata kolonunun kendisini kaldırdı; manuel ingest
   *  body'sinde tek resolver path. */
  planItemId?: number;
}

export interface IngestPlanItem {
  id: number;
  sourceType: 'live-plan' | 'studio-plan' | string;
  sourceKey: string;
  dayDate: string;
  sourcePath?: string | null;
  recordingPort?: string | null;
  backupRecordingPort?: string | null;
  plannedStartMinute?: number | null;
  plannedEndMinute?: number | null;
  status: IngestPlanStatus;
  jobId?: number | null;
  note?: string | null;
  updatedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveIngestPlanItemDto {
  sourceType: 'live-plan' | 'studio-plan' | string;
  day: string;
  sourcePath?: string | null;
  recordingPort?: string | null;
  backupRecordingPort?: string | null;
  plannedStartMinute?: number | null;
  plannedEndMinute?: number | null;
  status?: IngestPlanStatus;
  note?: string | null;
}

export interface RecordingPort {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface SaveRecordingPortsDto {
  ports: Array<Pick<RecordingPort, 'name' | 'sortOrder' | 'active'>>;
}

export interface IngestCallbackDto {
  jobId: number;
  status: IngestStatus;
  proxyPath?: string;
  checksum?: string;
  errorMsg?: string;
  qcReport?: Omit<QcReport, 'id' | 'jobId' | 'createdAt'>;
}
