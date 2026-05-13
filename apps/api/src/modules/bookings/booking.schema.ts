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
}).refine(
  // ORTA-API hijyen (2026-05-04): startDate ≤ dueDate consistency.
  // İkisi de verilmiş ise startDate dueDate'ten sonra olamaz.
  (v) => !v.startDate || !v.dueDate || v.startDate <= v.dueDate,
  { message: 'startDate dueDate\'den sonra olamaz', path: ['dueDate'] },
);

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
).refine(
  // ORTA-API hijyen: startDate ≤ dueDate consistency (update'te de).
  (v) => !v.startDate || !v.dueDate || v.startDate <= v.dueDate,
  { message: 'startDate dueDate\'den sonra olamaz', path: ['dueDate'] },
);

export type CreateBookingDto = z.infer<typeof createBookingSchema>;
export type UpdateBookingDto = z.infer<typeof updateBookingSchema>;

// 2026-05-14: "İş Takip" — yorum + durum geçmişi.
//
// Yorum gövdesi plain text; sunucu trim eder. HTML render YOK (Angular default
// escape). max 4000 = makul long-form yorum sınırı.
export const createBookingCommentSchema = z.object({
  body: z.string().trim().min(1, 'Yorum boş olamaz').max(4000),
});

export type CreateBookingCommentDto = z.infer<typeof createBookingCommentSchema>;

// 2026-05-14: list filter — başlık araması + status filter.
//   qTitle: trim + empty kabul edilmez (zod min(1)); frontend hiç göndermesin.
//           Sadece taskTitle üzerinde case-insensitive contains.
//   status: BookingStatus enum; "Tümü" frontend tarafında param göndermez.
export const listBookingsQuerySchema = z.object({
  scheduleId: z.coerce.number().int().positive().optional(),
  group:      z.string().optional(),
  qTitle:     z.string().trim().min(1).max(120).optional(),
  status:     z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  page:       z.coerce.number().int().positive().default(1),
  pageSize:   z.coerce.number().int().positive().max(200).default(50),
});

export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
