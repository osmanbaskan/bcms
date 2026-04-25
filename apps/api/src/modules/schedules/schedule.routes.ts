import type { FastifyInstance } from 'fastify';
import { ScheduleService } from './schedule.service.js';
import {
  createScheduleSchema,
  updateScheduleSchema,
  scheduleQuerySchema,
  importQuerySchema,
  exportQuerySchema,
  livePlanQuerySchema,
  livePlanExportQuerySchema,
} from './schedule.schema.js';
import { importSchedulesFromBuffer } from './schedule.import.js';
import { exportSchedulesToStream }   from './schedule.export.js';
import { PERMISSIONS } from '@bcms/shared';

interface LivePlanFilterEntry {
  league: string;
  season: string | null;
  weeks: number[];
}

export async function scheduleRoutes(app: FastifyInstance) {
  const svc = new ScheduleService(app);

  // GET /api/v1/schedules
  app.get('/', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['Schedules'],
      summary: 'List schedules with optional filters',
      querystring: {
        type: 'object',
        properties: {
          channel:  { type: 'number' },
          from:     { type: 'string', format: 'date-time' },
          to:       { type: 'string', format: 'date-time' },
          status:   { type: 'string', enum: ['DRAFT','CONFIRMED','ON_AIR','COMPLETED','CANCELLED'] },
          usage:    { type: 'string', enum: ['broadcast', 'live-plan', 'all'], default: 'broadcast' },
          league:   { type: 'string' },
          season:   { type: 'string' },
          week:     { type: 'number' },
          page:     { type: 'number', default: 1 },
          pageSize: { type: 'number', default: 50 },
        },
      },
    },
  }, async (request) => {
    const query = scheduleQuerySchema.parse(request.query);
    return svc.findAll(query);
  });

  // POST /api/v1/schedules/import — Türkçe Excel formatından toplu import
  app.post('/import', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.write),
    schema: { tags: ['Schedules'], summary: 'Excel dosyasından program yükle (TARİH/SAAT/MAÇ/KANAL)' },
  }, async (request, reply) => {
    const data = await request.file();
    if (!data) throw Object.assign(new Error('Dosya bulunamadı'), { statusCode: 400 });

    const ext = data.filename.split('.').pop()?.toLowerCase();
    if (ext !== 'xlsx') {
      throw Object.assign(new Error('Sadece .xlsx dosyası kabul edilir'), { statusCode: 400 });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) chunks.push(chunk as Buffer);
    const buffer = Buffer.concat(chunks);

    const user   = (request.user as { preferred_username?: string })?.preferred_username ?? 'import';
    const q      = importQuerySchema.parse(request.query);
    const result = await importSchedulesFromBuffer(buffer, app, user, {
      defaultDurationMin: q.durationMin ?? 120,
    });

    reply.status(200).send(result);
  });

  // GET /api/v1/schedules/export — Programları Türkçe Excel formatında indir
  app.get('/export', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: { tags: ['Schedules'], summary: 'Programları Excel olarak dışa aktar' },
  }, async (request, reply) => {
    const q = exportQuerySchema.parse(request.query);
    const stream = await exportSchedulesToStream(app, {
      from:      q.from,
      to:        q.to,
      channelId: q.channelId,
      title:     q.title,
    });

    const filename = `plan_${new Date().toISOString().slice(0,10)}.xlsx`;
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(stream);
  });

  // GET /api/v1/schedules/ingest-candidates — Ingest ekranı için canlı yayın planı kayıtları
  app.get('/ingest-candidates', {
    preHandler: app.requireRole(...PERMISSIONS.ingest.read),
    schema: {
      tags: ['Schedules'],
      summary: 'Ingest için canlı yayın planı aday kayıtları',
      querystring: {
        type: 'object',
        properties: {
          channelId: { type: 'number' },
          from:      { type: 'string', format: 'date-time' },
          to:        { type: 'string', format: 'date-time' },
          page:      { type: 'number', default: 1 },
          pageSize:  { type: 'number', default: 200 },
        },
      },
    },
  }, async (request) => {
    const q = livePlanQuerySchema.parse(request.query);
    return svc.findAll({
      usage:    'live-plan',
      channel:  q.channelId,
      from:     q.from,
      to:       q.to,
      page:     q.page,
      pageSize: q.pageSize,
    });
  });

  // GET /api/v1/schedules/reports/live-plan — Expert raporlama önizleme verisi
  app.get('/reports/live-plan/filters', {
    preHandler: app.requireRole(...PERMISSIONS.reports.read),
    schema: {
      tags: ['Schedules'],
      summary: 'Canlı yayın plan raporu filtre seçenekleri',
    },
  }, async () => {
    const schedules = await app.prisma.schedule.findMany({
      where: {
        usageScope: 'live-plan',
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
    preHandler: app.requireRole(...PERMISSIONS.reports.read),
    schema: {
      tags: ['Schedules'],
      summary: 'Canlı yayın plan raporu verisi',
      querystring: {
        type: 'object',
        properties: {
          channelId: { type: 'number' },
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
    return svc.findAll({
      usage:    'live-plan',
      channel:  q.channelId,
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
    preHandler: app.requireRole(...PERMISSIONS.reports.export),
    schema: {
      tags: ['Schedules'],
      summary: 'Canlı yayın plan raporunu Excel olarak dışa aktar',
    },
  }, async (request, reply) => {
    const q = livePlanExportQuerySchema.parse(request.query);
    const stream = await exportSchedulesToStream(app, {
      usage:     'live-plan',
      from:      q.from,
      to:        q.to,
      channelId: q.channelId,
      league:    q.league,
      season:    q.season,
      week:      q.week,
      title:     q.title,
    });

    const filename = `canli-yayin-plan-raporu_${new Date().toISOString().slice(0,10)}.xlsx`;
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(stream);
  });

  // GET /api/v1/schedules/:id
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: { tags: ['Schedules'], summary: 'Get schedule by ID' },
  }, async (request) => {
    return svc.findById(Number(request.params.id));
  });

  // POST /api/v1/schedules
  app.post('/', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.write),
    schema: { tags: ['Schedules'], summary: 'Create schedule (conflict check included)' },
  }, async (request, reply) => {
    const dto = createScheduleSchema.parse(request.body);
    const schedule = await svc.create(dto, request);
    reply.status(201).send(schedule);
  });

  // PATCH /api/v1/schedules/:id
  app.patch<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.write),
    schema: { tags: ['Schedules'], summary: 'Update schedule (optimistic locking via If-Match)' },
  }, async (request) => {
    const dto = updateScheduleSchema.parse(request.body);
    const ifMatch = request.headers['if-match'];
    const version = ifMatch ? parseInt(ifMatch, 10) : undefined;
    return svc.update(Number(request.params.id), dto, version, request);
  });

  // DELETE /api/v1/schedules/:id
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.delete),
    schema: { tags: ['Schedules'], summary: 'Delete schedule' },
  }, async (request, reply) => {
    await svc.remove(Number(request.params.id), request);
    reply.status(204).send();
  });
}
