import { z } from 'zod';

const ScheduleStatusEnum = z.enum(['DRAFT', 'CONFIRMED', 'ON_AIR', 'COMPLETED', 'CANCELLED']);
const ScheduleUsageScopeEnum = z.enum(['broadcast', 'live-plan']);

export const createScheduleSchema = z.object({
  channelId:       z.number().int().positive().nullable().optional(),
  startTime:       z.string().datetime({ offset: true }),
  endTime:         z.string().datetime({ offset: true }),
  title:           z.string().min(1).max(500),
  contentId:       z.number().int().positive().optional(),
  broadcastTypeId: z.number().int().positive().optional(),
  usageScope:      ScheduleUsageScopeEnum.default('broadcast'),
  metadata:        z.record(z.unknown()).optional(),
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
  metadata:        z.record(z.unknown()).optional(),
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
