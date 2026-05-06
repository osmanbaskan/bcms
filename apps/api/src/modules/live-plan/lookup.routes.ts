import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';
import {
  LOOKUP_REGISTRY,
  isValidLookupType,
  type LookupType,
} from './lookup.registry.js';
import {
  createEquipmentOptionSchema,
  createLookupSchema,
  createTechnicalCompanySchema,
  listLookupQuerySchema,
  updateLookupSchema,
} from './lookup.schema.js';
import { LookupService } from './lookup.service.js';

/**
 * Madde 5 M5-B5 (L1-L12 lock 2026-05-06):
 * Lookup management generic CRUD routes — `/api/v1/live-plan/lookups/:type`.
 *
 * RBAC:
 *   - GET   → PERMISSIONS.livePlanLookups.read   (all authenticated; UI dropdown source)
 *   - POST/PATCH/DELETE → PERMISSIONS.livePlanLookups.write/delete (SystemEng + Admin auto-bypass)
 *
 * Whitelist (L1): :type URL segment'i LOOKUP_REGISTRY içinde olmak zorunda;
 * aksi halde 404. Bu güvenlik anchor'ı (model spoofing engeli).
 *
 * includeDeleted (L8): `?includeDeleted=true` sadece write-capable kullanıcı
 * için; aksi halde 403. Read-only kullanıcılar bu param'ı geçemez.
 */

const idParamSchema = z.coerce.number().int().positive();

function resolveLookupTypeOrThrow(typeParam: string): LookupType {
  if (!isValidLookupType(typeParam)) {
    throw Object.assign(
      new Error(`Lookup type '${typeParam}' geçersiz; whitelist'te yok`),
      { statusCode: 404 },
    );
  }
  return typeParam;
}

/**
 * Kullanıcının lookup write yetkisi var mı kontrol (L8 includeDeleted için).
 * Admin auto-bypass + SystemEng dahil.
 */
function userCanWriteLookups(request: FastifyRequest): boolean {
  const user   = request.user as { groups?: string[] } | undefined;
  const groups = user?.groups ?? [];
  // Admin auto-bypass (mevcut isAdminPrincipal pattern); SystemEng explicit.
  return groups.includes('Admin') || groups.includes('SystemEng');
}

export async function livePlanLookupRoutes(app: FastifyInstance) {
  const svc = new LookupService(app);

  // ── GET /api/v1/live-plan/lookups/:type ──────────────────────────────────
  app.get<{ Params: { type: string } }>('/:type', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlanLookups.read),
    schema: { tags: ['LivePlanLookups'], summary: 'List lookup values' },
  }, async (request) => {
    const lookupType = resolveLookupTypeOrThrow(request.params.type);
    const query      = listLookupQuerySchema.parse(request.query);

    // L8: includeDeleted yalnız write-yetkili kullanıcı için.
    if (query.includeDeleted && !userCanWriteLookups(request)) {
      throw Object.assign(
        new Error('includeDeleted parametresi için write yetkisi gerekir'),
        { statusCode: 403 },
      );
    }

    return svc.list(lookupType, {
      activeOnly:     query.activeOnly,
      includeDeleted: query.includeDeleted,
      type:           query.type,
      page:           query.page,
      pageSize:       query.pageSize,
    });
  });

  // ── GET /api/v1/live-plan/lookups/:type/:id ──────────────────────────────
  app.get<{ Params: { type: string; id: string } }>('/:type/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlanLookups.read),
    schema: { tags: ['LivePlanLookups'], summary: 'Lookup detail' },
  }, async (request) => {
    const lookupType = resolveLookupTypeOrThrow(request.params.type);
    const id         = idParamSchema.parse(request.params.id);
    return svc.getById(lookupType, id);
  });

  // ── POST /api/v1/live-plan/lookups/:type ─────────────────────────────────
  app.post<{ Params: { type: string } }>('/:type', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlanLookups.write),
    schema: { tags: ['LivePlanLookups'], summary: 'Create lookup value' },
  }, async (request, reply) => {
    const lookupType = resolveLookupTypeOrThrow(request.params.type);
    const config     = LOOKUP_REGISTRY[lookupType];

    // Polymorphic için ayrı schema (type enum whitelist).
    let dto: { label: string; active?: boolean; sortOrder?: number; type?: string };
    if (lookupType === 'technical_companies') {
      dto = createTechnicalCompanySchema.parse(request.body);
    } else if (lookupType === 'live_plan_equipment_options') {
      dto = createEquipmentOptionSchema.parse(request.body);
    } else {
      dto = createLookupSchema.parse(request.body);
    }
    void config; // not used after schema dispatch

    const created = await svc.create(lookupType, dto);
    reply.status(201).send(created);
  });

  // ── PATCH /api/v1/live-plan/lookups/:type/:id ────────────────────────────
  app.patch<{ Params: { type: string; id: string } }>('/:type/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlanLookups.write),
    schema: { tags: ['LivePlanLookups'], summary: 'Update / restore lookup value' },
  }, async (request) => {
    const lookupType = resolveLookupTypeOrThrow(request.params.type);
    const id         = idParamSchema.parse(request.params.id);
    const dto        = updateLookupSchema.parse(request.body);
    return svc.update(lookupType, id, dto);
  });

  // ── DELETE /api/v1/live-plan/lookups/:type/:id ───────────────────────────
  app.delete<{ Params: { type: string; id: string } }>('/:type/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlanLookups.delete),
    schema: { tags: ['LivePlanLookups'], summary: 'Soft delete lookup value' },
  }, async (request) => {
    const lookupType = resolveLookupTypeOrThrow(request.params.type);
    const id         = idParamSchema.parse(request.params.id);
    return svc.softDelete(lookupType, id);
  });
}
