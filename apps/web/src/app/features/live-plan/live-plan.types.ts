/**
 * Madde 5 M5-B10a — Live-plan UI types + endpoint helper.
 *
 * Backend referans:
 *   - apps/api/src/modules/live-plan/live-plan.{routes,service,schema}.ts
 *   - apps/api/src/modules/live-plan/segments.{routes,service,schema}.ts
 *
 * Tip tanımları backend response shape'leri ile birebir eşleşmeli (M5-B5
 * lookup shape mismatch fix sürecindeki bug bir daha tekrarlanmasın).
 */

// ── Live-Plan Entry ────────────────────────────────────────────────────────
export type LivePlanStatus =
  | 'PLANNED'
  | 'READY'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED';

export interface LivePlanEntry {
  id:              number;
  title:           string;
  eventStartTime:  string;
  eventEndTime:    string;
  matchId:         number | null;
  optaMatchId:     string | null;
  status:          LivePlanStatus;
  operationNotes:  string | null;
  createdBy:       string | null;
  version:         number;
  createdAt:       string;
  updatedAt:       string;
  deletedAt:       string | null;
  // SCHED-B2/B3a/B3b broadcast flow alanları (canonical; backend response'tan
  // gelir, picker dialog ve cross-domain işlemler için kullanılır).
  eventKey?:   string | null;
  sourceType?: 'OPTA' | 'MANUAL';
  team1Name?:  string | null;
  team2Name?:  string | null;
  channel1Id?: number | null;
  channel2Id?: number | null;
  channel3Id?: number | null;
}

export interface LivePlanListResponse {
  items:    LivePlanEntry[];
  total:    number;
  page:     number;
  pageSize: number;
}

export interface CreateLivePlanBody {
  title:          string;
  eventStartTime: string;
  eventEndTime:   string;
  status?:        LivePlanStatus;
  operationNotes?: string;
}

// ── Transmisyon Segments ───────────────────────────────────────────────────
export const FEED_ROLES = ['MAIN', 'BACKUP', 'FIBER', 'OTHER'] as const;
export type FeedRole = (typeof FEED_ROLES)[number];

export const SEGMENT_KINDS = ['TEST', 'PROGRAM', 'HIGHLIGHTS', 'INTERVIEW', 'OTHER'] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export interface TransmissionSegment {
  id:              number;
  livePlanEntryId: number;
  feedRole:        FeedRole;
  kind:            SegmentKind;
  startTime:       string;
  endTime:         string;
  description:     string | null;
  createdAt:       string;
  updatedAt:       string;
  deletedAt:       string | null;
}

export interface CreateSegmentBody {
  feedRole:    FeedRole;
  kind:        SegmentKind;
  startTime:   string;
  endTime:     string;
  description?: string;
}

export interface UpdateSegmentBody {
  feedRole?:    FeedRole;
  kind?:        SegmentKind;
  startTime?:   string;
  endTime?:     string;
  /** null: alanı temizle (M5-B9 U7 PATCH semantiği). */
  description?: string | null;
}

// ── Endpoint helper (raw string component dışı tutulur — M5-B6 paritesi) ──
export const livePlanEndpoint = {
  list:    () => '/live-plan',
  detail:  (id: number) => `/live-plan/${id}`,
  segments: {
    list:   (entryId: number) => `/live-plan/${entryId}/segments`,
    detail: (entryId: number, segId: number) =>
      `/live-plan/${entryId}/segments/${segId}`,
  },
  /** Placeholder — M5-B10b 76 alan formu kullanacak. */
  technicalDetails: (entryId: number) => `/live-plan/${entryId}/technical-details`,
};

// ── UI labels (Türkçe) ─────────────────────────────────────────────────────
export const FEED_ROLE_LABELS: Record<FeedRole, string> = {
  MAIN:   'Ana',
  BACKUP: 'Yedek',
  FIBER:  'Fiber',
  OTHER:  'Diğer',
};

export const SEGMENT_KIND_LABELS: Record<SegmentKind, string> = {
  TEST:       'Test',
  PROGRAM:    'Program',
  HIGHLIGHTS: 'Özet',
  INTERVIEW:  'Röportaj',
  OTHER:      'Diğer',
};

export const LIVE_PLAN_STATUS_LABELS: Record<LivePlanStatus, string> = {
  PLANNED:     'Planlandı',
  READY:       'Hazır',
  IN_PROGRESS: 'Devam Ediyor',
  COMPLETED:   'Tamamlandı',
  CANCELLED:   'İptal',
};
