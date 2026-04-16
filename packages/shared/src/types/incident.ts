export type IncidentSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export interface Incident {
  id: number;
  scheduleId?: number;
  eventType: string;
  description?: string;
  tcIn?: string;
  severity: IncidentSeverity;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface TimelineEvent {
  id: number;
  scheduleId: number;
  tc: string;
  type: string;
  note?: string;
  createdBy: string;
  createdAt: string;
}
