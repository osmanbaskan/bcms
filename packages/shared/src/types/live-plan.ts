/**
 * Madde 5 M5-B1+ live-plan canonical types.
 *
 * Backend Prisma model `LivePlanEntry` ve route'lar (`/api/v1/live-plan*`)
 * paritesi. JSON/metadata YOK (M5-B4 ile metadata kolonu DROP edildi);
 * structured kolonlar canonical kaynak.
 *
 * Mutation restore (2026-05-10): Canlı Yayın Plan UI mutation aksiyonları
 * (Yeni / Düzenle / Çoğalt / Sil) bu canonical endpoint'lere bağlanır;
 * legacy `/schedules` mutation YOK.
 */

export const LIVE_PLAN_STATUSES = [
  'PLANNED',
  'READY',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type LivePlanStatus = (typeof LIVE_PLAN_STATUSES)[number];

export type LivePlanSourceType = 'OPTA' | 'MANUAL';

export interface LivePlanEntry {
  id:             number;
  title:          string;
  eventStartTime: string; // ISO 8601
  eventEndTime:   string;
  matchId:        number | null;
  optaMatchId:    string | null;
  status:         LivePlanStatus;
  operationNotes: string | null;
  createdBy:      string | null;
  /** Optimistic locking — PATCH/DELETE If-Match header zorunlu (K9). */
  version:        number;
  createdAt:      string;
  updatedAt:      string;
  deletedAt:      string | null;
  /** SCHED-B2/B3 canonical: `manual:<uuid>` veya `opta:<optaUid>`. */
  eventKey:       string | null;
  sourceType:     LivePlanSourceType;
  /** Schedule broadcast flow reverse sync ile kopyalanır (K-B3.11/12).
   *  Manuel POST /live-plan body'sinde KABUL EDİLMEZ. */
  channel1Id:     number | null;
  channel2Id:     number | null;
  channel3Id:     number | null;
  team1Name:      string | null;
  team2Name:      string | null;
  /** OPTA Match.league.name join'i (read-only; 2026-05-11). Yazma payload'a
   *  girmez; UI read-only chip. matchId null veya match.league null ise null. */
  leagueName?:    string | null;
  /** 2026-05-11: list/getById response zenginleştirmesi. 14 FK için (id +
   *  resolved name) çiftleri; isimler 10 lookup tablosundan batch-fetch ile
   *  backend tarafında resolve edilir. technical_details satırı yoksa null. */
  technicalDetails?: TechnicalDetailsDisplay | null;
}

export interface TechnicalDetailsDisplay {
  modulationTypeId:     number | null; modulationTypeName:     string | null;
  videoCodingId:        number | null; videoCodingName:        string | null;
  ird1Id:               number | null; ird1Name:               string | null;
  ird2Id:               number | null; ird2Name:               string | null;
  ird3Id:               number | null; ird3Name:               string | null;
  fiber1Id:             number | null; fiber1Name:             string | null;
  fiber2Id:             number | null; fiber2Name:             string | null;
  demodId:              number | null; demodName:              string | null;
  tieId:                number | null; tieName:                string | null;
  virtualResourceId:    number | null; virtualResourceName:    string | null;
  hdvgResourceId:       number | null; hdvgResourceName:       string | null;
  int1ResourceId:       number | null; int1ResourceName:       string | null;
  int2ResourceId:       number | null; int2ResourceName:       string | null;
  offTubeId:            number | null; offTubeName:            string | null;
  languageId:           number | null; languageName:           string | null;
  secondLanguageId:     number | null; secondLanguageName:     string | null;
}

/**
 * Manual create body — backend Zod (`createLivePlanSchema`) paritesi.
 * `sourceType`/`eventKey` body'de kabul edilmez (backend forced MANUAL +
 * `manual:<uuid>`); `channel*` reverse sync ile beslenir, manuel atama yok.
 */
export interface CreateLivePlanEntryDto {
  title:           string;
  eventStartTime:  string; // ISO 8601
  eventEndTime:    string;
  matchId?:        number;
  optaMatchId?:    string;
  status?:         LivePlanStatus;
  operationNotes?: string;
  team1Name?:      string;
  team2Name?:      string;
}

/**
 * Partial update — backend `updateLivePlanSchema` paritesi.
 * En az 1 field zorunlu (Zod refine). PATCH `/live-plan/:id` + If-Match.
 */
export interface UpdateLivePlanEntryDto {
  title?:           string;
  eventStartTime?:  string;
  eventEndTime?:    string;
  matchId?:         number | null;
  optaMatchId?:     string | null;
  status?:          LivePlanStatus;
  operationNotes?:  string | null;
  team1Name?:       string | null;
  team2Name?:       string | null;
  /** 2026-05-11: 3-channel slot canonical. live-plan PATCH live_plan_entries
   *  kolonlarını günceller; syncScheduleFromLivePlan channel'a dokunmaz. */
  channel1Id?:      number | null;
  channel2Id?:      number | null;
  channel3Id?:      number | null;
}

/** OPTA seçim akışı; matches.opta_uid'den temel bilgi kopya. */
export interface CreateLivePlanFromOptaDto {
  optaMatchId: string;
}

/** Backend list response shape (`{ items, total, page, pageSize }`). */
export interface LivePlanListResponse {
  items:    LivePlanEntry[];
  total:    number;
  page:     number;
  pageSize: number;
}
