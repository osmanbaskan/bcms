import { z } from 'zod';

// ORTA-DB-3.1.5 fix (2026-05-04): metadata application-side size cap.
// DB seviyesinde TEXT/JSONB unbounded ama uygulama reddediyor (16KB makul).
const bookingMetadataSchema = z.record(z.unknown())
  .refine((m) => JSON.stringify(m).length <= 16_384, 'metadata 16KB sınırını aşıyor');

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
  metadata:   bookingMetadataSchema.optional(),
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
  metadata: bookingMetadataSchema.optional(),
}).refine(
  // MED-API-006 fix (2026-05-05): UpdateBooking en az bir field değiştirmeli;
  // boş PATCH kabul edilirse audit log boşa yazılır.
  (value) => Object.values(value).some((v) => v !== undefined),
  { message: 'En az bir alan güncellenmeli' },
);

export type CreateBookingDto = z.infer<typeof createBookingSchema>;
export type UpdateBookingDto = z.infer<typeof updateBookingSchema>;
