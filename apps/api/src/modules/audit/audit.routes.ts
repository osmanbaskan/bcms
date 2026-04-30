import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';

const auditQuerySchema = z.object({
  entityType: z.string().trim().max(100).optional(),
  entityId:   z.coerce.number().int().positive().optional(),
  action:     z.enum(['CREATE', 'UPDATE', 'DELETE', 'UPSERT', 'CREATEMANY']).optional(),
  user:       z.string().trim().max(100).optional(),
  from:       z.string().datetime({ offset: true }).optional(),
  to:         z.string().datetime({ offset: true }).optional(),
  page:       z.coerce.number().int().min(1).default(1),
  pageSize:   z.coerce.number().int().min(1).max(500).default(100),
});

export async function auditRoutes(app: FastifyInstance) {
  app.get('/', {
    preHandler: app.requireGroup(...PERMISSIONS.auditLogs.read),
    schema: { tags: ['Audit'], summary: 'Query audit logs (admin only)' },
  }, async (request) => {
    const q = auditQuerySchema.parse(request.query);

    const skip = (q.page - 1) * q.pageSize;

    const where: Prisma.AuditLogWhereInput = {
      ...(q.entityType && { entityType: q.entityType }),
      ...(q.entityId   && { entityId:   q.entityId }),
      ...(q.action     && { action: q.action }),
      ...(q.user       && { user: { contains: q.user, mode: 'insensitive' } }),
      ...(q.from || q.to
        ? {
            timestamp: {
              ...(q.from && { gte: new Date(q.from) }),
              ...(q.to   && { lte: new Date(q.to) }),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      app.prisma.auditLog.findMany({ where, skip, take: q.pageSize, orderBy: { timestamp: 'desc' } }),
      app.prisma.auditLog.count({ where }),
    ]);

    return { data, total, page: q.page, pageSize: q.pageSize, totalPages: Math.ceil(total / q.pageSize) };
  });
}
