import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma, IncidentSeverity } from '@prisma/client';
import { PERMISSIONS } from '@bcms/shared';

const listIncidentsQuerySchema = z.object({
  scheduleId: z.coerce.number().int().positive().optional(),
  resolved:   z.enum(['true', 'false']).optional(),
  severity:   z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']).optional(),
});

const createIncidentSchema = z.object({
  scheduleId:  z.number().int().positive().optional(),
  eventType:   z.string().min(1).max(50),
  description: z.string().optional(),
  tcIn:        z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/).optional(),
  severity:    z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']).default('INFO'),
  metadata:    z.record(z.unknown()).optional(),
});

const timelineEventSchema = z.object({
  tc:   z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/),
  type: z.string().min(1).max(50),
  note: z.string().optional(),
});

export async function incidentRoutes(app: FastifyInstance) {
  // ── Incidents ──────────────────────────────────────────────────────────────
  app.get('/', {
    preHandler: app.requireRole(...PERMISSIONS.incidents.read),
    schema: { tags: ['Incidents'] },
  }, async (request) => {
    const q = listIncidentsQuerySchema.parse(request.query);
    return app.prisma.incident.findMany({
      where: {
        ...(q.scheduleId && { scheduleId: q.scheduleId }),
        ...(q.resolved !== undefined && { resolved: q.resolved === 'true' }),
        ...(q.severity  && { severity: q.severity as IncidentSeverity }),
      },
      include: { schedule: { select: { title: true, channelId: true } } },
      orderBy: { createdAt: 'desc' },
    });
  });

  app.post('/', {
    preHandler: app.requireRole(...PERMISSIONS.incidents.write),
    schema: { tags: ['Incidents'] },
  }, async (request, reply) => {
    const dto = createIncidentSchema.parse(request.body);
    const incident = await app.prisma.incident.create({ data: { ...dto, metadata: dto.metadata as Prisma.InputJsonValue } });
    reply.status(201).send(incident);
  });

  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireRole(...PERMISSIONS.incidents.delete),
    schema: { tags: ['Incidents'], summary: 'Delete incident' },
  }, async (request, reply) => {
    const id = Number(request.params.id);
    const existing = await app.prisma.incident.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error('Incident bulunamadı'), { statusCode: 404 });
    await app.prisma.incident.delete({ where: { id } });
    reply.status(204).send();
  });

  app.patch<{ Params: { id: string } }>('/:id/resolve', {
    preHandler: app.requireRole(...PERMISSIONS.incidents.write),
    schema: { tags: ['Incidents'], summary: 'Mark incident as resolved' },
  }, async (request) => {
    const user = (request.user as { preferred_username: string }).preferred_username;
    return app.prisma.incident.update({
      where: { id: Number(request.params.id) },
      data:  { resolved: true, resolvedBy: user, resolvedAt: new Date() },
    });
  });

  // ── Timeline Events ────────────────────────────────────────────────────────
  app.get<{ Params: { scheduleId: string } }>('/timeline/:scheduleId', {
    preHandler: app.requireRole(...PERMISSIONS.incidents.read),
    schema: { tags: ['Timeline'] },
  }, async (request) => {
    return app.prisma.timelineEvent.findMany({
      where: { scheduleId: Number(request.params.scheduleId) },
      orderBy: { tc: 'asc' },
    });
  });

  app.post<{ Params: { scheduleId: string } }>('/timeline/:scheduleId', {
    preHandler: app.requireRole(...PERMISSIONS.incidents.write),
    schema: { tags: ['Timeline'] },
  }, async (request, reply) => {
    const dto = timelineEventSchema.parse(request.body);
    const user = (request.user as { preferred_username: string }).preferred_username;
    const event = await app.prisma.timelineEvent.create({
      data: { ...dto, scheduleId: Number(request.params.scheduleId), createdBy: user },
    });
    reply.status(201).send(event);
  });
}
