export type ScheduleStatus = 'DRAFT' | 'CONFIRMED' | 'ON_AIR' | 'COMPLETED' | 'CANCELLED';

// SCHED-B5a (Y5-2a): legacy `ScheduleUsageScope` ve `ScheduleUsage` type'ları
// silindi (usage_scope kod dependency sıfırlama; B5b'de kolon DROP).

export interface Schedule {
  id: number;
  channelId: number | null;
  /** OPTA müsabaka kaydına bağlantı; manuel girilen yayınlarda null (HIGH-SHARED-001 fix). */
  matchId?: number | null;
  startTime: string; // ISO 8601
  endTime: string;
  title: string;
  contentId?: number;
  broadcastTypeId?: number;
  status: ScheduleStatus;
  // SCHED-B5a (Y5-2a): `usageScope` field silindi.
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
  /** Madde 3 PR-3A: type-safe optaMatchId (legacy metadata.optaMatchId paritesi). */
  optaMatchId?: string | null;
  /** SCHED-B2/B3a/B3b broadcast flow canonical alanlar (K1-K32 + K-B3.1-K-B3.27).
   *  Tüm alanlar opsiyonel — legacy schedule satırları (B5'te DELETE) bu alanları
   *  doldurmaz; broadcast flow ile yaratılan satırlar tam set'i içerir. */
  eventKey?: string | null;
  selectedLivePlanEntryId?: number | null;
  scheduleDate?: string | null;  // YYYY-MM-DD (Prisma @db.Date)
  scheduleTime?: string | null;  // HH:MM:SS (Prisma @db.Time)
  team1Name?: string | null;
  team2Name?: string | null;
  channel1Id?: number | null;
  channel2Id?: number | null;
  channel3Id?: number | null;
  commercialOptionId?: number | null;
  logoOptionId?: number | null;
  formatOptionId?: number | null;
}

// SCHED-B5a (Y5-4): legacy CreateScheduleDto + UpdateScheduleDto silindi
// (legacy POST/PATCH /api/v1/schedules endpoint'leriyle birlikte). Yeni
// canonical: CreateBroadcastScheduleDto + UpdateBroadcastScheduleDto (B3a).

export interface ScheduleConflict {
  id: number;
  channelId: number | null;
  startTime: string;
  endTime: string;
  title: string;
  status: ScheduleStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHED-B3a/B3b broadcast flow DTO'ları (backend Zod schema paritesi —
// `apps/api/src/modules/schedules/schedule.schema.ts`).
// Yayın Planlama UI POST/PATCH /api/v1/schedules/broadcast bu DTO'ları kullanır.
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateBroadcastScheduleDto {
  /** UNIQUE; format: `opta:<uid>` veya `manual:<uuid>` (live-plan entry'den kopya). */
  eventKey:                string;
  /** Live-plan entry FK (zorunlu; entry'den title/team kopya). */
  selectedLivePlanEntryId: number;
  /** YYYY-MM-DD format. */
  scheduleDate:            string;
  /** HH:MM veya HH:MM:SS format. */
  scheduleTime:            string;
  channel1Id?:             number | null;
  channel2Id?:             number | null;
  channel3Id?:             number | null;
  commercialOptionId?:     number | null;
  logoOptionId?:           number | null;
  formatOptionId?:         number | null;
}

/** PATCH — en az 1 alan zorunlu. eventKey/selectedLivePlanEntryId değiştirilemez
 *  (K-B3.13 event_key UNIQUE; entry değişimi yeni create + delete). */
export interface UpdateBroadcastScheduleDto {
  scheduleDate?:       string;
  scheduleTime?:       string;
  channel1Id?:         number | null;
  channel2Id?:         number | null;
  channel3Id?:         number | null;
  commercialOptionId?: number | null;
  logoOptionId?:       number | null;
  formatOptionId?:     number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHED-B4-prep schedule lookup options (read-only).
// Endpoint: GET /api/v1/schedules/lookups/:type → { items: ScheduleLookupOption[] }
// ─────────────────────────────────────────────────────────────────────────────

/** Whitelist; magic string yok. Service-level import edilir. */
export const SCHEDULE_LOOKUP_TYPES = [
  'commercial_options',
  'logo_options',
  'format_options',
] as const;

export type ScheduleLookupType = typeof SCHEDULE_LOOKUP_TYPES[number];

export interface ScheduleLookupOption {
  id:        number;
  label:     string;
  active:    boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ScheduleLookupListResponse {
  items: ScheduleLookupOption[];
}
