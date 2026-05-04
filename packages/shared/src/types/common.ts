export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
}

/** Prisma audit_log_action enum'u — schema.prisma ve DB ile senkron.
 *  HIGH-SHARED-002 fix (2026-05-05): UPSERT, CREATEMANY eklendi. */
export type AuditAction =
  | 'CREATE' | 'UPDATE' | 'DELETE'
  | 'UPSERT' | 'CREATEMANY';

export interface AuditLog {
  id: number;
  entityType: string;
  entityId: number;
  action: AuditAction;
  beforePayload?: Record<string, unknown>;
  afterPayload?: Record<string, unknown>;
  user: string;
  ipAddress?: string;
  timestamp: string;
}
