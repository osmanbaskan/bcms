import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ScheduleService } from './schedule.service.js';
import { istanbulTodayDate } from '../../core/tz.js';

// ORTA-API-1.2.4 fix (2026-05-04): export filename Istanbul saatine göre.
// Eski hâl: new Date().toISOString().slice(0,10) UTC; Türkiye akşam 22:00
// = UTC 19:00, ama 02:00'da UTC 23:00 → tarih 1 gün geride.
const istanbulDateOnly = istanbulTodayDate;

import {
  exportQuerySchema,
  livePlanQuerySchema,
  livePlanExportQuerySchema,
  createBroadcastScheduleSchema,
  updateBroadcastScheduleSchema,
  broadcastScheduleListQuerySchema,
} from './schedule.schema.js';
import { exportSchedulesToStream } from './schedule.export.js';
import { PERMISSIONS } from '@bcms/shared';

interface LivePlanFilterEntry {
  league: string;
  season: string | null;
  weeks: number[];
}

export async function scheduleRoutes(app: FastifyInstance) {
  const svc = new ScheduleService(app);

  // SCHED-B5a (Y5-2a + Y5-4): legacy GET / (list) + POST / + PATCH /:id +
  // DELETE /:id + POST /import endpoint'leri silindi. Yeni canonical broadcast
  // flow: /broadcast (POST/PATCH/DELETE/GET) + /broadcast/:id. Reporting
  // `/reports/live-plan*` korunur (canonical filter). GET /:id korunur
  // (yayin-planlama detail bağımlı).

  // GET /api/v1/schedules/export — Programları Türkçe Excel formatında indir
  app.get('/export', {
    preHandler: app.requireGroup(), // all authenticated
    schema: { tags: ['Schedules'], summary: 'Programları Excel olarak dışa aktar' },
  }, async (request, reply) => {
    const q = exportQuerySchema.parse(request.query);
    const stream = await exportSchedulesToStream(app, {
      from:      q.from,
      to:        q.to,
      title:     q.title,
    });

    const filename = `plan_${istanbulDateOnly()}.xlsx`;
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(stream);
  });

  // GET /api/v1/schedules/ingest-candidates — Ingest ekranı için canlı yayın planı kayıtları
  app.get('/ingest-candidates', {
    preHandler: app.requireGroup(...PERMISSIONS.ingest.read),
    schema: {
      tags: ['Schedules'],
      summary: 'Ingest için canlı yayın planı aday kayıtları',
      querystring: {
        type: 'object',
        properties: {
          from:      { type: 'string', format: 'date-time' },
          to:        { type: 'string', format: 'date-time' },
          page:      { type: 'number', default: 1 },
          pageSize:  { type: 'number', default: 200 },
        },
      },
    },
  }, async (request) => {
    const q = livePlanQuerySchema.parse(request.query);
    // SCHED-B5a (Y5-4): canonical filter — `usageScope='live-plan'` yerine
    // `eventKey IS NOT NULL` (broadcast flow row guarantee).
    return svc.findAll({
      from:     q.from,
      to:       q.to,
      page:     q.page,
      pageSize: q.pageSize,
    });
  });

  // GET /api/v1/schedules/reports/live-plan — Expert raporlama önizleme verisi
  app.get('/reports/live-plan/filters', {
    preHandler: app.requireGroup(...PERMISSIONS.reports.read),
    schema: {
      tags: ['Schedules'],
      summary: 'Canlı yayın plan raporu filtre seçenekleri',
    },
  }, async () => {
    // SCHED-B5a (Y5-4 + §6.1): canonical filter — `usageScope='live-plan'`
    // yerine `eventKey IS NOT NULL`. `metadata`/`start_time`/`end_time`
    // dokunulmaz (B5b).
    const schedules = await app.prisma.schedule.findMany({
      where: {
        eventKey: { not: null },
        reportLeague: { not: null },
      },
      select: {
        reportLeague: true,
        reportSeason: true,
        reportWeekNumber: true,
      },
      orderBy: [
        { reportLeague: 'asc' },
        { reportSeason: 'desc' },
        { reportWeekNumber: 'asc' },
      ],
    });

    const entries = new Map<string, { league: string; season: string | null; weeks: Set<number> }>();
    for (const schedule of schedules) {
      const league = String(schedule.reportLeague ?? '').trim();
      if (!league) continue;

      const rawSeason = String(schedule.reportSeason ?? '').trim();
      const season = rawSeason || null;
      const key = `${league}\u0000${season ?? ''}`;
      if (!entries.has(key)) entries.set(key, { league, season, weeks: new Set<number>() });

      const week = Number(schedule.reportWeekNumber);
      if (Number.isInteger(week) && week > 0) entries.get(key)!.weeks.add(week);
    }

    return [...entries.values()]
      .map<LivePlanFilterEntry>((entry) => ({
        league: entry.league,
        season: entry.season,
        weeks: [...entry.weeks].sort((a, b) => a - b),
      }))
      .sort((a, b) => (
        a.league.localeCompare(b.league, 'tr')
        || String(b.season ?? '').localeCompare(String(a.season ?? ''), 'tr')
      ));
  });

  // GET /api/v1/schedules/reports/live-plan — Expert raporlama önizleme verisi
  app.get('/reports/live-plan', {
    preHandler: app.requireGroup(...PERMISSIONS.reports.read),
    schema: {
      tags: ['Schedules'],
      summary: 'Canlı yayın plan raporu verisi',
      querystring: {
        type: 'object',
        properties: {
          from:      { type: 'string', format: 'date-time' },
          to:        { type: 'string', format: 'date-time' },
          league:    { type: 'string' },
          season:    { type: 'string' },
          week:      { type: 'number' },
          page:      { type: 'number', default: 1 },
          pageSize:  { type: 'number', default: 500 },
        },
      },
    },
  }, async (request) => {
    const q = livePlanQuerySchema.parse(request.query);
    // SCHED-B5a (Y5-4 + §6.1): canonical filter; usage_scope kullanımı kaldırıldı.
    return svc.findAll({
      from:     q.from,
      to:       q.to,
      league:   q.league,
      season:   q.season,
      week:     q.week,
      page:     q.page,
      pageSize: q.pageSize,
    });
  });

  // GET /api/v1/schedules/reports/live-plan/export — Expert Excel export
  app.get('/reports/live-plan/export', {
    preHandler: app.requireGroup(...PERMISSIONS.reports.export),
    schema: {
      tags: ['Schedules'],
      summary: 'Canlı yayın plan raporunu Excel olarak dışa aktar',
    },
  }, async (request, reply) => {
    const q = livePlanExportQuerySchema.parse(request.query);
    // SCHED-B5a: usage param kaldırıldı; export.ts canonical filter kullanır.
    const stream = await exportSchedulesToStream(app, {
      from:      q.from,
      to:        q.to,
      league:    q.league,
      season:    q.season,
      week:      q.week,
      title:     q.title,
    });

    const filename = `canli-yayin-plan-raporu_${istanbulDateOnly()}.xlsx`;
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(stream);
  });

  // GET /api/v1/schedules/:id — yayin-planlama detail (B4) + reporting bağımlı.
  // SCHED-B5a (Y5-4): korunur; canonical refactor B5b'de (broadcast/:id paritesi).
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(), // all authenticated
    schema: { tags: ['Schedules'], summary: 'Get schedule by ID' },
  }, async (request) => {
    return svc.findById(z.coerce.number().int().positive().parse(request.params.id));
  });

  // SCHED-B5a (Y5-4): legacy POST / + PATCH /:id + DELETE /:id silindi.
  // Yeni canonical: POST/PATCH/DELETE /broadcast/:id (B3a).

  // ── SCHED-B3a Broadcast Flow canonical routes ──────────────────────────
  // Yeni Schedule UI (SCHED-B4) bu endpoint'leri çağırır. Eski POST/PATCH/
  // DELETE /api/v1/schedules legacy path olarak SCHED-B5'e kadar paralel
  // çalışır.

  // GET /api/v1/schedules/broadcast — Yayın Planlama list (SCHED-B4-prep).
  // Server-side filter: eventKey/selectedLivePlanEntryId/scheduleDate/scheduleTime
  // not null + query (eventKey, from, to, status). Pagination.
  app.get('/broadcast', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.read),
    schema: { tags: ['Schedules'], summary: 'List broadcast flow schedules (B4 canonical)' },
  }, async (request) => {
    const query = broadcastScheduleListQuerySchema.parse(request.query);
    return svc.findBroadcastList(query);
  });

  // POST /api/v1/schedules/broadcast — yeni canonical create (event_key,
  // selected_lpe, schedule_date/time, channel_1/2/3, 3 lookup option).
  // Channel propagation tx-içi.
  app.post('/broadcast', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.write),
    schema: { tags: ['Schedules'], summary: 'Create broadcast flow schedule (K-B3 canonical)' },
  }, async (request, reply) => {
    const dto = createBroadcastScheduleSchema.parse(request.body);
    const created = await svc.createBroadcastFlow(dto, request);
    reply.status(201);
    return created;
  });

  // PATCH /api/v1/schedules/broadcast/:id — canonical update + channel
  // propagation + temel bilgi senkron (K-B3.11, K-B3.19). If-Match opsiyonel.
  app.patch<{ Params: { id: string } }>('/broadcast/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.write),
    schema: { tags: ['Schedules'], summary: 'Update broadcast flow schedule (K-B3 canonical)' },
  }, async (request) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const dto = updateBroadcastScheduleSchema.parse(request.body);
    const rawIfMatch = request.headers['if-match'];
    const ifMatchStr = Array.isArray(rawIfMatch) ? rawIfMatch[0] : rawIfMatch;
    const versionRaw = ifMatchStr ? parseInt(ifMatchStr, 10) : NaN;
    const version = Number.isFinite(versionRaw) && versionRaw >= 0 ? versionRaw : undefined;
    return svc.updateBroadcastFlow(id, dto, version, request);
  });

  // DELETE /api/v1/schedules/broadcast/:id — schedule sil + aynı event_key'li
  // live_plan_entries channel slot NULL (K-B3.16). Live-plan satırları
  // silinmez (K-B3.15).
  app.delete<{ Params: { id: string } }>('/broadcast/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.delete),
    schema: { tags: ['Schedules'], summary: 'Delete broadcast flow schedule (K-B3 canonical)' },
  }, async (request, reply) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    await svc.removeBroadcastFlow(id);
    reply.status(204);
    return null;
  });
}
