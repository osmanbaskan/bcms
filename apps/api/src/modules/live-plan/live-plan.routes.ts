import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';
import {
  createLivePlanSchema,
  listLivePlanQuerySchema,
  updateLivePlanSchema,
  createFromOptaSchema,
  livePlanExportRequestSchema,
} from './live-plan.schema.js';
import { LivePlanService } from './live-plan.service.js';
import { exportLivePlanToBuffer } from './live-plan.export.js';
import { formatIstanbulDate } from '../../core/tz.js';

/**
 * Madde 5 M5-B2 (decision §3.3): live-plan canonical /api/v1/live-plan routes.
 *
 * K9 invariant: PATCH + DELETE If-Match ZORUNLU (Schedule'dan bilinçli ayrışma).
 *   - missing → 428
 *   - invalid (NaN / non-positive) → 400
 *   - version mismatch → 412
 *   - not found → 404
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

  // ── Filter dropdown endpoints (2026-05-13: Yayın Planlama Lig/Hafta) ────
  // Static path'ler param route (/:id) ÖNCESİNDE — Fastify radix-tree static
  // priority verse de defensive sıralama.
  app.get('/filters/leagues', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.read),
    schema: { tags: ['LivePlan'], summary: 'Distinct leagues in active live-plan entries' },
  }, async () => {
    return svc.listLeagueFilterOptions();
  });

  const weekFilterQuerySchema = z.object({
    leagueId: z.coerce.number().int().positive().optional(),
  });
  app.get('/filters/weeks', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.read),
    schema: { tags: ['LivePlan'], summary: 'Distinct week numbers (optional leagueId scope)' },
  }, async (request) => {
    const { leagueId } = weekFilterQuerySchema.parse(request.query);
    return svc.listWeekFilterOptions(leagueId);
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
    schema: { tags: ['LivePlan'], summary: 'Hard delete live-plan entry (If-Match required)' },
  }, async (request) => {
    const id = idParamSchema.parse(request.params.id);
    const ifMatch = parseIfMatch(request.headers['if-match']);
    return svc.remove(id, ifMatch, request);
  });

  // ── SCHED-B3b — duplicate + from-opta ────────────────────────────────────
  // K-B3.4 / K-B3.5 / K-B3.10: + duplicate açık aksiyon; OPTA seçim akışı
  // matches.opta_uid'den temel bilgi kopya (default duplicate engel 409).
  //
  // Static route (/from-opta) param route (/:id/duplicate) ÖNCESİNDE
  // tanımlanır — Fastify radix-tree static path öncelik verse de defensive
  // sıralama: yanlışlıkla id='from-opta' parse edilmesini garanti önler.

  // POST /api/v1/live-plan/from-opta — OPTA seçim akışı; matches.opta_uid'den
  // temel bilgi kopya. matchDate NULL → 400. Default duplicate (aktif) → 409.
  // Body sadece optaMatchId; sourceType/eventKey backend forced (anti-bypass).
  app.post('/from-opta', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.write),
    schema: { tags: ['LivePlan'], summary: 'Create live-plan from OPTA match (K-B3.5/K-B3.10)' },
  }, async (request, reply) => {
    const { optaMatchId } = createFromOptaSchema.parse(request.body);
    const created = await svc.createFromOpta(optaMatchId, request);
    reply.status(201);
    return created;
  });

  // POST /api/v1/live-plan/:id/duplicate — aynı eventKey kopya entry;
  // technical_details + segments + ingest + version + audit kopyalanmaz;
  // status reset PLANNED.
  app.post<{ Params: { id: string } }>('/:id/duplicate', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.write),
    schema: { tags: ['LivePlan'], summary: 'Duplicate live-plan entry (K-B3.4)' },
  }, async (request, reply) => {
    const id = idParamSchema.parse(request.params.id);
    const created = await svc.duplicate(id, request);
    reply.status(201);
    return created;
  });

  // 2026-05-13: Yayın Planlama seçimli Excel export.
  //   POST /api/v1/live-plan/export
  //   Body: { ids: number[1..500], title?: string<=120 }
  //   Auth: PERMISSIONS.livePlan.read (view yetkisi olan export edebilir).
  //   Response: xlsx binary + Content-Disposition attachment.
  app.post('/export', {
    preHandler: app.requireGroup(...PERMISSIONS.livePlan.read),
    schema: { tags: ['LivePlan'], summary: 'Selected live-plan entries → Excel' },
  }, async (request, reply) => {
    const body = livePlanExportRequestSchema.parse(request.body);
    const buf  = await exportLivePlanToBuffer(app, body);
    const filename = `yayin-planlama_${formatIstanbulDate(new Date())}.xlsx`;
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(buf);
  });
}
