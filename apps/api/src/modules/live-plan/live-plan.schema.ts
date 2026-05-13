import { z } from 'zod';

/**
 * Madde 5 M5-B2 (decision §3.3 K8): live-plan Zod schemas.
 *
 * - Create: required title + iki tarih; status default PLANNED;
 *   eventEndTime > eventStartTime Zod refine.
 * - Update: partial; en az 1 field zorunlu; service-level merge-aware date check
 *   (BookingService pattern — Zod tek başına yeterli değil çünkü sadece biri
 *   gönderilirse existing row ile karşılaştırılmalı).
 * - List query: status comma-separated multi-value; pageSize max 200; date
 *   range half-open (event_start_time >= from AND event_start_time < to).
 * - Metadata: object only (z.record(z.unknown())); array DEĞİL.
 */

export const livePlanStatusSchema = z.enum([
  'PLANNED',
  'READY',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);

export type LivePlanStatusValue = z.infer<typeof livePlanStatusSchema>;

const dateOrderRefine = (d: { eventStartTime: string; eventEndTime: string }) =>
  new Date(d.eventEndTime) > new Date(d.eventStartTime);

export const createLivePlanSchema = z.object({
  title:           z.string().trim().min(1).max(500),
  eventStartTime:  z.string().datetime(),
  eventEndTime:    z.string().datetime(),
  matchId:         z.number().int().positive().optional(),
  optaMatchId:     z.string().trim().min(1).max(80).optional(),
  status:          livePlanStatusSchema.optional().default('PLANNED'),
  operationNotes:  z.string().trim().max(8_000).optional(),
  // K-B3.20 follow-up (2026-05-07): SCHED-B3a Schedule create bu alanları
  // entry'den kopyalar. M5-B2 zorunlu değildi; manuel content boş kalabilir.
  // OPTA selection (B3b) zorunluluğu ayrı karar.
  team1Name:       z.string().trim().min(1).max(200).optional(),
  team2Name:       z.string().trim().min(1).max(200).optional(),
  // SCHED-B3b (K-B3 lock 2026-05-07): genel POST /live-plan manuel content
  // create için; sourceType + eventKey backend'de set edilir (sourceType
  // forced 'MANUAL'; eventKey = `manual:<uuid>`). OPTA create yolu sadece
  // POST /live-plan/from-opta üzerinden; bu endpoint'te body'de
  // sourceType/eventKey KABUL EDİLMEZ — domain bypass yasak.
  // Madde 5 K15.1 (M5-B4): metadata JSONB kolonu kaldırıldı. Teknik detaylar
  // artık `live_plan_technical_details` tablosunda structured kolon olarak yaşar
  // (M5-B7+); ad-hoc not için operationNotes yeterli.
}).refine(dateOrderRefine, {
  message: 'eventEndTime, eventStartTime\'tan sonra olmalı',
  path:    ['eventEndTime'],
});

/**
 * Output type — parse() sonrası status default 'PLANNED' uygulanmış. Service
 * imzasında bu kullanılır; test'ler yine input formatında çağırabilir
 * (status optional).
 */
export type CreateLivePlanDto = z.input<typeof createLivePlanSchema>;

/**
 * Update: partial — service-level merge-aware date check yapılır
 * (sadece biri gönderilirse existing row ile karşılaştır).
 * En az 1 field zorunlu.
 */
export const updateLivePlanSchema = z.object({
  title:           z.string().trim().min(1).max(500).optional(),
  eventStartTime:  z.string().datetime().optional(),
  eventEndTime:    z.string().datetime().optional(),
  matchId:         z.number().int().positive().nullable().optional(),
  optaMatchId:     z.string().trim().min(1).max(80).nullable().optional(),
  status:          livePlanStatusSchema.optional(),
  operationNotes:  z.string().trim().max(8_000).nullable().optional(),
  // K-B3.20 follow-up (2026-05-07): null → kolonu temizle.
  team1Name:       z.string().trim().min(1).max(200).nullable().optional(),
  team2Name:       z.string().trim().min(1).max(200).nullable().optional(),
  // 2026-05-11: Düzenle formu 3-channel slot canonical model üzerinden
  // kanal yazımı; her slot bağımsız (channel1/2/3). Reverse-sync (live-plan →
  // schedule) channel'a dokunmaz; schedule kanonik kalır (K-B3.12).
  channel1Id:      z.number().int().positive().nullable().optional(),
  channel2Id:      z.number().int().positive().nullable().optional(),
  channel3Id:      z.number().int().positive().nullable().optional(),
  // Madde 5 K15.1 (M5-B4): metadata JSONB kolonu kaldırıldı.
}).refine((d) => Object.keys(d).length > 0, {
  message: 'En az bir field güncellenmeli',
}).refine(
  (d) => {
    if (d.eventStartTime !== undefined && d.eventEndTime !== undefined) {
      return new Date(d.eventEndTime) > new Date(d.eventStartTime);
    }
    return true; // tek tarih → service-level merge-aware check
  },
  { message: 'eventEndTime, eventStartTime\'tan sonra olmalı', path: ['eventEndTime'] },
);

export type UpdateLivePlanDto = z.infer<typeof updateLivePlanSchema>;

/**
 * List query — status comma-separated multi-value.
 *   ?status=PLANNED,READY → ['PLANNED','READY']
 *   ?status=PLANNED       → ['PLANNED']
 *   yoksa                 → undefined (filter yok)
 */
export const listLivePlanQuerySchema = z.object({
  status: z.string().optional()
    .transform((s) => (s ? s.split(',').map((v) => v.trim()).filter(Boolean) : undefined))
    .pipe(z.array(livePlanStatusSchema).optional()),
  from:        z.string().datetime().optional(),
  to:          z.string().datetime().optional(),
  matchId:     z.coerce.number().int().positive().optional(),
  optaMatchId: z.string().trim().min(1).optional(),
  /** 2026-05-13: Yayın Planlama Lig/Hafta filter. `match.leagueId` / `match.weekNumber`
   *  ile inner join filter; manuel entry (matchId NULL) bu filter aktifken
   *  doğal olarak dışarıda kalır. */
  leagueId:    z.coerce.number().int().positive().optional(),
  weekNumber:  z.coerce.number().int().positive().optional(),
  page:        z.coerce.number().int().positive().default(1),
  pageSize:    z.coerce.number().int().positive().max(200).default(50),
});

export type ListLivePlanQuery = z.infer<typeof listLivePlanQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// SCHED-B3b (K-B3.5, K-B3.10, 2026-05-07): from-opta endpoint body.
// Kullanıcı OPTA seçim akışından maç gönderir; backend matches.opta_uid
// üzerinden temel bilgi kopyalar. Default duplicate engellenir (409).
// ─────────────────────────────────────────────────────────────────────────────

export const createFromOptaSchema = z.object({
  optaMatchId: z.string().trim().min(1).max(80),
});

export type CreateFromOptaDto = z.infer<typeof createFromOptaSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 2026-05-13: Yayın Planlama seçimli Excel export.
//   POST /api/v1/live-plan/export
//   Body: { ids: number[1..500], title?: string<=120 }
// ─────────────────────────────────────────────────────────────────────────────

export const livePlanExportRequestSchema = z.object({
  ids:   z.array(z.number().int().positive())
           .min(1, 'En az 1 kayıt seçilmelidir')
           .max(500, 'En fazla 500 kayıt seçilebilir'),
  title: z.string().trim().max(120).optional(),
});

export type LivePlanExportRequest = z.infer<typeof livePlanExportRequestSchema>;
