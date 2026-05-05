import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { PERMISSIONS } from '@bcms/shared';

// DÜŞÜK-API-1.4.3 fix (2026-05-04): muxInfo size cap (8KB) + frequency
// karakter set kontrolü. Tip-spesifik (RADIO için MHz format, OTT için URL)
// schema'da zorlamak prematür; UI doğruluyor + DB log'da görünür kalıyor.
const channelMuxInfoSchema = z.record(z.unknown())
  .refine((m) => JSON.stringify(m).length <= 8 * 1024, 'muxInfo 8KB sınırını aşıyor');

const createChannelSchema = z.object({
  name:      z.string().min(1).max(100),
  type:      z.enum(['HD', 'SD', 'OTT', 'RADIO']),
  frequency: z.string().max(100).optional(),
  muxInfo:   channelMuxInfoSchema.optional(),
});

// LOW-API-019 fix (2026-05-05): explicit update schema; createChannelSchema
// .partial() cast'i türlü corner case'lerde (örn. ileride zorunlu yeni field
// eklenirse) update'ten kaçar.
const updateChannelSchema = createChannelSchema.partial().extend({
  active: z.boolean().optional(),   // PATCH'te kanalı pasifleştir
});

export async function channelRoutes(app: FastifyInstance) {
  app.get('/', {
    preHandler: app.requireGroup(...PERMISSIONS.channels.read),
    schema: { tags: ['Channels'], summary: 'List all active channels' },
  }, async () => {
    return app.prisma.channel.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
  });

  // Minimal projection for selection dropdowns (schedule create/edit, live plan).
  // Any authenticated user — no group gate, since channel listesi UI'da görünür
  // bir reference data ve PERMISSIONS.channels.read sadece Admin'i kapsıyor.
  app.get('/catalog', {
    preHandler: app.requireGroup(),
    schema: { tags: ['Channels'], summary: 'Channel catalog (minimal projection) for any authenticated user' },
  }, async () => {
    return app.prisma.channel.findMany({
      where: { active: true },
      select: { id: true, name: true, type: true, active: true },
      orderBy: { name: 'asc' },
    });
  });

  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.channels.read),
    schema: { tags: ['Channels'] },
  }, async (request) => {
    const channel = await app.prisma.channel.findUnique({ where: { id: z.coerce.number().int().positive().parse(request.params.id) } });
    if (!channel) throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
    return channel;
  });

  app.post('/', {
    preHandler: app.requireGroup(...PERMISSIONS.channels.write),
    schema: { tags: ['Channels'] },
  }, async (request, reply) => {
    const dto = createChannelSchema.parse(request.body);
    const channel = await app.prisma.channel.create({ data: { ...dto, muxInfo: dto.muxInfo as Prisma.InputJsonValue } });
    reply.status(201).send(channel);
  });

  app.patch<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.channels.write),
    schema: { tags: ['Channels'] },
  }, async (request) => {
    const dto = updateChannelSchema.parse(request.body);
    return app.prisma.channel.update({ where: { id: z.coerce.number().int().positive().parse(request.params.id) }, data: dto as Parameters<typeof app.prisma.channel.update>[0]['data'] });
  });

  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.channels.delete),
    schema: { tags: ['Channels'] },
  }, async (request, reply) => {
    // Soft delete
    await app.prisma.channel.update({
      where: { id: z.coerce.number().int().positive().parse(request.params.id) },
      data: { active: false },
    });
    reply.status(204).send();
  });
}
