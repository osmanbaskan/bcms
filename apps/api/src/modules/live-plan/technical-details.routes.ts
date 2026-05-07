import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';
import {
  createTechnicalDetailsSchema,
  updateTechnicalDetailsSchema,
} from './technical-details.schema.js';
import { LivePlanTechnicalDetailService } from './technical-details.service.js';

/**
 * Madde 5 M5-B9 (scope lock U4, 2026-05-07): live_plan_technical_details
 * parent-nested singleton routes.
 *
 * Mount: /api/v1/live-plan/:entryId/technical-details (app.ts).
 * RBAC: U11 — mevcut PERMISSIONS.livePlan.read/write/delete kullanılır.
 *
 *   GET    → null veya 200 row
 *   POST   → 201; 1:1 enforce (P2002 → 409)
 *   PATCH  → If-Match header zorunlu (428/400/412)
 *   DELETE → If-Match header zorunlu (soft); sadece kendi satırı (U8)
 */

const entryIdParam = z.coerce.number().int().positive();

function parseIfMatch(rawHeader: string | string[] | undefined): number {
  if (rawHeader === undefined) {
    throw Object.assign(
      new Error('If-Match header zorunlu (optimistic locking)'),
      { statusCode: 428 },
    );
  }
  const headerStr = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const parsed = parseInt(String(headerStr).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw Object.assign(
      new Error('If-Match header geçersiz (integer ≥0 olmalı)'),
      { statusCode: 400 },
    );
  }
  return parsed;
}

export async function livePlanTechnicalDetailsRoutes(app: FastifyInstance) {
  const svc = new LivePlanTechnicalDetailService(app);

  // ── GET ─────────────────────────────────────────────────────────────────
  app.get<{ Params: { entryId: string } }>('/', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.read),
    schema: { tags: ['LivePlan'], summary: 'Get technical details for live-plan entry (singleton, may be null)' },
  }, async (request) => {
    const entryId = entryIdParam.parse(request.params.entryId);
    const row = await svc.getByEntry(entryId);
    return row ?? null;
  });

  // ── POST ────────────────────────────────────────────────────────────────
  app.post<{ Params: { entryId: string } }>('/', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.write),
    schema: { tags: ['LivePlan'], summary: 'Create technical details (1:1 enforced)' },
  }, async (request, reply) => {
    const entryId = entryIdParam.parse(request.params.entryId);
    const dto = createTechnicalDetailsSchema.parse(request.body);
    const created = await svc.create(entryId, dto);
    reply.status(201);
    return created;
  });

  // ── PATCH ───────────────────────────────────────────────────────────────
  app.patch<{ Params: { entryId: string } }>('/', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.write),
    schema: { tags: ['LivePlan'], summary: 'Update technical details (If-Match required)' },
  }, async (request) => {
    const entryId = entryIdParam.parse(request.params.entryId);
    const dto = updateTechnicalDetailsSchema.parse(request.body);
    const ifMatch = parseIfMatch(request.headers['if-match']);
    return svc.update(entryId, dto, ifMatch);
  });

  // ── DELETE ──────────────────────────────────────────────────────────────
  app.delete<{ Params: { entryId: string } }>('/', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.delete),
    schema: { tags: ['LivePlan'], summary: 'Soft delete technical details (If-Match required)' },
  }, async (request) => {
    const entryId = entryIdParam.parse(request.params.entryId);
    const ifMatch = parseIfMatch(request.headers['if-match']);
    return svc.remove(entryId, ifMatch);
  });
}
