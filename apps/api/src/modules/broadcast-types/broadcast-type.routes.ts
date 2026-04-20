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
    preHandler: app.requireRole(...PERMISSIONS.channels.read),
    schema: { tags: ['BroadcastTypes'], summary: 'Tüm yayın tiplerini listele' },
  }, async () => {
    return app.prisma.broadcastType.findMany({ orderBy: { code: 'asc' } });
  });

  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireRole(...PERMISSIONS.channels.read),
    schema: { tags: ['BroadcastTypes'], summary: 'Yayın tipi detayı' },
  }, async (request) => {
    const bt = await app.prisma.broadcastType.findUnique({ where: { id: Number(request.params.id) } });
    if (!bt) throw Object.assign(new Error('BroadcastType bulunamadı'), { statusCode: 404 });
    return bt;
  });

  app.post('/', {
    preHandler: app.requireRole(...PERMISSIONS.channels.write),
    schema: { tags: ['BroadcastTypes'], summary: 'Yeni yayın tipi oluştur' },
  }, async (request, reply) => {
    const dto = createSchema.parse(request.body);
    const existing = await app.prisma.broadcastType.findUnique({ where: { code: dto.code } });
    if (existing) throw Object.assign(new Error(`'${dto.code}' kodu zaten kullanılıyor`), { statusCode: 409 });
    const bt = await app.prisma.broadcastType.create({ data: dto });
    reply.status(201).send(bt);
  });

  app.patch<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireRole(...PERMISSIONS.channels.write),
    schema: { tags: ['BroadcastTypes'], summary: 'Yayın tipini güncelle' },
  }, async (request) => {
    const id  = Number(request.params.id);
    const dto = updateSchema.parse(request.body);

    const existing = await app.prisma.broadcastType.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error('BroadcastType bulunamadı'), { statusCode: 404 });

    if (dto.code && dto.code !== existing.code) {
      const conflict = await app.prisma.broadcastType.findUnique({ where: { code: dto.code } });
      if (conflict) throw Object.assign(new Error(`'${dto.code}' kodu zaten kullanılıyor`), { statusCode: 409 });
    }

    return app.prisma.broadcastType.update({ where: { id }, data: dto });
  });

  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireRole(...PERMISSIONS.channels.delete),
    schema: { tags: ['BroadcastTypes'], summary: 'Yayın tipini sil' },
  }, async (request, reply) => {
    const id = Number(request.params.id);
    const existing = await app.prisma.broadcastType.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error('BroadcastType bulunamadı'), { statusCode: 404 });
    await app.prisma.broadcastType.delete({ where: { id } });
    reply.status(204).send();
  });
}
