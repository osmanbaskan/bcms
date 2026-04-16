export type ScheduleStatus = 'DRAFT' | 'CONFIRMED' | 'ON_AIR' | 'COMPLETED' | 'CANCELLED';

export interface Schedule {
  id: number;
  channelId: number;
  startTime: string; // ISO 8601
  endTime: string;
  title: string;
  contentId?: number;
  broadcastTypeId?: number;
  status: ScheduleStatus;
  createdBy: string;
  version: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  channel?: { id: number; name: string; type: string };
}

export interface CreateScheduleDto {
  channelId: number;
  startTime: string;
  endTime: string;
  title: string;
  contentId?: number;
  broadcastTypeId?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateScheduleDto {
  startTime?: string;
  endTime?: string;
  title?: string;
  status?: ScheduleStatus;
  contentId?: number;
  metadata?: Record<string, unknown>;
}

export interface ScheduleConflict {
  id: number;
  channelId: number;
  startTime: string;
  endTime: string;
  title: string;
  status: ScheduleStatus;
}
