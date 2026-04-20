import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';

const goLiveSchema = z.object({
  tcIn: z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/).optional(),
  note: z.string().optional(),
});

const endSchema = z.object({
  tcOut: z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/).optional(),
  note:  z.string().optional(),
});

export async function playoutRoutes(app: FastifyInstance) {
  // ── GET /api/v1/playout/current ──────────────────────────────────────────
  // Şu an ON_AIR olan schedule'ları döner (kanal bilgisiyle birlikte)
  app.get('/current', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
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
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
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
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: { tags: ['Playout'], summary: 'Bugünün yayın akışı (tüm kanallar)' },
  }, async (request) => {
    const q = request.query as { channelId?: string; date?: string };

    const base  = q.date ? new Date(q.date) : new Date();
    const start = new Date(base); start.setHours(0, 0, 0, 0);
    const end   = new Date(base); end.setHours(23, 59, 59, 999);

    return app.prisma.schedule.findMany({
      where: {
        startTime: { gte: start, lte: end },
        ...(q.channelId && { channelId: Number(q.channelId) }),
        status: { not: 'CANCELLED' },
      },
      include: { channel: { select: { id: true, name: true, type: true } } },
      orderBy: [{ channelId: 'asc' }, { startTime: 'asc' }],
    });
  });

  // ── POST /api/v1/playout/:id/go-live ────────────────────────────────────
  // Schedule'ı ON_AIR durumuna al + timeline event + otomatik incident kapat
  app.post<{ Params: { id: string } }>('/:id/go-live', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.write),
    schema: { tags: ['Playout'], summary: 'Programı yayına al (ON_AIR)' },
  }, async (request, reply) => {
    const id  = Number(request.params.id);
    const dto = goLiveSchema.parse(request.body ?? {});
    const user = (request.user as { preferred_username?: string })?.preferred_username ?? 'system';

    const schedule = await app.prisma.schedule.findUnique({ where: { id } });
    if (!schedule) throw Object.assign(new Error('Schedule bulunamadı'), { statusCode: 404 });
    if (schedule.status === 'ON_AIR') throw Object.assign(new Error('Zaten yayında'), { statusCode: 409 });

    const [updated] = await app.prisma.$transaction([
      app.prisma.schedule.update({
        where: { id },
        data:  { status: 'ON_AIR' },
        include: { channel: true },
      }),
      app.prisma.timelineEvent.create({
        data: {
          scheduleId: id,
          tc:         dto.tcIn ?? tcNow(),
          type:       'GO_LIVE',
          note:       dto.note ?? `Yayın başladı`,
          createdBy:  user,
        },
      }),
    ]);

    reply.status(200).send(updated);
  });

  // ── POST /api/v1/playout/:id/end ─────────────────────────────────────────
  // Schedule'ı COMPLETED durumuna al + timeline event
  app.post<{ Params: { id: string } }>('/:id/end', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.write),
    schema: { tags: ['Playout'], summary: 'Programı bitir (COMPLETED)' },
  }, async (request, reply) => {
    const id  = Number(request.params.id);
    const dto = endSchema.parse(request.body ?? {});
    const user = (request.user as { preferred_username?: string })?.preferred_username ?? 'system';

    const schedule = await app.prisma.schedule.findUnique({ where: { id } });
    if (!schedule) throw Object.assign(new Error('Schedule bulunamadı'), { statusCode: 404 });

    const [updated] = await app.prisma.$transaction([
      app.prisma.schedule.update({
        where: { id },
        data:  { status: 'COMPLETED', finishedAt: new Date() },
        include: { channel: true },
      }),
      app.prisma.timelineEvent.create({
        data: {
          scheduleId: id,
          tc:         dto.tcOut ?? tcNow(),
          type:       'END',
          note:       dto.note ?? `Yayın tamamlandı`,
          createdBy:  user,
        },
      }),
    ]);

    reply.status(200).send(updated);
  });

  // ── GET /api/v1/playout/:id/timeline ────────────────────────────────────
  // Schedule'a ait timeline eventleri
  app.get<{ Params: { id: string } }>('/:id/timeline', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: { tags: ['Playout'], summary: 'Program zaman tüneli olayları' },
  }, async (request) => {
    return app.prisma.timelineEvent.findMany({
      where:   { scheduleId: Number(request.params.id) },
      orderBy: { tc: 'asc' },
    });
  });

  // ── POST /api/v1/playout/:id/timeline ───────────────────────────────────
  // Yeni timeline event ekle (TD / teknik yönetmen notu)
  app.post<{ Params: { id: string } }>('/:id/timeline', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.write),
    schema: { tags: ['Playout'], summary: 'Zaman tüneline not ekle' },
  }, async (request, reply) => {
    const id = Number(request.params.id);
    const body = request.body as { tc?: string; type?: string; note?: string };
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
