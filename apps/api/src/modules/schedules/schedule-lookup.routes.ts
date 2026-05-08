import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';

/**
 * SCHED-B4-prep (2026-05-08): Schedule broadcast lookup tabloları için
 * read-only endpoint'ler. Yayın Planlama formu dropdown source.
 *
 * Mount: `/api/v1/schedules/lookups` (register prefix).
 * Endpoint: `GET /:type` (whitelist: commercial_options | logo_options | format_options).
 *
 * - Read-only: CRUD/admin yok; B4 frontend dropdown ihtiyacı için stabil URL.
 * - Audit yok (read).
 * - `livePlanLookupRoutes` pattern paritesi (whitelist + :type segment).
 * - Soft-deleted satırlar default exclude; query `?activeOnly=true` ile aktif
 *   filtre de uygulanır.
 *
 * Lookup admin CRUD ihtiyacı follow-up PR (B4 kapsamı dışı; B4 sadece
 * dropdown doldurmak için yeterli).
 */

const SCHEDULE_LOOKUP_REGISTRY = {
  commercial_options: 'scheduleCommercialOption',
  logo_options:       'scheduleLogoOption',
  format_options:     'scheduleFormatOption',
} as const;

type ScheduleLookupType = keyof typeof SCHEDULE_LOOKUP_REGISTRY;

function isValidScheduleLookupType(type: string): type is ScheduleLookupType {
  return type in SCHEDULE_LOOKUP_REGISTRY;
}

interface LookupRow {
  id: number;
  label: string;
  active: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface LookupDelegate {
  findMany(args: {
    where: Record<string, unknown>;
    orderBy: Array<Record<string, 'asc' | 'desc'>>;
  }): Promise<LookupRow[]>;
}

const listQuerySchema = z.object({
  activeOnly: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

export async function scheduleLookupRoutes(app: FastifyInstance) {
  // ── GET /api/v1/schedules/lookups/:type ────────────────────────────────
  app.get<{ Params: { type: string } }>('/:type', {
    preHandler: app.requireGroup(...PERMISSIONS.scheduleLookups.read),
    schema: { tags: ['ScheduleLookups'], summary: 'List schedule lookup values (read-only)' },
  }, async (request) => {
    const typeParam = request.params.type;
    if (!isValidScheduleLookupType(typeParam)) {
      throw Object.assign(
        new Error(`Lookup type '${typeParam}' geçersiz; whitelist'te yok`),
        { statusCode: 404 },
      );
    }

    const { activeOnly } = listQuerySchema.parse(request.query);
    const prismaKey = SCHEDULE_LOOKUP_REGISTRY[typeParam];
    // 25 lookup model'in tek union type'ı oluşturmak pratik değil; delegate
    // operation'ları uniform (livePlanLookupRoutes paritesi).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = (app.prisma as any)[prismaKey] as LookupDelegate;

    const items = await delegate.findMany({
      where: {
        deletedAt: null,
        ...(activeOnly ? { active: true } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });

    return { items };
  });
}

// Test'ler için export (whitelist doğrulama).
export { SCHEDULE_LOOKUP_REGISTRY };
export type { ScheduleLookupType };
