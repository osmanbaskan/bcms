/**
 * Restore V2 — kademe 3 (transfer) DTO + Zod schemas (3 kademe modeli).
 */

import { z } from 'zod';
import type { TransferJob } from '@prisma/client';
import type { TransferJobDto, TransferJobStatus } from '@bcms/shared';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/** 3 kademe modeli — POST body yalnız restoreJobId. Backend restore'dan kopya. */
export const enqueueTransferSchema = z.object({
  restoreJobId: z.number().int().positive(),
});

export type EnqueueTransferInput = z.infer<typeof enqueueTransferSchema>;

export const listJobsQuerySchema = z.object({
  date: dateSchema.optional(),
});

export function mapTransferJob(row: TransferJob): TransferJobDto {
  return {
    id:            row.id,
    dcCode:        row.dcCode,
    channelSlug:   row.channelSlug,
    scheduleDate:  row.scheduleDate.toISOString().slice(0, 10),
    restoreJobId:  row.restoreJobId,
    avidAssetId:   row.avidAssetId,
    avidAssetName: row.avidAssetName,
    avidAssetOnline: row.avidAssetOnline,
    status:        row.status as TransferJobStatus,
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
