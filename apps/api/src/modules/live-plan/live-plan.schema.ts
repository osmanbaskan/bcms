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
  page:        z.coerce.number().int().positive().default(1),
  pageSize:    z.coerce.number().int().positive().max(200).default(50),
});

export type ListLivePlanQuery = z.infer<typeof listLivePlanQuerySchema>;
