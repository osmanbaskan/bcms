export type Role =
  | 'admin'
  | 'planner'
  | 'scheduler'
  | 'expert'
  | 'ingest_operator'
  | 'monitoring'
  | 'viewer';

export interface JwtPayload {
  sub: string;
  preferred_username: string;
  email: string;
  realm_access: { roles: Role[] };
  resource_access: Record<string, { roles: string[] }>;
  iat: number;
  exp: number;
}

/** Permissions matrix */
export const PERMISSIONS = {
  schedules: {
    read:   ['admin', 'planner', 'scheduler', 'monitoring', 'viewer'] as Role[],
    write:  ['admin', 'planner', 'scheduler'] as Role[],
    delete: ['admin'] as Role[],
  },
  bookings: {
    read:   ['admin', 'planner', 'scheduler', 'viewer'] as Role[],
    write:  ['admin', 'planner'] as Role[],
    delete: ['admin'] as Role[],
  },
  ingest: {
    read:   ['admin', 'ingest_operator', 'monitoring'] as Role[],
    write:  ['admin', 'ingest_operator'] as Role[],
    delete: ['admin'] as Role[],
  },
  channels: {
    read:   ['admin', 'planner', 'scheduler', 'monitoring', 'viewer', 'expert'] as Role[],
    write:  ['admin'] as Role[],
    delete: ['admin'] as Role[],
  },
  incidents: {
    read:   ['admin', 'planner', 'monitoring', 'viewer'] as Role[],
    write:  ['admin', 'monitoring'] as Role[],
    delete: ['admin'] as Role[],
  },
  monitoring: {
    read:   ['admin', 'monitoring', 'viewer'] as Role[],
    write:  ['admin', 'monitoring'] as Role[],
  },
  auditLogs: {
    read:   ['admin'] as Role[],
  },
  reports: {
    read:   ['admin', 'expert'] as Role[],
    export: ['admin', 'expert'] as Role[],
  },
} as const;
