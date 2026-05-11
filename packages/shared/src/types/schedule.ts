// Hard delete (2026-05-11): ON_AIR kaldırıldı. MCR/playout sekmesi silindiği için
// ON_AIR'a geçişi tetikleyen yol kalmadı; LivePlanEntry IN_PROGRESS source-of-truth.
export type ScheduleStatus = 'DRAFT' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';

// SCHED-B5a (Y5-2a): legacy `ScheduleUsageScope` ve `ScheduleUsage` type'ları
// silindi (usage_scope kod dependency sıfırlama; B5b'de kolon DROP).

export interface Schedule {
  id: number;
  /** OPTA müsabaka kaydına bağlantı; manuel girilen yayınlarda null (HIGH-SHARED-001 fix). */
  matchId?: number | null;
  startTime: string; // ISO 8601
  endTime: string;
  title: string;
  contentId?: number;
  broadcastTypeId?: number;
  status: ScheduleStatus;
  // SCHED-B5a (Y5-2a): `usageScope` field silindi.
  // Y5-8 (2026-05-11): legacy `channelId` field silindi. Canonical:
  // `channel1Id` / `channel2Id` / `channel3Id`.
  reportLeague?: string | null;
  reportSeason?: string | null;
  reportWeekNumber?: number | null;
  createdBy: string;
  version: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** @deprecated Y5-8: backend Schedule.channel relation kaldırıldı; bu alan
   *  artık API response'unda yer almaz. UI template'leri optional-chain ile
   *  graceful fallback yapsın (`?.name ?? '-'`). Reporting UI B5b'de
   *  canonical 3-channel slot rendering'e taşınacak. */
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
// Y5-8 (2026-05-11): legacy `ScheduleConflict` tipi silindi (kullanım yok).

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
