import { z } from 'zod';

const ScheduleStatusEnum = z.enum(['DRAFT', 'CONFIRMED', 'ON_AIR', 'COMPLETED', 'CANCELLED']);

export const createScheduleSchema = z.object({
  channelId:       z.number().int().positive(),
  startTime:       z.string().datetime({ offset: true }),
  endTime:         z.string().datetime({ offset: true }),
  title:           z.string().min(1).max(500),
  contentId:       z.number().int().positive().optional(),
  broadcastTypeId: z.number().int().positive().optional(),
  metadata:        z.record(z.unknown()).optional(),
}).refine((d) => new Date(d.endTime) > new Date(d.startTime), {
  message: 'endTime must be after startTime',
  path: ['endTime'],
});

export const updateScheduleSchema = z.object({
  startTime:       z.string().datetime({ offset: true }).optional(),
  endTime:         z.string().datetime({ offset: true }).optional(),
  title:           z.string().min(1).max(500).optional(),
  status:          ScheduleStatusEnum.optional(),
  contentId:       z.number().int().positive().optional(),
  metadata:        z.record(z.unknown()).optional(),
});

export const scheduleQuerySchema = z.object({
  channel:  z.coerce.number().int().positive().optional(),
  from:     z.string().datetime({ offset: true }).optional(),
  to:       z.string().datetime({ offset: true }).optional(),
  status:   ScheduleStatusEnum.optional(),
  source:   z.enum(['manual', 'bxf']).optional(),
  page:     z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type CreateScheduleDto = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleDto = z.infer<typeof updateScheduleSchema>;
export type ScheduleQuery     = z.infer<typeof scheduleQuerySchema>;
