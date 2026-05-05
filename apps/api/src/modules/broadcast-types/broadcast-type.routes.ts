import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';

const createSchema = z.object({
  code:        z.string().min(1).max(30),
  description: z.string().min(1).max(200),
});

const updateSchema = z.object({
  code:        z.string().min(1).max(30).optional(),
  description: z.string().min(1).max(200).optional(),
});

export async function broadcastTypeRoutes(app: FastifyInstance) {
  app.get('/', {
    preHandler: app.requireGroup(...PERMISSIONS.broadcastTypes.read),
    schema: { tags: ['BroadcastTypes'], summary: 'Tüm yayın tiplerini listele' },
  }, async () => {
    return app.prisma.broadcastType.findMany({ orderBy: { code: 'asc' } });
  });

  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.broadcastTypes.read),
    schema: { tags: ['BroadcastTypes'], summary: 'Yayın tipi detayı' },
  }, async (request) => {
    const bt = await app.prisma.broadcastType.findUnique({ where: { id: z.coerce.number().int().positive().parse(request.params.id) } });
    if (!bt) throw Object.assign(new Error('BroadcastType bulunamadı'), { statusCode: 404 });
    return bt;
  });

  app.post('/', {
    preHandler: app.requireGroup(...PERMISSIONS.broadcastTypes.write),
    schema: { tags: ['BroadcastTypes'], summary: 'Yeni yayın tipi oluştur' },
  }, async (request, reply) => {
    const dto = createSchema.parse(request.body);
    const bt = await app.prisma.broadcastType.create({ data: dto });
    reply.status(201).send(bt);
  });

  app.patch<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.broadcastTypes.write),
    schema: { tags: ['BroadcastTypes'], summary: 'Yayın tipini güncelle' },
  }, async (request) => {
    const id  = z.coerce.number().int().positive().parse(request.params.id);
    const dto = updateSchema.parse(request.body);

    // DÜŞÜK-API-1.4.8 fix (2026-05-04): findUnique pre-check kaldırıldı.
    // Prisma update non-existent ID için P2025 atıyor, global error handler
    // 404'e map ediyor — extra round-trip gereksiz.
    return app.prisma.broadcastType.update({ where: { id }, data: dto });
  });

  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.broadcastTypes.delete),
    schema: { tags: ['BroadcastTypes'], summary: 'Yayın tipini sil' },
  }, async (request, reply) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    // DÜŞÜK-API-1.4.8 fix: aynı pattern delete için.
    await app.prisma.broadcastType.delete({ where: { id } });
    reply.status(204).send();
  });
}
