import { z } from 'zod';

export const createBookingSchema = z.object({
  scheduleId: z.number().int().positive().optional(),
  teamId:     z.number().int().positive().optional(),
  matchId:    z.number().int().positive().optional(),
  status:     z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  taskTitle:   z.string().min(1).max(300).optional(),
  taskDetails: z.string().max(5000).optional(),
  taskReport:  z.string().max(5000).optional(),
  userGroup:   z.string().min(1).max(50).optional(),
  assigneeId:   z.string().max(100).nullable().optional(),
  assigneeName: z.string().max(200).nullable().optional(),
  startDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  notes:      z.string().max(5000).optional(),
  metadata:   z.record(z.unknown()).optional(),
}).refine((value) => Boolean(value.scheduleId || value.taskTitle), {
  message: 'scheduleId veya taskTitle zorunludur',
});

export const updateBookingSchema = z.object({
  status:   z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  taskTitle:   z.string().min(1).max(300).optional(),
  taskDetails: z.string().max(5000).optional(),
  taskReport:  z.string().max(5000).optional(),
  assigneeId:   z.string().max(100).nullable().optional(),
  assigneeName: z.string().max(200).nullable().optional(),
  startDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  notes:    z.string().max(5000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateBookingDto = z.infer<typeof createBookingSchema>;
export type UpdateBookingDto = z.infer<typeof updateBookingSchema>;
