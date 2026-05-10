import { z } from 'zod';

const ScheduleStatusEnum = z.enum(['DRAFT', 'CONFIRMED', 'ON_AIR', 'COMPLETED', 'CANCELLED']);

// SCHED-B5a (Y5-4): legacy createScheduleSchema, updateScheduleSchema,
// scheduleQuerySchema (`usage` field), schedule `metadata` Zod helper silindi.
// SCHED-B5a Block 2 (2026-05-10): BXF tamamen kaldırıldı; importQuerySchema +
// `source` query field + `'bxf'` enum silindi (Y5-6 BXF kapanışı).
// Yerine canonical broadcast flow schemas (aşağıda) ve reporting/export
// query'leri kalır. `metadata`/`start_time`/`end_time` Prisma kolonları
// DURUR (B5b).

// Reporting + export + ingest-candidates query (canonical filter; usage +
// source param kaldırıldı; route handler default `eventKey IS NOT NULL` filter).
// Y5-8 (2026-05-11): legacy `channel` filter kaldırıldı.
export interface ScheduleQuery {
  from?:     string;
  to?:       string;
  status?:   z.infer<typeof ScheduleStatusEnum>;
  league?:   string;
  season?:   string;
  week?:     number;
  page:      number;
  pageSize:  number;
}

export const exportQuerySchema = z.object({
  from:      z.string().datetime({ offset: true }).optional(),
  to:        z.string().datetime({ offset: true }).optional(),
  title:     z.string().optional(),
});

export const livePlanQuerySchema = z.object({
  from:      z.string().datetime({ offset: true }).optional(),
  to:        z.string().datetime({ offset: true }).optional(),
  league:    z.string().trim().min(1).optional(),
  season:    z.string().trim().min(1).optional(),
  week:      z.coerce.number().int().positive().optional(),
  page:      z.coerce.number().int().min(1).max(500).default(1),
  pageSize:  z.coerce.number().int().min(1).max(1000).default(500),
});

export const livePlanExportQuerySchema = livePlanQuerySchema.extend({
  title: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHED-B3a (decision §3.5 K16, K-B3 lock 2026-05-07): Broadcast flow
// canonical create/update DTO. Yeni Schedule UI bu schema ile çağırır;
// eski createScheduleSchema/updateScheduleSchema legacy path olarak SCHED-B5
// destructive cleanup'a kadar paralel kalır.
//
// Required (K32): eventKey, selectedLivePlanEntryId, scheduleDate, scheduleTime.
// Opsiyonel (K30-K31): channel_1/2/3, commercial/logo/format option.
// Schedule başlığı/takım/title doğrudan body'de ALINMAZ (K-B3.20): live-plan
// entry'den kopya yapılır; schedule.update body'de title/team_1/2 alanı yok.
// ─────────────────────────────────────────────────────────────────────────────

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD format');
// HH:MM veya HH:MM:SS kabul; service composeDateTime saniye yoksa 00 ekler.
const timeStr = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'HH:MM veya HH:MM:SS format');

export const createBroadcastScheduleSchema = z.object({
  eventKey:                z.string().trim().min(1).max(120),
  selectedLivePlanEntryId: z.number().int().positive(),
  scheduleDate:            dateStr,
  scheduleTime:            timeStr,
  channel1Id:              z.number().int().positive().nullable().optional(),
  channel2Id:              z.number().int().positive().nullable().optional(),
  channel3Id:              z.number().int().positive().nullable().optional(),
  commercialOptionId:      z.number().int().positive().nullable().optional(),
  logoOptionId:            z.number().int().positive().nullable().optional(),
  formatOptionId:          z.number().int().positive().nullable().optional(),
});

export type CreateBroadcastScheduleDto = z.infer<typeof createBroadcastScheduleSchema>;

export const updateBroadcastScheduleSchema = z.object({
  scheduleDate:       dateStr.optional(),
  scheduleTime:       timeStr.optional(),
  channel1Id:         z.number().int().positive().nullable().optional(),
  channel2Id:         z.number().int().positive().nullable().optional(),
  channel3Id:         z.number().int().positive().nullable().optional(),
  commercialOptionId: z.number().int().positive().nullable().optional(),
  logoOptionId:       z.number().int().positive().nullable().optional(),
  formatOptionId:     z.number().int().positive().nullable().optional(),
}).refine((d) => Object.keys(d).length > 0, {
  message: 'En az bir field güncellenmeli',
});

export type UpdateBroadcastScheduleDto = z.infer<typeof updateBroadcastScheduleSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// SCHED-B4-prep (2026-05-08): broadcast schedule list query — Yayın Planlama
// list ekranı server-side filter contract'ı.
//
// Server-side filter (route handler):
//   eventKey != null AND selectedLivePlanEntryId != null
//   AND scheduleDate != null AND scheduleTime != null
// (B5 öncesi karışık veri için canonical broadcast-complete row guarantee'si.)
// ─────────────────────────────────────────────────────────────────────────────

export const broadcastScheduleListQuerySchema = z.object({
  eventKey: z.string().trim().min(1).max(120).optional(),
  // from/to canonical `scheduleDate` (YYYY-MM-DD) bazlı filter — legacy
  // start/end_time DROP edildiğinde (B5) hâlâ doğru çalışır.
  from:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD format').optional(),
  to:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD format').optional(),
  status:   ScheduleStatusEnum.optional(),
  page:     z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type BroadcastScheduleListQuery = z.infer<typeof broadcastScheduleListQuerySchema>;
