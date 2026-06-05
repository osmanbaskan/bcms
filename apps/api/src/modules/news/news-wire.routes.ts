import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, type NewsStory } from '@bcms/shared';
import {
  NOT_DELETED,
  STORY_DETAIL_INCLUDE,
  currentUser,
  httpError,
  serializeStory,
  serializeWire,
} from './news.service.js';
import { configuredRssSources } from './news-wire-fetcher.service.js';

const prioritySchema = z.enum(['FLASH', 'NORMAL']);

const createWireSchema = z.object({
  source: z.string().min(1).max(40),
  category: z.string().max(120).nullish(),
  priority: prioritySchema.optional(),
  headline: z.string().min(1).max(500),
  body: z.string().max(50_000).nullish(),
});

const toStorySchema = z.object({
  newsGroup: z.string().max(80).nullish(),
});

const listQuerySchema = z.object({
  source: z.string().max(40).optional(),
  priority: prioritySchema.optional(),
  used: z.coerce.boolean().optional(),  // true → story'ye çevrilmiş, false → bekleyen
});

/**
 * Ajans (wire) route'ları — /api/v1/news. EGS "Ajans Penceresi / Tüm Ajanslar".
 *  - GET  /wires           : gelen ajans haberleri (kaynak/öncelik filtre)
 *  - POST /wires           : manuel ajans girişi (write)
 *  - POST /wires/:id/to-story : "Story'ye Çevir" → havuz haberi (write)
 *  - GET  /wires/sources   : konfigüre RSS kaynakları (admin)
 */
export async function wireRoutes(app: FastifyInstance) {
  app.get('/wires', {
    preHandler: app.requireGroup(...PERMISSIONS.news.read),
    schema: { tags: ['News'], summary: 'Ajans haberlerini listele' },
  }, async (request) => {
    const q = listQuerySchema.parse(request.query);
    const wires = await app.prisma.newsWireItem.findMany({
      where: {
        ...(q.source ? { source: q.source } : {}),
        ...(q.priority ? { priority: q.priority } : {}),
        ...(q.used === true ? { usedStoryId: { not: null } } : {}),
        ...(q.used === false ? { usedStoryId: null } : {}),
      },
      orderBy: [{ priority: 'asc' }, { receivedAt: 'desc' }], // FLASH önce
      take: 200,
    });
    return wires.map(serializeWire);
  });

  app.post('/wires', {
    preHandler: app.requireGroup(...PERMISSIONS.news.write),
    schema: { tags: ['News'], summary: 'Manuel ajans haberi ekle' },
  }, async (request, reply) => {
    const dto = createWireSchema.parse(request.body);
    const created = await app.prisma.newsWireItem.create({
      data: {
        source: dto.source,
        externalId: null,
        category: dto.category ?? null,
        priority: dto.priority ?? 'NORMAL',
        headline: dto.headline,
        body: dto.body ?? null,
      },
    });
    reply.status(201);
    return serializeWire(created);
  });

  app.post<{ Params: { id: string } }>('/wires/:id/to-story', {
    preHandler: app.requireGroup(...PERMISSIONS.news.write),
    schema: { tags: ['News'], summary: 'Ajans haberini havuz haberine çevir' },
  }, async (request, reply): Promise<NewsStory> => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const dto = toStorySchema.parse(request.body ?? {});
    const user = currentUser(request);

    const wire = await app.prisma.newsWireItem.findUnique({ where: { id } });
    if (!wire) throw httpError(404, 'Ajans haberi bulunamadı');
    if (wire.usedStoryId) throw httpError(409, 'Bu ajans haberi zaten story\'ye çevrilmiş');

    const story = await app.prisma.$transaction(async (tx) => {
      const created = await tx.newsStory.create({
        data: {
          bulletinId: null, // Haber Havuzu
          title: wire.headline.slice(0, 300),
          storyType: 'READER',
          description: wire.body ?? null,
          prompterText: wire.body ?? null,
          newsGroup: dto.newsGroup ?? null,
          createdBy: user,
          updatedBy: user,
        },
        include: STORY_DETAIL_INCLUDE,
      });
      await tx.newsWireItem.update({ where: { id }, data: { usedStoryId: created.id } });
      return created;
    });
    reply.status(201);
    return serializeStory(story);
  });

  app.get('/wires/sources', {
    preHandler: app.requireGroup(...PERMISSIONS.news.admin),
    schema: { tags: ['News'], summary: 'Konfigüre ajans (RSS) kaynakları' },
  }, async () => {
    return { rss: configuredRssSources() };
  });
}
