import { z } from 'zod';

/**
 * Madde 5 M5-B9 (scope lock U5/U7, 2026-05-07): live_plan_transmission_segments
 * Zod validators.
 *
 * U3: version YOK V1 — last-write-wins; If-Match header parse edilmez.
 * U7: PATCH undefined=no change; description null kabul (clear); enum/time
 *     alanları null değil (T6 NOT NULL — Zod ile yakala).
 */

export const feedRoleSchema = z.enum(['MAIN', 'BACKUP', 'FIBER', 'OTHER']);
export const segmentKindSchema = z.enum([
  'TEST', 'PROGRAM', 'HIGHLIGHTS', 'INTERVIEW', 'OTHER',
]);

const dateOrderRefine = (d: { startTime: string; endTime: string }) =>
  new Date(d.endTime) > new Date(d.startTime);

export const createSegmentSchema = z.object({
  feedRole:    feedRoleSchema,
  kind:        segmentKindSchema,
  startTime:   z.string().datetime(),
  endTime:     z.string().datetime(),
  description: z.string().trim().min(1).max(20_000).optional(),
}).refine(dateOrderRefine, {
  message: 'endTime, startTime\'tan sonra olmalı',
  path:    ['endTime'],
});

export type CreateSegmentDto = z.infer<typeof createSegmentSchema>;

export const updateSegmentSchema = z.object({
  feedRole:    feedRoleSchema.optional(),
  kind:        segmentKindSchema.optional(),
  startTime:   z.string().datetime().optional(),
  endTime:     z.string().datetime().optional(),
  description: z.string().trim().min(1).max(20_000).nullable().optional(),
}).refine((d) => Object.keys(d).length > 0, {
  message: 'En az bir field güncellenmeli',
}).refine(
  (d) => {
    if (d.startTime !== undefined && d.endTime !== undefined) {
      return new Date(d.endTime) > new Date(d.startTime);
    }
    return true;
  },
  { message: 'endTime, startTime\'tan sonra olmalı', path: ['endTime'] },
);

export type UpdateSegmentDto = z.infer<typeof updateSegmentSchema>;

export const listSegmentQuerySchema = z.object({
  feedRole: feedRoleSchema.optional(),
  kind:     segmentKindSchema.optional(),
});

export type ListSegmentQuery = z.infer<typeof listSegmentQuerySchema>;
