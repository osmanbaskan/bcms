export type IngestStatus = 'PENDING' | 'PROCESSING' | 'PROXY_GEN' | 'QC' | 'COMPLETED' | 'FAILED';

export interface IngestJob {
  id: number;
  sourcePath: string;
  targetId?: number;
  status: IngestStatus;
  checksum?: string;
  proxyPath?: string;
  errorMsg?: string;
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
  metadata?: Record<string, unknown>;
}

export interface IngestCallbackDto {
  jobId: number;
  status: IngestStatus;
  proxyPath?: string;
  checksum?: string;
  errorMsg?: string;
  qcReport?: Omit<QcReport, 'id' | 'jobId' | 'createdAt'>;
}
