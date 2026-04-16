import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';

const createChannelSchema = z.object({
  name:      z.string().min(1).max(100),
  type:      z.enum(['HD', 'SD', 'OTT', 'RADIO']),
  frequency: z.string().optional(),
  muxInfo:   z.record(z.unknown()).optional(),
});

export async function channelRoutes(app: FastifyInstance) {
  app.get('/', {
    preHandler: app.requireRole(...PERMISSIONS.channels.read),
    schema: { tags: ['Channels'], summary: 'List all active channels' },
  }, async () => {
    return app.prisma.channel.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
  });

  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireRole(...PERMISSIONS.channels.read),
    schema: { tags: ['Channels'] },
  }, async (request) => {
    const channel = await app.prisma.channel.findUnique({ where: { id: Number(request.params.id) } });
    if (!channel) throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
    return channel;
  });

  app.post('/', {
    preHandler: app.requireRole(...PERMISSIONS.channels.write),
    schema: { tags: ['Channels'] },
  }, async (request, reply) => {
    const dto = createChannelSchema.parse(request.body);
    const channel = await app.prisma.channel.create({ data: dto });
    reply.status(201).send(channel);
  });

  app.patch<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireRole(...PERMISSIONS.channels.write),
    schema: { tags: ['Channels'] },
  }, async (request) => {
    const dto = createChannelSchema.partial().parse(request.body);
    return app.prisma.channel.update({ where: { id: Number(request.params.id) }, data: dto });
  });

  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireRole(...PERMISSIONS.channels.delete),
    schema: { tags: ['Channels'] },
  }, async (request, reply) => {
    // Soft delete
    await app.prisma.channel.update({
      where: { id: Number(request.params.id) },
      data: { active: false },
    });
    reply.status(204).send();
  });
}
