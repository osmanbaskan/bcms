import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';
import {
  BULLETIN_DETAIL_INCLUDE,
  NOT_DELETED,
  currentUser,
  httpError,
  parseDateOnly,
  readIfMatch,
  serializeBulletin,
} from './news.service.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD bekleniyor');
const statusSchema = z.enum(['DRAFT', 'READY', 'ON_AIR', 'DONE', 'ARCHIVED']);

const createBulletinSchema = z.object({
  name: z.string().min(1).max(200),
  bulletinCode: z.string().max(40).nullish(),
  bulletinDate: dateSchema,
  onAirMinute: z.number().int().min(0).max(24 * 60 - 1), // 00:00–23:59 gün-dakikası
  anchorName: z.string().max(200).nullish(),
  newsGroup: z.string().max(80).nullish(),
  status: statusSchema.optional(),
});

const updateBulletinSchema = createBulletinSchema.partial();

const reorderSchema = z.object({
  orderedStoryIds: z.array(z.number().int().positive()).max(500),
});

const listQuerySchema = z.object({
  date: dateSchema.optional(),
  group: z.string().max(80).optional(),
  status: statusSchema.optional(),
});

/**
 * Bülten (rundown / "Günlük Yayın Akışları") route'ları — /api/v1/news.
 * CRUD + story akış sırası (reorder) + status. PATCH optimistic-lock (If-Match).
 * Soft-delete: bülten silinince story'leri Haber Havuzu'na düşer (bulletinId=null).
 */
export async function bulletinRoutes(app: FastifyInstance) {
  // GET /bulletins?date=&group=&status= — liste (storyCount + toplam süre).
  app.get('/bulletins', {
    preHandler: app.requireGroup(...PERMISSIONS.news.read),
    schema: { tags: ['News'], summary: 'Bültenleri (günlük yayın akışları) listele' },
  }, async (request) => {
    const q = listQuerySchema.parse(request.query);
    const where = {
      ...NOT_DELETED,
      ...(q.date ? { bulletinDate: parseDateOnly(q.date) } : {}),
      ...(q.group ? { newsGroup: q.group } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const bulletins = await app.prisma.newsBulletin.findMany({
      where,
      orderBy: [{ bulletinDate: 'desc' }, { onAirMinute: 'asc' }],
    });
    const ids = bulletins.map((b) => b.id);
    const agg = ids.length
      ? await app.prisma.newsStory.groupBy({
          by: ['bulletinId'],
          where: { bulletinId: { in: ids }, ...NOT_DELETED },
          _count: { _all: true },
          _sum: { clipDurationSec: true },
        })
      : [];
    const byId = new Map(agg.map((a) => [a.bulletinId, a]));
    return bulletins.map((b) =>
      serializeBulletin(b, {
        storyCount: byId.get(b.id)?._count._all ?? 0,
        totalDurationSec: byId.get(b.id)?._sum.clipDurationSec ?? 0,
      }),
    );
  });

  // POST /bulletins — yeni bülten.
  app.post('/bulletins', {
    preHandler: app.requireGroup(...PERMISSIONS.news.write),
    schema: { tags: ['News'], summary: 'Yeni bülten oluştur' },
  }, async (request, reply) => {
    const dto = createBulletinSchema.parse(request.body);
    const user = currentUser(request);
    const created = await app.prisma.newsBulletin.create({
      data: {
        name: dto.name,
        bulletinCode: dto.bulletinCode ?? null,
        bulletinDate: parseDateOnly(dto.bulletinDate),
        onAirMinute: dto.onAirMinute,
        anchorName: dto.anchorName ?? null,
        newsGroup: dto.newsGroup ?? null,
        status: dto.status ?? 'DRAFT',
        createdBy: user,
        updatedBy: user,
      },
    });
    reply.status(201);
    return serializeBulletin(created, { storyCount: 0, totalDurationSec: 0 });
  });

  // GET /bulletins/:id — detay (sıralı story + KJ/SPOT).
  app.get<{ Params: { id: string } }>('/bulletins/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.news.read),
    schema: { tags: ['News'], summary: 'Bülten detayı (akış + KJ/SPOT)' },
  }, async (request) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const bulletin = await app.prisma.newsBulletin.findFirst({
      where: { id, ...NOT_DELETED },
      include: BULLETIN_DETAIL_INCLUDE,
    });
    if (!bulletin) throw httpError(404, 'Bülten bulunamadı');
    return serializeBulletin(bulletin);
  });

  // PATCH /bulletins/:id — güncelle (If-Match → 412).
  app.patch<{ Params: { id: string } }>('/bulletins/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.news.write),
    schema: { tags: ['News'], summary: 'Bülten güncelle (optimistic-lock)' },
  }, async (request) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const dto = updateBulletinSchema.parse(request.body);
    const ifMatch = readIfMatch(request);
    const user = currentUser(request);

    const data = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.bulletinCode !== undefined ? { bulletinCode: dto.bulletinCode ?? null } : {}),
      ...(dto.bulletinDate !== undefined ? { bulletinDate: parseDateOnly(dto.bulletinDate) } : {}),
      ...(dto.onAirMinute !== undefined ? { onAirMinute: dto.onAirMinute } : {}),
      ...(dto.anchorName !== undefined ? { anchorName: dto.anchorName ?? null } : {}),
      ...(dto.newsGroup !== undefined ? { newsGroup: dto.newsGroup ?? null } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      updatedBy: user,
      version: { increment: 1 },
    };

    const result = await app.prisma.newsBulletin.updateMany({
      where: { id, ...NOT_DELETED, ...(ifMatch !== undefined ? { version: ifMatch } : {}) },
      data,
    });
    if (result.count !== 1) {
      const exists = await app.prisma.newsBulletin.findFirst({ where: { id, ...NOT_DELETED }, select: { id: true } });
      if (!exists) throw httpError(404, 'Bülten bulunamadı');
      throw httpError(412, 'Bülten sürüm çakışması (başkası güncellemiş olabilir)');
    }
    const updated = await app.prisma.newsBulletin.findUniqueOrThrow({ where: { id }, include: BULLETIN_DETAIL_INCLUDE });
    return serializeBulletin(updated);
  });

  // DELETE /bulletins/:id — soft-delete; story'ler Havuz'a düşer (bulletinId=null).
  app.delete<{ Params: { id: string } }>('/bulletins/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.news.delete),
    schema: { tags: ['News'], summary: 'Bülten sil (soft); story\'ler havuza döner' },
  }, async (request, reply) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const exists = await app.prisma.newsBulletin.findFirst({ where: { id, ...NOT_DELETED }, select: { id: true } });
    if (!exists) throw httpError(404, 'Bülten bulunamadı');
    await app.prisma.$transaction(async (tx) => {
      await tx.newsStory.updateMany({ where: { bulletinId: id, ...NOT_DELETED }, data: { bulletinId: null, orderIndex: 0 } });
      await tx.newsBulletin.update({ where: { id }, data: { deletedAt: new Date() } });
    });
    reply.status(204);
    return null;
  });

  // PUT /bulletins/:id/order — akış sırası (drag-reorder).
  app.put<{ Params: { id: string } }>('/bulletins/:id/order', {
    preHandler: app.requireGroup(...PERMISSIONS.news.write),
    schema: { tags: ['News'], summary: 'Bülten içi haber akış sırasını güncelle' },
  }, async (request) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const dto = reorderSchema.parse(request.body);

    const bulletin = await app.prisma.newsBulletin.findFirst({ where: { id, ...NOT_DELETED }, select: { id: true } });
    if (!bulletin) throw httpError(404, 'Bülten bulunamadı');

    const stories = await app.prisma.newsStory.findMany({
      where: { bulletinId: id, ...NOT_DELETED },
      select: { id: true },
    });
    const ownIds = new Set(stories.map((s) => s.id));
    if (dto.orderedStoryIds.length !== ownIds.size || dto.orderedStoryIds.some((sid) => !ownIds.has(sid))) {
      throw httpError(400, 'orderedStoryIds bültenin tüm haberlerini birebir içermeli');
    }

    await app.prisma.$transaction(
      dto.orderedStoryIds.map((sid, index) =>
        app.prisma.newsStory.update({ where: { id: sid }, data: { orderIndex: index } }),
      ),
    );

    const updated = await app.prisma.newsBulletin.findUniqueOrThrow({ where: { id }, include: BULLETIN_DETAIL_INCLUDE });
    return serializeBulletin(updated);
  });
}
