import type { FastifyInstance } from 'fastify';
import { PERMISSIONS } from '@bcms/shared';

export async function auditRoutes(app: FastifyInstance) {
  app.get('/', {
    preHandler: app.requireRole(...PERMISSIONS.auditLogs.read),
    schema: { tags: ['Audit'], summary: 'Query audit logs (admin only)' },
  }, async (request) => {
    const q = request.query as {
      entityType?: string;
      entityId?: string;
      user?: string;
      from?: string;
      to?: string;
      page?: string;
      pageSize?: string;
    };

    const page     = q.page     ? Number(q.page)     : 1;
    const pageSize = q.pageSize ? Number(q.pageSize) : 100;
    const skip     = (page - 1) * pageSize;

    const where = {
      ...(q.entityType && { entityType: q.entityType }),
      ...(q.entityId   && { entityId:   Number(q.entityId) }),
      ...(q.user       && { user: { contains: q.user } }),
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
      app.prisma.auditLog.findMany({ where, skip, take: pageSize, orderBy: { timestamp: 'desc' } }),
      app.prisma.auditLog.count({ where }),
    ]);

    return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  });
}
