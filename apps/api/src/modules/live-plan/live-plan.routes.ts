import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';
import {
  createLivePlanSchema,
  listLivePlanQuerySchema,
  updateLivePlanSchema,
} from './live-plan.schema.js';
import { LivePlanService } from './live-plan.service.js';

/**
 * Madde 5 M5-B2 (decision §3.3): live-plan canonical /api/v1/live-plan routes.
 *
 * K9 invariant: PATCH + DELETE If-Match ZORUNLU (Schedule'dan bilinçli ayrışma).
 *   - missing → 428
 *   - invalid (NaN / non-positive) → 400
 *   - version mismatch → 412
 *   - not found / soft-deleted → 404
 *
 * Schedule investigation showed If-Match is optional there. Live-plan
 * intentionally requires it because this is a new API surface and K3
 * optimistic locking must be enforced.
 */

const idParamSchema = z.coerce.number().int().positive();

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

export async function livePlanRoutes(app: FastifyInstance) {
  const svc = new LivePlanService(app);

  // ── GET /api/v1/live-plan ────────────────────────────────────────────────
  app.get('/', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.read),
    schema: { tags: ['LivePlan'], summary: 'List live-plan entries' },
  }, async (request) => {
    const query = listLivePlanQuerySchema.parse(request.query);
    return svc.list(query);
  });

  // ── GET /api/v1/live-plan/:id ────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.read),
    schema: { tags: ['LivePlan'], summary: 'Live-plan entry detail' },
  }, async (request) => {
    const id = idParamSchema.parse(request.params.id);
    return svc.getById(id);
  });

  // ── POST /api/v1/live-plan ───────────────────────────────────────────────
  app.post('/', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.write),
    schema: { tags: ['LivePlan'], summary: 'Create live-plan entry' },
  }, async (request, reply) => {
    const dto = createLivePlanSchema.parse(request.body);
    const created = await svc.create(dto, request);
    reply.status(201);
    return created;
  });

  // ── PATCH /api/v1/live-plan/:id ──────────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.write),
    schema: { tags: ['LivePlan'], summary: 'Update live-plan entry (If-Match required)' },
  }, async (request) => {
    const id = idParamSchema.parse(request.params.id);
    const dto = updateLivePlanSchema.parse(request.body);
    const ifMatch = parseIfMatch(request.headers['if-match']);
    return svc.update(id, dto, ifMatch, request);
  });

  // ── DELETE /api/v1/live-plan/:id ─────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.delete),
    schema: { tags: ['LivePlan'], summary: 'Soft delete live-plan entry (If-Match required)' },
  }, async (request) => {
    const id = idParamSchema.parse(request.params.id);
    const ifMatch = parseIfMatch(request.headers['if-match']);
    return svc.remove(id, ifMatch, request);
  });
}
