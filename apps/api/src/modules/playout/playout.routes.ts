import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { PERMISSIONS } from '@bcms/shared';

const rundownQuerySchema = z.object({
  channelId: z.coerce.number().int().positive().optional(),
  date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const goLiveSchema = z.object({
  tcIn: z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/).optional(),
  note: z.string().optional(),
});

const endSchema = z.object({
  tcOut: z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/).optional(),
  note:  z.string().optional(),
});

const timelineSchema = z.object({
  tc:   z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/).optional(),
  type: z.string().min(1).max(50).optional(),
  note: z.string().max(1000).optional(),
});

export async function playoutRoutes(app: FastifyInstance) {
  // ── GET /api/v1/playout/current ──────────────────────────────────────────
  // Şu an ON_AIR olan schedule'ları döner (kanal bilgisiyle birlikte)
  app.get('/current', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.read),
    schema: { tags: ['Playout'], summary: 'Şu an yayındaki programları getir' },
  }, async () => {
    return app.prisma.schedule.findMany({
      where:   { status: 'ON_AIR' },
      include: { channel: true },
      orderBy: { startTime: 'asc' },
    });
  });

  // ── GET /api/v1/playout/next ─────────────────────────────────────────────
  // Sonraki 2 saatte başlayacak CONFIRMED schedule'lar
  app.get('/next', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.read),
    schema: { tags: ['Playout'], summary: 'Yaklaşan programları getir (2 saat)' },
  }, async () => {
    const now  = new Date();
    const soon = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    return app.prisma.schedule.findMany({
      where: {
        status:    'CONFIRMED',
        startTime: { gte: now, lte: soon },
      },
      include: { channel: true },
      orderBy: { startTime: 'asc' },
    });
  });

  // ── GET /api/v1/playout/rundown ──────────────────────────────────────────
  // Bugünün tüm schedule'ları — MCR rundown listesi
  app.get('/rundown', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.read),
    schema: { tags: ['Playout'], summary: 'Bugünün yayın akışı (tüm kanallar)' },
  }, async (request) => {
    const q = rundownQuerySchema.parse(request.query);

    const base  = q.date ? new Date(q.date) : new Date();
    const start = new Date(base); start.setHours(0, 0, 0, 0);
    const end   = new Date(base); end.setHours(23, 59, 59, 999);

    return app.prisma.schedule.findMany({
      where: {
        startTime: { gte: start, lte: end },
        ...(q.channelId && { channelId: q.channelId }),
        status: { not: 'CANCELLED' },
      },
      include: { channel: { select: { id: true, name: true, type: true } } },
      orderBy: [{ channelId: 'asc' }, { startTime: 'asc' }],
    });
  });

  // ── POST /api/v1/playout/:id/go-live ────────────────────────────────────
  // Schedule'ı ON_AIR durumuna al + timeline event + otomatik incident kapat
  app.post<{ Params: { id: string } }>('/:id/go-live', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.write),
    schema: { tags: ['Playout'], summary: 'Programı yayına al (ON_AIR)' },
  }, async (request, reply) => {
    const id  = z.coerce.number().int().positive().parse(request.params.id);
    const dto = goLiveSchema.parse(request.body ?? {});
    const user = (request.user as { preferred_username?: string })?.preferred_username ?? 'system';

    const updated = await app.prisma.$transaction(async (tx) => {
      const schedule = await tx.schedule.findUnique({ where: { id } });
      if (!schedule) throw Object.assign(new Error('Schedule bulunamadı'), { statusCode: 404 });
      if (schedule.status !== 'CONFIRMED') {
        throw Object.assign(new Error('Sadece CONFIRMED durumundaki program yayına alınabilir'), { statusCode: 409 });
      }

      if (schedule.channelId != null) {
        const activeOnChannel = await tx.schedule.findFirst({
          where: {
            channelId: schedule.channelId,
            status: 'ON_AIR',
            id: { not: id },
          },
          select: { id: true, title: true },
        });
        if (activeOnChannel) {
          throw Object.assign(new Error('Bu kanalda zaten ON_AIR program var'), {
            statusCode: 409,
            activeSchedule: activeOnChannel,
          });
        }
      }

      const live = await tx.schedule.update({
        where: { id },
        data:  { status: 'ON_AIR' },
        include: { channel: true },
      });

      await tx.timelineEvent.create({
        data: {
          scheduleId: id,
          tc:         dto.tcIn ?? tcNow(),
          type:       'GO_LIVE',
          note:       dto.note ?? `Yayın başladı`,
          createdBy:  user,
        },
      });

      return live;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    reply.status(200).send(updated);
  });

  // ── POST /api/v1/playout/:id/end ─────────────────────────────────────────
  // Schedule'ı COMPLETED durumuna al + timeline event
  app.post<{ Params: { id: string } }>('/:id/end', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.write),
    schema: { tags: ['Playout'], summary: 'Programı bitir (COMPLETED)' },
  }, async (request, reply) => {
    const id  = z.coerce.number().int().positive().parse(request.params.id);
    const dto = endSchema.parse(request.body ?? {});
    const user = (request.user as { preferred_username?: string })?.preferred_username ?? 'system';

    const updated = await app.prisma.$transaction(async (tx) => {
      const schedule = await tx.schedule.findUnique({ where: { id } });
      if (!schedule) throw Object.assign(new Error('Schedule bulunamadı'), { statusCode: 404 });
      if (schedule.status !== 'ON_AIR') {
        throw Object.assign(new Error('Sadece ON_AIR durumundaki program bitirilebilir'), { statusCode: 409 });
      }

      const completed = await tx.schedule.update({
        where: { id },
        data:  { status: 'COMPLETED', finishedAt: new Date() },
        include: { channel: true },
      });

      await tx.timelineEvent.create({
        data: {
          scheduleId: id,
          tc:         dto.tcOut ?? tcNow(),
          type:       'END',
          note:       dto.note ?? `Yayın tamamlandı`,
          createdBy:  user,
        },
      });

      return completed;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    reply.status(200).send(updated);
  });

  // ── GET /api/v1/playout/:id/timeline ────────────────────────────────────
  // Schedule'a ait timeline eventleri
  app.get<{ Params: { id: string } }>('/:id/timeline', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.read),
    schema: { tags: ['Playout'], summary: 'Program zaman tüneli olayları' },
  }, async (request) => {
    return app.prisma.timelineEvent.findMany({
      where:   { scheduleId: z.coerce.number().int().positive().parse(request.params.id) },
      orderBy: { tc: 'asc' },
    });
  });

  // ── POST /api/v1/playout/:id/timeline ───────────────────────────────────
  // Yeni timeline event ekle (TD / teknik yönetmen notu)
  app.post<{ Params: { id: string } }>('/:id/timeline', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.write),
    schema: { tags: ['Playout'], summary: 'Zaman tüneline not ekle' },
  }, async (request, reply) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const body = timelineSchema.parse(request.body ?? {});
    const user = (request.user as { preferred_username?: string })?.preferred_username ?? 'system';

    const event = await app.prisma.timelineEvent.create({
      data: {
        scheduleId: id,
        tc:         body.tc ?? tcNow(),
        type:       body.type ?? 'NOTE',
        note:       body.note,
        createdBy:  user,
      },
    });

    reply.status(201).send(event);
  });
}

// ── Yardımcı: şu anki zamanı HH:MM:SS:FF formatına çevir ─────────────────
function tcNow(): string {
  const now = new Date();
  const h   = String(now.getHours()).padStart(2, '0');
  const m   = String(now.getMinutes()).padStart(2, '0');
  const s   = String(now.getSeconds()).padStart(2, '0');
  const f   = String(Math.floor(now.getMilliseconds() / 40)).padStart(2, '0'); // 25fps
  return `${h}:${m}:${s}:${f}`;
}
