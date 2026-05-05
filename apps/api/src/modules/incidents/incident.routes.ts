import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma, IncidentSeverity } from '@prisma/client';
import { PERMISSIONS } from '@bcms/shared';

const listIncidentsQuerySchema = z.object({
  scheduleId: z.coerce.number().int().positive().optional(),
  resolved:   z.enum(['true', 'false']).optional(),
  severity:   z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']).optional(),
  // ÖNEMLİ-API-1.9.7 fix (2026-05-04): pagination — eski hâlinde tüm
  // incident'ları tek response'ta döndürüyordu; 10K+ kayıt response bombası.
  page:     z.coerce.number().int().min(1).max(10_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(500).optional().default(100),
});

const createIncidentMetadataSchema = z.record(z.unknown())
  // ORTA-API-1.9.8 fix (2026-05-04): metadata size cap — JSON serialize sonrası
  // 16KB üst sınır (DB jsonb için makul; UI'de zaten gösterilemiyor).
  .refine((m) => JSON.stringify(m).length <= 16_384, 'metadata 16KB sınırını aşıyor');

const createIncidentSchema = z.object({
  scheduleId:  z.number().int().positive().optional(),
  eventType:   z.string().min(1).max(50),
  description: z.string().max(4000).optional(),
  tcIn:        z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/).optional(),
  severity:    z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']).default('INFO'),
  metadata:    createIncidentMetadataSchema.optional(),
});

const timelineEventSchema = z.object({
  tc:   z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/),
  type: z.string().min(1).max(50),
  note: z.string().optional(),
});

export async function incidentRoutes(app: FastifyInstance) {
  // ── Incidents ──────────────────────────────────────────────────────────────
  app.get('/', {
    preHandler: app.requireGroup(...PERMISSIONS.incidents.read),
    schema: { tags: ['Incidents'] },
  }, async (request) => {
    const q = listIncidentsQuerySchema.parse(request.query);
    const where = {
      ...(q.scheduleId && { scheduleId: q.scheduleId }),
      ...(q.resolved !== undefined && { resolved: q.resolved === 'true' }),
      ...(q.severity  && { severity: q.severity as IncidentSeverity }),
    };

    const [items, total] = await app.prisma.$transaction([
      app.prisma.incident.findMany({
        where,
        include: { schedule: { select: { title: true, channelId: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      app.prisma.incident.count({ where }),
    ]);

    return {
      items,
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.ceil(total / q.pageSize),
    };
  });

  app.post('/', {
    preHandler: app.requireGroup(...PERMISSIONS.incidents.write),
    schema: { tags: ['Incidents'] },
  }, async (request, reply) => {
    const dto = createIncidentSchema.parse(request.body);
    const incident = await app.prisma.incident.create({ data: { ...dto, metadata: dto.metadata as Prisma.InputJsonValue } });
    reply.status(201).send(incident);
  });

  // POST /api/v1/incidents/report — Tüm authenticated kullanıcılar yayın sorunu bildirebilir
  app.post('/report', {
    preHandler: app.requireGroup(...PERMISSIONS.incidents.reportIssue),
    schema: {
      tags: ['Incidents'],
      summary: 'Yayın sorunu bildir (tüm kullanıcılar erişebilir)',
      body: {
        type: 'object',
        required: ['description'],
        properties: {
          scheduleId:  { type: 'number' },
          title:       { type: 'string' },
          startTime:   { type: 'string' },
          endTime:     { type: 'string' },
          channel:     { type: 'string' },
          description: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const body = z.object({
      scheduleId:  z.number().int().positive().optional(),
      title:       z.string().optional(),
      startTime:   z.string().optional(),
      endTime:     z.string().optional(),
      channel:     z.string().optional(),
      description: z.string().min(1).max(2000),
    }).parse(request.body);

    const user = (request.user as { preferred_username?: string })?.preferred_username ?? 'unknown';

    const incident = await app.prisma.incident.create({
      data: {
        scheduleId:  body.scheduleId,
        eventType:   'SCHEDULE_ISSUE',
        description: body.description,
        severity:    'ERROR',
        metadata: {
          title:      body.title ?? '',
          startTime:  body.startTime ?? '',
          endTime:    body.endTime ?? '',
          channel:    body.channel ?? '',
          reportedBy: user,
        } as Prisma.InputJsonValue,
      },
    });

    reply.status(201).send(incident);
  });

  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.incidents.delete),
    schema: { tags: ['Incidents'], summary: 'Delete incident' },
  }, async (request, reply) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const existing = await app.prisma.incident.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error('Incident bulunamadı'), { statusCode: 404 });
    await app.prisma.incident.delete({ where: { id } });
    reply.status(204).send();
  });

  app.patch<{ Params: { id: string } }>('/:id/resolve', {
    preHandler: app.requireGroup(...PERMISSIONS.incidents.write),
    schema: { tags: ['Incidents'], summary: 'Mark incident as resolved' },
  }, async (request) => {
    const user = (request.user as { preferred_username: string }).preferred_username;
    return app.prisma.incident.update({
      where: { id: z.coerce.number().int().positive().parse(request.params.id) },
      data:  { resolved: true, resolvedBy: user, resolvedAt: new Date() },
    });
  });

  // ── Timeline Events ────────────────────────────────────────────────────────
  app.get<{ Params: { scheduleId: string } }>('/timeline/:scheduleId', {
    preHandler: app.requireGroup(...PERMISSIONS.incidents.read),
    schema: { tags: ['Timeline'] },
  }, async (request) => {
    return app.prisma.timelineEvent.findMany({
      where: { scheduleId: z.coerce.number().int().positive().parse(request.params.scheduleId) },
      orderBy: { tc: 'asc' },
    });
  });

  app.post<{ Params: { scheduleId: string } }>('/timeline/:scheduleId', {
    preHandler: app.requireGroup(...PERMISSIONS.incidents.write),
    schema: { tags: ['Timeline'] },
  }, async (request, reply) => {
    const dto = timelineEventSchema.parse(request.body);
    const scheduleId = z.coerce.number().int().positive().parse(request.params.scheduleId);
    // ORTA-API-1.9.9 fix (2026-05-04): schedule existence check — random
    // scheduleId ile timeline event oluşturulamasın; FK P2003 yerine açık 404.
    const exists = await app.prisma.schedule.findUnique({ where: { id: scheduleId }, select: { id: true } });
    if (!exists) throw Object.assign(new Error('Schedule bulunamadı'), { statusCode: 404 });

    const user = (request.user as { preferred_username: string }).preferred_username;
    const event = await app.prisma.timelineEvent.create({
      data: { ...dto, scheduleId, createdBy: user },
    });
    reply.status(201).send(event);
  });
}
