import { z } from 'zod';

const ScheduleStatusEnum = z.enum(['DRAFT', 'CONFIRMED', 'ON_AIR', 'COMPLETED', 'CANCELLED']);
const ScheduleUsageScopeEnum = z.enum(['broadcast', 'live-plan']);

// ORTA-API-1.2.8 fix (2026-05-04): metadata application-side size cap.
// DB Json kolonu unbounded; uygulama 16KB üst sınır koyuyor (DB jsonb için
// makul, UI'da gösterilmiyor).
const scheduleMetadataSchema = z.record(z.unknown())
  .refine((m) => JSON.stringify(m).length <= 16_384, 'metadata 16KB sınırını aşıyor');

export const createScheduleSchema = z.object({
  channelId:       z.number().int().positive().nullable().optional(),
  startTime:       z.string().datetime({ offset: true }),
  endTime:         z.string().datetime({ offset: true }),
  title:           z.string().min(1).max(500),
  contentId:       z.number().int().positive().optional(),
  broadcastTypeId: z.number().int().positive().optional(),
  usageScope:      ScheduleUsageScopeEnum.default('broadcast'),
  // Madde 3 PR-3A (2026-05-05): optaMatchId opsiyonel kolon yazımı.
  // Backward compat: metadata.optaMatchId hâlâ destekleniyor (dual-write).
  optaMatchId:     z.string().trim().min(1).max(50).optional(),
  metadata:        scheduleMetadataSchema.optional(),
}).refine((d) => new Date(d.endTime) > new Date(d.startTime), {
  message: 'endTime must be after startTime',
  path: ['endTime'],
});

export const updateScheduleSchema = z.object({
  channelId:       z.number().int().positive().nullable().optional(),
  startTime:       z.string().datetime({ offset: true }).optional(),
  endTime:         z.string().datetime({ offset: true }).optional(),
  title:           z.string().min(1).max(500).optional(),
  status:          ScheduleStatusEnum.optional(),
  contentId:       z.number().int().positive().optional(),
  broadcastTypeId: z.number().int().positive().optional(),
  usageScope:      ScheduleUsageScopeEnum.optional(),
  // Madde 3 PR-3A (2026-05-05): 3-state nullable semantik.
  //   undefined → kolona dokunma; metadata da değişmez (eğer aynı update'te metadata yoksa).
  //   null      → kolonu temizle + metadata.optaMatchId key'ini kaldır.
  //   string    → kolon set + metadata.optaMatchId paralel set.
  optaMatchId:     z.string().trim().min(1).max(50).nullable().optional(),
  metadata:        scheduleMetadataSchema.optional(),
}).refine(
  // MED-API-005 fix (2026-05-05): startTime ve endTime ikisi de PATCH'te
  // verilirse end > start olmalı. Sadece biri verilirse refine atlanır
  // (other-side DB'deki mevcut değer ile karşılaştırılması route handler'da
  // yapılır — burada sadece hem-hem güncelleme tutarlılığı zorlanıyor).
  (d) => !d.startTime || !d.endTime || new Date(d.endTime) > new Date(d.startTime),
  { message: 'endTime must be after startTime', path: ['endTime'] },
);

export const scheduleQuerySchema = z.object({
  channel:  z.coerce.number().int().positive().optional(),
  from:     z.string().datetime({ offset: true }).optional(),
  to:       z.string().datetime({ offset: true }).optional(),
  status:   ScheduleStatusEnum.optional(),
  source:   z.enum(['manual', 'bxf']).optional(),
  usage:    z.enum(['broadcast', 'live-plan', 'all']).default('broadcast'),
  league:   z.string().trim().min(1).optional(),
  season:   z.string().trim().min(1).optional(),
  week:     z.coerce.number().int().positive().optional(),
  page:     z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const importQuerySchema = z.object({
  durationMin: z.coerce.number().int().positive().optional(),
});

export const exportQuerySchema = z.object({
  from:      z.string().datetime({ offset: true }).optional(),
  to:        z.string().datetime({ offset: true }).optional(),
  channelId: z.coerce.number().int().positive().optional(),
  title:     z.string().optional(),
});

export const livePlanQuerySchema = z.object({
  channelId: z.coerce.number().int().positive().optional(),
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

export type CreateScheduleDto = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleDto = z.infer<typeof updateScheduleSchema>;
export type ScheduleQuery     = z.infer<typeof scheduleQuerySchema>;

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
