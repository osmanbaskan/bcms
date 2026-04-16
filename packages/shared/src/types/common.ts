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

export interface AuditLog {
  id: number;
  entityType: string;
  entityId: number;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  beforePayload?: Record<string, unknown>;
  afterPayload?: Record<string, unknown>;
  user: string;
  ipAddress?: string;
  timestamp: string;
}
