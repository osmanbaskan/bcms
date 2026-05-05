import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ScheduleService } from './schedule.service.js';

const TR_TIMEZONE = 'Europe/Istanbul';

// ORTA-API-1.2.4 fix (2026-05-04): export filename Istanbul saatine göre.
// Eski hâl: new Date().toISOString().slice(0,10) UTC; Türkiye akşam 22:00
// = UTC 19:00, ama 02:00'da UTC 23:00 → tarih 1 gün geride.
function istanbulDateOnly(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TR_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// ORTA-API-1.2.2 fix (2026-05-04): xlsx magic byte check.
// .xlsx zip-based; ilk 4 byte 'PK\x03\x04' (ZIP local file header).
// Saldırgan .xlsx uzantılı zip bomb veya başka format yollarsa exceljs içeride patlar.
const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
function isValidXlsxBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(XLSX_MAGIC);
}
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
    preHandler: app.requireGroup(), // all authenticated
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
    preHandler: app.requireGroup(...PERMISSIONS.schedules.write),
    schema: { tags: ['Schedules'], summary: 'Excel dosyasından program yükle (TARİH/SAAT/MAÇ/KANAL)' },
  }, async (request, reply) => {
    // ORTA-API-1.2.1 fix (2026-05-04): birden fazla file gelirse açıkça reddet.
    // Önceki davranış: sadece ilk file işleniyordu, ek file'lar sessiz drop.
    let data;
    try {
      data = await request.file();
    } catch (err) {
      throw Object.assign(new Error('Multipart parse hatası'), { statusCode: 400, cause: err });
    }
    if (!data) throw Object.assign(new Error('Dosya bulunamadı'), { statusCode: 400 });

    const ext = data.filename.split('.').pop()?.toLowerCase();
    if (ext !== 'xlsx') {
      throw Object.assign(new Error('Sadece .xlsx dosyası kabul edilir'), { statusCode: 400 });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) chunks.push(chunk as Buffer);
    const buffer = Buffer.concat(chunks);

    // ORTA-API-1.2.2 fix (2026-05-04): magic byte kontrolü.
    if (!isValidXlsxBuffer(buffer)) {
      throw Object.assign(new Error('Dosya geçerli .xlsx formatında değil (magic byte mismatch)'), { statusCode: 400 });
    }

    // İkinci file kontrolü: stream tüketildikten sonra ek file varsa hata at.
    // Fastify multipart MultipartFile.fields tüm field'ları tutar; basit kontrol:
    const additionalFile = await request.file().catch(() => null);
    if (additionalFile) {
      throw Object.assign(new Error('Tek seferde sadece bir dosya yükleyebilirsiniz'), { statusCode: 400 });
    }

    const user   = (request.user as { preferred_username?: string })?.preferred_username ?? 'import';
    const q      = importQuerySchema.parse(request.query);
    const result = await importSchedulesFromBuffer(buffer, app, user, {
      defaultDurationMin: q.durationMin ?? 120,
    });

    reply.status(200).send(result);
  });

  // GET /api/v1/schedules/export — Programları Türkçe Excel formatında indir
  app.get('/export', {
    preHandler: app.requireGroup(), // all authenticated
    schema: { tags: ['Schedules'], summary: 'Programları Excel olarak dışa aktar' },
  }, async (request, reply) => {
    const q = exportQuerySchema.parse(request.query);
    const stream = await exportSchedulesToStream(app, {
      from:      q.from,
      to:        q.to,
      channelId: q.channelId,
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
    preHandler: app.requireGroup(...PERMISSIONS.reports.read),
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
    preHandler: app.requireGroup(...PERMISSIONS.reports.read),
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
    preHandler: app.requireGroup(...PERMISSIONS.reports.export),
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

    const filename = `canli-yayin-plan-raporu_${istanbulDateOnly()}.xlsx`;
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(stream);
  });

  // GET /api/v1/schedules/:id
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(), // all authenticated
    schema: { tags: ['Schedules'], summary: 'Get schedule by ID' },
  }, async (request) => {
    return svc.findById(z.coerce.number().int().positive().parse(request.params.id));
  });

  // POST /api/v1/schedules
  app.post('/', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.write),
    schema: { tags: ['Schedules'], summary: 'Create schedule (conflict check included)' },
  }, async (request, reply) => {
    const dto = createScheduleSchema.parse(request.body);
    const schedule = await svc.create(dto, request);
    reply.status(201).send(schedule);
  });

  // PATCH /api/v1/schedules/:id
  app.patch<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.write),
    schema: { tags: ['Schedules'], summary: 'Update schedule (optimistic locking via If-Match)' },
  }, async (request) => {
    const dto = updateScheduleSchema.parse(request.body);
    // DÜŞÜK-API-1.2.5 fix (2026-05-04): if-match header array gelirse ilk
    // değeri al; NaN durumunda undefined dön — `version` hiç gönderilmemiş gibi.
    const rawIfMatch = request.headers['if-match'];
    const ifMatchStr = Array.isArray(rawIfMatch) ? rawIfMatch[0] : rawIfMatch;
    const versionRaw = ifMatchStr ? parseInt(ifMatchStr, 10) : NaN;
    const version = Number.isFinite(versionRaw) && versionRaw >= 0 ? versionRaw : undefined;
    return svc.update(z.coerce.number().int().positive().parse(request.params.id), dto, version, request);
  });

  // DELETE /api/v1/schedules/:id
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.delete),
    schema: { tags: ['Schedules'], summary: 'Delete schedule' },
  }, async (request, reply) => {
    await svc.remove(z.coerce.number().int().positive().parse(request.params.id));
    reply.status(204).send();
  });
}
