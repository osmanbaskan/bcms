export type ScheduleStatus = 'DRAFT' | 'CONFIRMED' | 'ON_AIR' | 'COMPLETED' | 'CANCELLED';
export type ScheduleUsageScope = 'broadcast' | 'live-plan';
export type ScheduleUsage = ScheduleUsageScope | 'all';

export interface Schedule {
  id: number;
  channelId: number | null;
  startTime: string; // ISO 8601
  endTime: string;
  title: string;
  contentId?: number;
  broadcastTypeId?: number;
  status: ScheduleStatus;
  usageScope: ScheduleUsageScope;
  reportLeague?: string | null;
  reportSeason?: string | null;
  reportWeekNumber?: number | null;
  createdBy: string;
  version: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  channel?: { id: number; name: string; type: string } | null;
  /** Ingest sekmesinden read-only — canlı yayın için kayıt portu ataması */
  recordingPort?: string | null;
  backupRecordingPort?: string | null;
}

export interface CreateScheduleDto {
  channelId: number | null;
  startTime: string;
  endTime: string;
  title: string;
  contentId?: number;
  broadcastTypeId?: number;
  usageScope?: ScheduleUsageScope;
  metadata?: Record<string, unknown>;
}

export interface UpdateScheduleDto {
  channelId?: number | null;
  startTime?: string;
  endTime?: string;
  title?: string;
  status?: ScheduleStatus;
  contentId?: number;
  usageScope?: ScheduleUsageScope;
  metadata?: Record<string, unknown>;
}

export interface ScheduleConflict {
  id: number;
  channelId: number | null;
  startTime: string;
  endTime: string;
  title: string;
  status: ScheduleStatus;
}
