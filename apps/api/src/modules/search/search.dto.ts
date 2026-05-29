/**
 * Restore V2 — kademe 1 (search) DTO + Zod schemas.
 */

import { z } from 'zod';
import type { SearchJob, Prisma } from '@prisma/client';
import type {
  SearchJobDto,
  SearchJobStatus,
  AvidAsset,
} from '@bcms/shared';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const enqueueSearchSchema = z.object({
  channelSlug:  z.string().trim().min(1).max(30),
  scheduleDate: dateSchema,
  dcCode:       z.string().trim().min(1).max(40),
});

export type EnqueueSearchInput = z.infer<typeof enqueueSearchSchema>;

export const selectAssetSchema = z.object({
  avidAssetId:   z.string().trim().min(1).max(120),
  avidAssetName: z.string().trim().min(1).max(500),
});

export type SelectAssetInput = z.infer<typeof selectAssetSchema>;

export const listJobsQuerySchema = z.object({
  date: dateSchema.optional(),
});

/**
 * Prisma `Json` alanından `AvidAsset[]` çıkar.
 * Backend zod ile validate etmiyor — search worker persist ederken type-safe yazıyor.
 * Defensive: malformed JSON → [].
 */
function parseAvidAssets(value: Prisma.JsonValue | null | undefined): AvidAsset[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  const result: AvidAsset[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== 'string' || typeof obj.name !== 'string' || typeof obj.modifiedAt !== 'string') continue;
    const online = typeof obj.online === 'boolean' ? obj.online : false;
    const asset: AvidAsset = { id: obj.id, name: obj.name, modifiedAt: obj.modifiedAt, online };
    if (typeof obj.durationFrames === 'number') asset.durationFrames = obj.durationFrames;
    result.push(asset);
  }
  return result;
}

export function mapSearchJob(row: SearchJob): SearchJobDto {
  return {
    id:                row.id,
    dcCode:            row.dcCode,
    channelSlug:       row.channelSlug,
    scheduleDate:      row.scheduleDate.toISOString().slice(0, 10),
    status:            row.status as SearchJobStatus,
    attemptCount:      row.attemptCount,
    maxAttempts:       row.maxAttempts,
    avidAssets:        parseAvidAssets(row.avidAssets as Prisma.JsonValue),
    selectedAssetId:     row.selectedAssetId,
    selectedAssetName:   row.selectedAssetName,
    selectedAssetOnline: row.selectedAssetOnline,
    selectedAt:        row.selectedAt?.toISOString() ?? null,
    selectedBy:        row.selectedBy,
    startedAt:         row.startedAt?.toISOString() ?? null,
    finishedAt:        row.finishedAt?.toISOString() ?? null,
    errorMsg:          row.errorMsg,
    requestedBy:       row.requestedBy,
    version:           row.version,
    createdAt:         row.createdAt.toISOString(),
    updatedAt:         row.updatedAt.toISOString(),
  };
}
