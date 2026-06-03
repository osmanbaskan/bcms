import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, type JwtPayload } from '@bcms/shared';
import { getNotificationPgListener, closeNotificationPgListener, type NotifyPayload } from './notification.pg-listener.js';
import {
  listNotifications, unreadCount, markRead, markAllRead,
  getUserSubscriptions, setSubscription, listTypes, upsertType, deleteType, createNotification,
} from './notification.service.js';

const listQuery = z.object({
  page:       z.coerce.number().int().min(1).default(1),
  pageSize:   z.coerce.number().int().min(1).max(100).default(30),
  onlyUnread: z.enum(['true', 'false']).default('false'),
});
const subBody  = z.object({ typeKey: z.string().trim().min(1).max(80), enabled: z.boolean(), sound: z.enum(['off', 'normal', 'critical']).optional() });
const typeBody = z.object({
  key:            z.string().trim().min(1).max(80),
  label:          z.string().trim().min(1).max(200),
  section:        z.string().trim().min(1).max(60),
  requiredGroups: z.array(z.string().trim().min(1).max(40)).max(20),
  severity:       z.enum(['info', 'warning', 'critical']).default('info'),
  sound:          z.enum(['normal', 'critical']).default('normal'),
  defaultOn:      z.boolean().default(true),
  active:         z.boolean().default(true),
  sortOrder:      z.coerce.number().int().default(0),
});
const createBody = z.object({
  type:     z.string().trim().min(1).max(80),
  title:    z.string().trim().min(1).max(200),
  body:     z.string().max(2000).optional(),
  link:     z.string().max(300).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
});

const principal = (request: { user?: unknown }) => {
  const u = (request.user as JwtPayload | undefined) ?? ({} as JwtPayload);
  return { sub: u.sub ?? 'system', groups: u.groups ?? [], username: u.preferred_username ?? null };
};
const isAdmin = (groups: string[]) => groups.includes('Admin');

export async function notificationRoutes(app: FastifyInstance) {
  // ── SSE stream — kullanıcının abone olduğu tipler süzülerek iletilir ──
  app.get('/stream', {
    preHandler: app.requireGroup(...PERMISSIONS.notifications.read),
    config: { rateLimit: false },
    schema: { tags: ['Notifications'], summary: 'Bildirim SSE akışı' },
  }, async (request, reply) => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return reply.code(500).send({ message: 'DATABASE_URL set edilmemiş' });

    const { sub, groups } = principal(request);
    const admin = isAdmin(groups);
    const subs = await app.prisma.notificationSubscription.findMany({ where: { userId: sub } }).catch(() => []);
    const subMap = new Map(subs.map((s) => [s.typeKey, s.enabled]));

    reply.raw.statusCode = 200;
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const writeEvent = (obj: unknown): void => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); };
    const writeComment = (t: string): void => { if (!reply.raw.writableEnded) reply.raw.write(`: ${t}\n\n`); };
    writeComment('connected');

    const matches = (p: NotifyPayload): boolean => {
      const access = admin || p.requiredGroups.some((g) => groups.includes(g));
      if (!access) return false;
      const enabled = subMap.has(p.type) ? subMap.get(p.type)! : p.defaultOn;
      return enabled;
    };

    const listener = getNotificationPgListener(dbUrl, app.log);
    let unsubscribe: (() => Promise<void>) | null = null;
    try {
      unsubscribe = await listener.subscribe((payload) => { if (matches(payload)) writeEvent({ type: 'notification', notification: payload }); });
    } catch (err) {
      app.log.error({ err }, 'Notification SSE: subscribe hatası');
      reply.raw.end();
      return;
    }

    const heartbeatMs = Number(process.env.NOTIFY_SSE_HEARTBEAT_MS ?? '25000');
    const heartbeat = setInterval(() => { writeComment('hb'); writeEvent({ type: 'heartbeat', ts: Date.now() }); }, heartbeatMs);
    heartbeat.unref?.();

    const cleanup = async () => {
      clearInterval(heartbeat);
      if (unsubscribe) { await unsubscribe().catch(() => {}); unsubscribe = null; }
    };
    request.raw.on('close', () => { void cleanup(); });
    reply.raw.on('error', () => { void cleanup(); });
    return reply;
  });

  // ── Liste / okunmadı / oku ──
  app.get('/', { preHandler: app.requireGroup(...PERMISSIONS.notifications.read) }, async (request) => {
    const q = listQuery.parse(request.query);
    const { sub, groups } = principal(request);
    return listNotifications(app, { userId: sub, groups, page: q.page, pageSize: q.pageSize, onlyUnread: q.onlyUnread === 'true' });
  });

  app.get('/unread-count', { preHandler: app.requireGroup(...PERMISSIONS.notifications.read) }, async (request) => {
    const { sub, groups } = principal(request);
    return { count: await unreadCount(app, sub, groups) };
  });

  app.post<{ Params: { id: string } }>('/:id/read', { preHandler: app.requireGroup(...PERMISSIONS.notifications.read) }, async (request) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    await markRead(app, principal(request).sub, id);
    return { ok: true };
  });

  app.post('/read-all', { preHandler: app.requireGroup(...PERMISSIONS.notifications.read) }, async (request) => {
    const { sub, groups } = principal(request);
    return { marked: await markAllRead(app, sub, groups) };
  });

  // ── Kullanıcı abonelikleri (ayarlar) ──
  app.get('/subscriptions', { preHandler: app.requireGroup(...PERMISSIONS.notifications.read) }, async (request) => {
    const { sub, groups } = principal(request);
    return { data: await getUserSubscriptions(app, sub, groups) };
  });

  app.put('/subscriptions', { preHandler: app.requireGroup(...PERMISSIONS.notifications.read) }, async (request, reply) => {
    const body = subBody.parse(request.body);
    const { sub, groups } = principal(request);
    const res = await setSubscription(app, sub, groups, body.typeKey, body.enabled, body.sound);
    if (res === null) return reply.code(403).send({ statusCode: 403, error: 'Forbidden', message: 'Bu bildirim tipine erişiminiz yok' });
    return { typeKey: body.typeKey, ...res };
  });

  // ── Admin: tip katalogu ──
  app.get('/types', { preHandler: app.requireGroup(...PERMISSIONS.notifications.config), schema: { tags: ['Notifications'] } }, async () => ({ data: await listTypes(app) }));

  app.put('/types', { preHandler: app.requireGroup(...PERMISSIONS.notifications.config) }, async (request) => upsertType(app, typeBody.parse(request.body)));

  app.delete<{ Params: { key: string } }>('/types/:key', { preHandler: app.requireGroup(...PERMISSIONS.notifications.config) }, async (request) => {
    const key = z.string().trim().min(1).max(80).parse(request.params.key);
    return { deleted: await deleteType(app, key) };
  });

  // ── Admin/sistem: manuel bildirim oluştur (test + duyuru) ──
  app.post('/', { preHandler: app.requireGroup(...PERMISSIONS.notifications.config), schema: { tags: ['Notifications'] } }, async (request, reply) => {
    const body = createBody.parse(request.body);
    const res = await createNotification(app, { ...body, createdBy: principal(request).username });
    return reply.code(res.created ? 201 : 200).send(res);
  });

  // Bağlı tüm SSE kapanınca pg listener'ı serbest bırak (provys deseni).
  app.addHook('onClose', async () => { await closeNotificationPgListener().catch(() => {}); });
}
