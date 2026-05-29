/**
 * Restore V2 — kademe 2 (restore) DTO + Zod schemas (3 kademe modeli).
 *
 * Shared package'taki `RestoreJobDto` UI contract'i; bu modül backend
 * route input validation + DB row → DTO mapper'ı sağlar.
 */

import { z } from 'zod';
import type { RestoreJob } from '@prisma/client';
import type {
  RestoreJobDto,
  RestoreJobStatus,
} from '@bcms/shared';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/** 3 kademe modeli — POST body yalnız searchJobId. Backend search'ten kopya. */
export const enqueueRestoreSchema = z.object({
  searchJobId: z.number().int().positive(),
});

export type EnqueueRestoreInput = z.infer<typeof enqueueRestoreSchema>;

export const listJobsQuerySchema = z.object({
  date: dateSchema.optional(),
});

export function mapRestoreJob(row: RestoreJob): RestoreJobDto {
  return {
    id:            row.id,
    dcCode:        row.dcCode,
    channelSlug:   row.channelSlug,
    scheduleDate:  row.scheduleDate.toISOString().slice(0, 10),
    searchJobId:   row.searchJobId,
    avidAssetId:   row.avidAssetId,
    avidAssetName: row.avidAssetName,
    avidAssetOnline: row.avidAssetOnline,
    status:        row.status as RestoreJobStatus,
    attemptCount:  row.attemptCount,
    maxAttempts:   row.maxAttempts,
    avidJobId:     row.avidJobId,
    startedAt:     row.startedAt?.toISOString() ?? null,
    finishedAt:    row.finishedAt?.toISOString() ?? null,
    errorMsg:      row.errorMsg,
    requestedBy:   row.requestedBy,
    version:       row.version,
    createdAt:     row.createdAt.toISOString(),
    updatedAt:     row.updatedAt.toISOString(),
  };
}
