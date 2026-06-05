import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';
import {
  NOT_DELETED,
  STORY_DETAIL_INCLUDE,
  currentUser,
  httpError,
  isAdmin,
  parseDateOnly,
  readIfMatch,
  serializeStory,
} from './news.service.js';

const storyTypeSchema = z.enum(['PKG', 'VO', 'VOSOT', 'READER', 'LIVE', 'PHONE', 'CRAWL', 'ROLL']);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createStorySchema = z.object({
  bulletinId: z.number().int().positive().nullish(),
  title: z.string().min(1).max(300),
  displayName: z.string().max(300).nullish(),
  storyType: storyTypeSchema.optional(),
  clipDurationSec: z.number().int().min(0).max(86_400).optional(),
  anchorName: z.string().max(200).nullish(),
  description: z.string().max(20_000).nullish(),
  prompterText: z.string().max(100_000).nullish(),
  newsGroup: z.string().max(80).nullish(),
});

const updateStorySchema = createStorySchema.omit({ bulletinId: true }).partial();

const moveSchema = z.object({
  bulletinId: z.number().int().positive().nullable(), // null → Haber Havuzu
});

const lowerThirdSchema = z.object({
  kind: z.enum(['KJ', 'SPOT']),
  orderIndex: z.number().int().min(0).max(500).optional(),
  title: z.string().max(300).nullish(),
  line1: z.string().max(300).nullish(),
  line2: z.string().max(300).nullish(),
});
const replaceLowerThirdsSchema = z.object({
  items: z.array(lowerThirdSchema).max(50),
});

const listQuerySchema = z.object({
  bulletinId: z.coerce.number().int().positive().optional(),
  pool: z.coerce.boolean().optional(),        // true → bulletinId null (Haber Havuzu)
  group: z.string().max(80).optional(),
  q: z.string().max(200).optional(),          // başlık/açıklama arama
  from: dateSchema.optional(),                // İki Tarih Arası Haber Arama
  to: dateSchema.optional(),
});

/** Haber kilitliyse yalnız kilit sahibi veya Admin düzenleyebilir. */
function assertEditable(
  story: { locked: boolean; lockedBy: string | null },
  request: import('fastify').FastifyRequest,
): void {
  if (story.locked && story.lockedBy !== currentUser(request) && !isAdmin(request)) {
    throw httpError(409, `Haber kilitli (${story.lockedBy ?? 'bilinmeyen'}) — düzenlenemez`);
  }
}

/**
 * Haber (story) route'ları — /api/v1/news. CRUD + Koru/Kilitle (lock) +
 * bültene/havuza taşı + KJ/SPOT replace + İki Tarih Arası arama.
 * Soft-delete (Çöpe At) = deletedAt set. PATCH optimistic-lock (If-Match → 412).
 */
export async function storyRoutes(app: FastifyInstance) {
  // GET /stories?bulletinId=&pool=&group=&q=&from=&to=
  app.get('/stories', {
    preHandler: app.requireGroup(...PERMISSIONS.news.read),
    schema: { tags: ['News'], summary: 'Haberleri listele (havuz / bülten / arama)' },
  }, async (request) => {
    const q = listQuerySchema.parse(request.query);
    const where = {
      ...NOT_DELETED,
      ...(q.bulletinId ? { bulletinId: q.bulletinId } : {}),
      ...(q.pool ? { bulletinId: null } : {}),
      ...(q.group ? { newsGroup: q.group } : {}),
      ...(q.q
        ? {
            OR: [
              { title: { contains: q.q, mode: 'insensitive' as const } },
              { description: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: parseDateOnly(q.from) } : {}),
              ...(q.to ? { lt: new Date(parseDateOnly(q.to).getTime() + 86_400_000) } : {}),
            },
          }
        : {}),
    };
    const stories = await app.prisma.newsStory.findMany({
      where,
      include: STORY_DETAIL_INCLUDE,
      orderBy: q.bulletinId ? { orderIndex: 'asc' } : { updatedAt: 'desc' },
      take: 300,
    });
    return stories.map(serializeStory);
  });

  // POST /stories — havuza veya bülten sonuna ekle.
  app.post('/stories', {
    preHandler: app.requireGroup(...PERMISSIONS.news.write),
    schema: { tags: ['News'], summary: 'Yeni haber oluştur' },
  }, async (request, reply) => {
    const dto = createStorySchema.parse(request.body);
    const user = currentUser(request);

    let orderIndex = 0;
    if (dto.bulletinId) {
      const bulletin = await app.prisma.newsBulletin.findFirst({
        where: { id: dto.bulletinId, ...NOT_DELETED }, select: { id: true },
      });
      if (!bulletin) throw httpError(404, 'Bülten bulunamadı');
      const last = await app.prisma.newsStory.aggregate({
        where: { bulletinId: dto.bulletinId, ...NOT_DELETED },
        _max: { orderIndex: true },
      });
      orderIndex = (last._max.orderIndex ?? -1) + 1;
    }

    const created = await app.prisma.newsStory.create({
      data: {
        bulletinId: dto.bulletinId ?? null,
        orderIndex,
        title: dto.title,
        displayName: dto.displayName ?? null,
        storyType: dto.storyType ?? 'READER',
        clipDurationSec: dto.clipDurationSec ?? 0,
        anchorName: dto.anchorName ?? null,
        description: dto.description ?? null,
        prompterText: dto.prompterText ?? null,
        newsGroup: dto.newsGroup ?? null,
        createdBy: user,
        updatedBy: user,
      },
      include: STORY_DETAIL_INCLUDE,
    });
    reply.status(201);
    return serializeStory(created);
  });

  // GET /stories/:id
  app.get<{ Params: { id: string } }>('/stories/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.news.read),
    schema: { tags: ['News'], summary: 'Haber detayı' },
  }, async (request) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const story = await app.prisma.newsStory.findFirst({ where: { id, ...NOT_DELETED }, include: STORY_DETAIL_INCLUDE });
    if (!story) throw httpError(404, 'Haber bulunamadı');
    return serializeStory(story);
  });

  // PATCH /stories/:id — güncelle (lock kontrolü + If-Match → 412).
  app.patch<{ Params: { id: string } }>('/stories/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.news.write),
    schema: { tags: ['News'], summary: 'Haber güncelle (optimistic-lock + kilit kontrolü)' },
  }, async (request) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const dto = updateStorySchema.parse(request.body);
    const ifMatch = readIfMatch(request);
    const user = currentUser(request);

    const existing = await app.prisma.newsStory.findFirst({
      where: { id, ...NOT_DELETED }, select: { id: true, locked: true, lockedBy: true },
    });
    if (!existing) throw httpError(404, 'Haber bulunamadı');
    assertEditable(existing, request);

    const data = {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.displayName !== undefined ? { displayName: dto.displayName ?? null } : {}),
      ...(dto.storyType !== undefined ? { storyType: dto.storyType } : {}),
      ...(dto.clipDurationSec !== undefined ? { clipDurationSec: dto.clipDurationSec } : {}),
      ...(dto.anchorName !== undefined ? { anchorName: dto.anchorName ?? null } : {}),
      ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
      ...(dto.prompterText !== undefined ? { prompterText: dto.prompterText ?? null } : {}),
      ...(dto.newsGroup !== undefined ? { newsGroup: dto.newsGroup ?? null } : {}),
      updatedBy: user,
      version: { increment: 1 },
    };

    const result = await app.prisma.newsStory.updateMany({
      where: { id, ...NOT_DELETED, ...(ifMatch !== undefined ? { version: ifMatch } : {}) },
      data,
    });
    if (result.count !== 1) throw httpError(412, 'Haber sürüm çakışması (başkası güncellemiş olabilir)');
    const updated = await app.prisma.newsStory.findUniqueOrThrow({ where: { id }, include: STORY_DETAIL_INCLUDE });
    return serializeStory(updated);
  });

  // DELETE /stories/:id — Çöpe At (soft-delete).
  app.delete<{ Params: { id: string } }>('/stories/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.news.delete),
    schema: { tags: ['News'], summary: 'Haberi çöpe at (soft-delete)' },
  }, async (request, reply) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const existing = await app.prisma.newsStory.findFirst({
      where: { id, ...NOT_DELETED }, select: { id: true, locked: true, lockedBy: true },
    });
    if (!existing) throw httpError(404, 'Haber bulunamadı');
    assertEditable(existing, request);
    await app.prisma.newsStory.update({ where: { id }, data: { deletedAt: new Date() } });
    reply.status(204);
    return null;
  });

  // POST /stories/:id/lock — Haberi Koru.
  app.post<{ Params: { id: string } }>('/stories/:id/lock', {
    preHandler: app.requireGroup(...PERMISSIONS.news.write),
    schema: { tags: ['News'], summary: 'Haberi koru / kilitle' },
  }, async (request) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const user = currentUser(request);
    const existing = await app.prisma.newsStory.findFirst({
      where: { id, ...NOT_DELETED }, select: { id: true, locked: true, lockedBy: true },
    });
    if (!existing) throw httpError(404, 'Haber bulunamadı');
    assertEditable(existing, request); // başkasının kilidini ezme
    const updated = await app.prisma.newsStory.update({
      where: { id }, data: { locked: true, lockedBy: user }, include: STORY_DETAIL_INCLUDE,
    });
    return serializeStory(updated);
  });

  // POST /stories/:id/unlock — Korumayı Kaldır.
  app.post<{ Params: { id: string } }>('/stories/:id/unlock', {
    preHandler: app.requireGroup(...PERMISSIONS.news.write),
    schema: { tags: ['News'], summary: 'Haber korumasını kaldır' },
  }, async (request) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const existing = await app.prisma.newsStory.findFirst({
      where: { id, ...NOT_DELETED }, select: { id: true, locked: true, lockedBy: true },
    });
    if (!existing) throw httpError(404, 'Haber bulunamadı');
    assertEditable(existing, request);
    const updated = await app.prisma.newsStory.update({
      where: { id }, data: { locked: false, lockedBy: null }, include: STORY_DETAIL_INCLUDE,
    });
    return serializeStory(updated);
  });

  // POST /stories/:id/move — bültene taşı / havuza al (sona ekler).
  app.post<{ Params: { id: string } }>('/stories/:id/move', {
    preHandler: app.requireGroup(...PERMISSIONS.news.write),
    schema: { tags: ['News'], summary: 'Haberi bültene taşı / havuza al' },
  }, async (request) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const { bulletinId } = moveSchema.parse(request.body);

    const existing = await app.prisma.newsStory.findFirst({
      where: { id, ...NOT_DELETED }, select: { id: true, locked: true, lockedBy: true },
    });
    if (!existing) throw httpError(404, 'Haber bulunamadı');
    assertEditable(existing, request);

    let orderIndex = 0;
    if (bulletinId !== null) {
      const bulletin = await app.prisma.newsBulletin.findFirst({ where: { id: bulletinId, ...NOT_DELETED }, select: { id: true } });
      if (!bulletin) throw httpError(404, 'Hedef bülten bulunamadı');
      const last = await app.prisma.newsStory.aggregate({
        where: { bulletinId, ...NOT_DELETED }, _max: { orderIndex: true },
      });
      orderIndex = (last._max.orderIndex ?? -1) + 1;
    }
    const updated = await app.prisma.newsStory.update({
      where: { id }, data: { bulletinId, orderIndex, updatedBy: currentUser(request) }, include: STORY_DETAIL_INCLUDE,
    });
    return serializeStory(updated);
  });

  // PUT /stories/:id/lower-thirds — KJ/SPOT listesini topluca değiştir.
  app.put<{ Params: { id: string } }>('/stories/:id/lower-thirds', {
    preHandler: app.requireGroup(...PERMISSIONS.news.write),
    schema: { tags: ['News'], summary: 'Haberin KJ/SPOT listesini güncelle' },
  }, async (request) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const dto = replaceLowerThirdsSchema.parse(request.body);
    const existing = await app.prisma.newsStory.findFirst({
      where: { id, ...NOT_DELETED }, select: { id: true, locked: true, lockedBy: true },
    });
    if (!existing) throw httpError(404, 'Haber bulunamadı');
    assertEditable(existing, request);

    await app.prisma.$transaction(async (tx) => {
      await tx.newsLowerThird.deleteMany({ where: { storyId: id } });
      if (dto.items.length > 0) {
        await tx.newsLowerThird.createMany({
          data: dto.items.map((it, index) => ({
            storyId: id,
            kind: it.kind,
            orderIndex: it.orderIndex ?? index,
            title: it.title ?? null,
            line1: it.line1 ?? null,
            line2: it.line2 ?? null,
          })),
        });
      }
      await tx.newsStory.update({ where: { id }, data: { updatedBy: currentUser(request) } });
    });
    const updated = await app.prisma.newsStory.findUniqueOrThrow({ where: { id }, include: STORY_DETAIL_INCLUDE });
    return serializeStory(updated);
  });
}
