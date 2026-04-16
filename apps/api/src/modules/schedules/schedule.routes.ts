import type { FastifyInstance } from 'fastify';
import { ScheduleService } from './schedule.service.js';
import {
  createScheduleSchema,
  updateScheduleSchema,
  scheduleQuerySchema,
} from './schedule.schema.js';
import { importSchedulesFromBuffer } from './schedule.import.js';
import { exportSchedulesToBuffer }   from './schedule.export.js';
import { PERMISSIONS } from '@bcms/shared';

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
          page:     { type: 'number', default: 1 },
          pageSize: { type: 'number', default: 50 },
        },
      },
    },
  }, async (request) => {
    const query = scheduleQuerySchema.parse(request.query);
    return svc.findAll(query);
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

  // POST /api/v1/schedules/import — Türkçe Excel formatından toplu import
  app.post('/import', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.write),
    schema: { tags: ['Schedules'], summary: 'Excel dosyasından program yükle (TARİH/SAAT/MAÇ/KANAL)' },
  }, async (request, reply) => {
    const data = await request.file();
    if (!data) throw Object.assign(new Error('Dosya bulunamadı'), { statusCode: 400 });

    const ext = data.filename.split('.').pop()?.toLowerCase();
    if (!['xlsx', 'xls'].includes(ext ?? '')) {
      throw Object.assign(new Error('Sadece .xlsx veya .xls dosyası kabul edilir'), { statusCode: 400 });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) chunks.push(chunk as Buffer);
    const buffer = Buffer.concat(chunks);

    const user   = (request.user as { preferred_username?: string })?.preferred_username ?? 'import';
    const q      = request.query as { durationMin?: string };
    const result = await importSchedulesFromBuffer(buffer, app, user, {
      defaultDurationMin: q.durationMin ? Number(q.durationMin) : 120,
    });

    reply.status(200).send(result);
  });

  // GET /api/v1/schedules/export — Programları Türkçe Excel formatında indir
  app.get('/export', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: { tags: ['Schedules'], summary: 'Programları Excel olarak dışa aktar' },
  }, async (request, reply) => {
    const q = request.query as {
      from?: string; to?: string; channelId?: string; title?: string;
    };
    const buffer = await exportSchedulesToBuffer(app, {
      from:      q.from,
      to:        q.to,
      channelId: q.channelId ? Number(q.channelId) : undefined,
      title:     q.title,
    });

    const filename = `plan_${new Date().toISOString().slice(0,10)}.xlsx`;
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(buffer);
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
