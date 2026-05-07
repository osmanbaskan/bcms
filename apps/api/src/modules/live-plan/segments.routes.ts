import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';
import {
  createSegmentSchema,
  listSegmentQuerySchema,
  updateSegmentSchema,
} from './segments.schema.js';
import { LivePlanTransmissionSegmentService } from './segments.service.js';

/**
 * Madde 5 M5-B9 (scope lock U5, 2026-05-07): live_plan_transmission_segments
 * parent-nested collection routes.
 *
 * Mount: /api/v1/live-plan/:entryId/segments (app.ts).
 *
 *   GET    /              → list (feedRole/kind filter)
 *   POST   /              → 201
 *   PATCH  /:segmentId    → update (no If-Match V1)
 *   DELETE /:segmentId    → soft delete
 */

const entryIdParam   = z.coerce.number().int().positive();
const segmentIdParam = z.coerce.number().int().positive();

export async function livePlanSegmentsRoutes(app: FastifyInstance) {
  const svc = new LivePlanTransmissionSegmentService(app);

  // ── GET / ───────────────────────────────────────────────────────────────
  app.get<{ Params: { entryId: string } }>('/', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.read),
    schema: { tags: ['LivePlan'], summary: 'List transmission segments for live-plan entry' },
  }, async (request) => {
    const entryId = entryIdParam.parse(request.params.entryId);
    const query   = listSegmentQuerySchema.parse(request.query);
    return svc.list(entryId, query);
  });

  // ── POST / ──────────────────────────────────────────────────────────────
  app.post<{ Params: { entryId: string } }>('/', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.write),
    schema: { tags: ['LivePlan'], summary: 'Create transmission segment' },
  }, async (request, reply) => {
    const entryId = entryIdParam.parse(request.params.entryId);
    const dto = createSegmentSchema.parse(request.body);
    const created = await svc.create(entryId, dto);
    reply.status(201);
    return created;
  });

  // ── PATCH /:segmentId ───────────────────────────────────────────────────
  app.patch<{ Params: { entryId: string; segmentId: string } }>('/:segmentId', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.write),
    schema: { tags: ['LivePlan'], summary: 'Update transmission segment (no If-Match V1)' },
  }, async (request) => {
    const entryId   = entryIdParam.parse(request.params.entryId);
    const segmentId = segmentIdParam.parse(request.params.segmentId);
    const dto = updateSegmentSchema.parse(request.body);
    return svc.update(entryId, segmentId, dto);
  });

  // ── DELETE /:segmentId ──────────────────────────────────────────────────
  app.delete<{ Params: { entryId: string; segmentId: string } }>('/:segmentId', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.delete),
    schema: { tags: ['LivePlan'], summary: 'Soft delete transmission segment' },
  }, async (request) => {
    const entryId   = entryIdParam.parse(request.params.entryId);
    const segmentId = segmentIdParam.parse(request.params.segmentId);
    return svc.remove(entryId, segmentId);
  });
}
