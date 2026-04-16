import { z } from 'zod';

export const createBookingSchema = z.object({
  scheduleId: z.number().int().positive(),
  teamId:     z.number().int().positive().optional(),
  matchId:    z.number().int().positive().optional(),
  notes:      z.string().max(1000).optional(),
  metadata:   z.record(z.unknown()).optional(),
});

export const updateBookingSchema = z.object({
  status:   z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  notes:    z.string().max(1000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateBookingDto = z.infer<typeof createBookingSchema>;
export type UpdateBookingDto = z.infer<typeof updateBookingSchema>;
