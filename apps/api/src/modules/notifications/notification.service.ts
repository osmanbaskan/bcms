import type { FastifyInstance } from 'fastify';
import type { NotificationSeverity, NotificationType, Prisma } from '@prisma/client';
import { NOTIFY_CHANNEL, type NotifyPayload } from './notification.pg-listener.js';

/**
 * Bildirim servisi — KULLANICI-BAZLI abonelik modeli.
 *  - Admin tip katalogunu (sekme bazlı) tanımlar (NotificationType).
 *  - Kullanıcı erişebildiği (requiredGroups) tipleri tek tek açar/kapatır
 *    (NotificationSubscription; satır yoksa defaultOn).
 *  - Teslim: kullanıcı o tipe efektif-abone ise gelir.
 * Model yazımları audit ext üzerinden; pg_notify `$executeRaw SELECT pg_notify`
 * (provys deseni — raw-SQL-write yasağı kapsamı dışında).
 */
const WINDOW_DAYS = 30;
const windowStart = (): Date => new Date(Date.now() - WINDOW_DAYS * 86_400_000);
const isAdmin = (groups: string[]) => groups.includes('Admin');

export interface CreateNotificationInput {
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  severity?: NotificationSeverity;
  data?: Prisma.InputJsonValue;
  createdBy?: string | null;
}

async function emitNotify(app: FastifyInstance, payload: NotifyPayload): Promise<void> {
  try {
    await app.prisma.$executeRaw`SELECT pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(payload)})`;
  } catch (err) {
    app.log.warn({ err, type: payload.type }, 'Notification: pg_notify başarısız');
  }
}

/** Bildirim oluştur. Tip katalogda yok veya pasifse atlanır (admin tanımlamalı). */
export async function createNotification(app: FastifyInstance, input: CreateNotificationInput): Promise<{ created: boolean; id?: number }> {
  const t = await app.prisma.notificationType.findUnique({ where: { key: input.type } });
  if (!t || !t.active) {
    app.log.warn({ type: input.type }, 'Notification: tip tanımsız/pasif, atlanıyor');
    return { created: false };
  }
  const severity = input.severity ?? t.severity;
  const row = await app.prisma.notification.create({
    data: {
      type: input.type, title: input.title, body: input.body ?? null, link: input.link ?? null,
      severity, data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined, createdBy: input.createdBy ?? null,
    },
  });
  await emitNotify(app, {
    id: row.id, type: row.type, section: t.section, severity: severity as NotifyPayload['severity'],
    title: row.title, body: row.body, link: row.link, requiredGroups: t.requiredGroups,
    defaultOn: t.defaultOn, sound: t.sound, createdAt: row.createdAt.toISOString(),
  });
  return { created: true, id: row.id };
}

// ── Kullanıcının efektif-abone olduğu tipler ────────────────────────────────
/** Kullanıcının erişebildiği (requiredGroups ∩ grup, Admin=hepsi) aktif tipler
 *  arasında, efektif açık olanların key listesi. */
async function resolveUserActiveTypes(app: FastifyInstance, userId: string, groups: string[]): Promise<string[]> {
  const admin = isAdmin(groups);
  const types = await app.prisma.notificationType.findMany({ where: { active: true } });
  const accessible = types.filter((t) => admin || t.requiredGroups.some((g) => groups.includes(g)));
  if (accessible.length === 0) return [];
  const subs = await app.prisma.notificationSubscription.findMany({
    where: { userId, typeKey: { in: accessible.map((t) => t.key) } },
  });
  const subMap = new Map(subs.map((s) => [s.typeKey, s.enabled]));
  return accessible.filter((t) => (subMap.has(t.key) ? subMap.get(t.key)! : t.defaultOn)).map((t) => t.key);
}

// ── Liste / okunmadı / oku ──────────────────────────────────────────────────
export interface ListArgs { userId: string; groups: string[]; page: number; pageSize: number; onlyUnread: boolean; }

export async function listNotifications(app: FastifyInstance, a: ListArgs) {
  const activeTypes = await resolveUserActiveTypes(app, a.userId, a.groups);
  if (activeTypes.length === 0) return { data: [], total: 0, page: a.page, pageSize: a.pageSize, totalPages: 0 };
  const where: Prisma.NotificationWhereInput = {
    type: { in: activeTypes },
    createdAt: { gte: windowStart() },
    ...(a.onlyUnread ? { reads: { none: { userId: a.userId } } } : {}),
  };
  const [rows, total] = await Promise.all([
    app.prisma.notification.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (a.page - 1) * a.pageSize, take: a.pageSize,
      include: { reads: { where: { userId: a.userId }, select: { readAt: true } } },
    }),
    app.prisma.notification.count({ where }),
  ]);
  const data = rows.map((r) => ({
    id: r.id, type: r.type, severity: r.severity, title: r.title, body: r.body, link: r.link,
    data: r.data, createdAt: r.createdAt.toISOString(), read: r.reads.length > 0, readAt: r.reads[0]?.readAt?.toISOString() ?? null,
  }));
  return { data, total, page: a.page, pageSize: a.pageSize, totalPages: Math.ceil(total / a.pageSize) };
}

export async function unreadCount(app: FastifyInstance, userId: string, groups: string[]): Promise<number> {
  const activeTypes = await resolveUserActiveTypes(app, userId, groups);
  if (activeTypes.length === 0) return 0;
  return app.prisma.notification.count({
    where: { type: { in: activeTypes }, createdAt: { gte: windowStart() }, reads: { none: { userId } } },
  });
}

export async function markRead(app: FastifyInstance, userId: string, notificationId: number): Promise<void> {
  await app.prisma.notificationRead.upsert({
    where: { notificationId_userId: { notificationId, userId } },
    create: { notificationId, userId }, update: {},
  });
}

export async function markAllRead(app: FastifyInstance, userId: string, groups: string[]): Promise<number> {
  const activeTypes = await resolveUserActiveTypes(app, userId, groups);
  if (activeTypes.length === 0) return 0;
  const unread = await app.prisma.notification.findMany({
    where: { type: { in: activeTypes }, createdAt: { gte: windowStart() }, reads: { none: { userId } } },
    select: { id: true },
  });
  if (unread.length === 0) return 0;
  await app.prisma.notificationRead.createMany({ data: unread.map((n) => ({ notificationId: n.id, userId })), skipDuplicates: true });
  return unread.length;
}

// ── Kullanıcı abonelikleri (ayarlar ekranı) ─────────────────────────────────
/** Kullanıcının erişebildiği aktif tipler + efektif açık/kapalı durumu (sekme bazlı UI için). */
export async function getUserSubscriptions(app: FastifyInstance, userId: string, groups: string[]) {
  const admin = isAdmin(groups);
  const types = await app.prisma.notificationType.findMany({ where: { active: true }, orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }] });
  const accessible = types.filter((t) => admin || t.requiredGroups.some((g) => groups.includes(g)));
  const subs = await app.prisma.notificationSubscription.findMany({ where: { userId, typeKey: { in: accessible.map((t) => t.key) } } });
  const subMap = new Map(subs.map((s) => [s.typeKey, s]));
  return accessible.map((t) => {
    const s = subMap.get(t.key);
    return {
      key: t.key, label: t.label, section: t.section, severity: t.severity,
      enabled: s ? s.enabled : t.defaultOn,
      // Efektif ses: kullanıcı seçtiyse o, yoksa tipin varsayılan sesi.
      sound: s?.sound ?? t.sound,
    };
  });
}

/** Tek tip aç/kapa (+ opsiyonel ses). Kullanıcı tipe erişemiyorsa null döner (route 403). */
export async function setSubscription(
  app: FastifyInstance, userId: string, groups: string[], typeKey: string, enabled: boolean, sound?: string | null,
): Promise<{ enabled: boolean; sound: string | null } | null> {
  const t = await app.prisma.notificationType.findUnique({ where: { key: typeKey } });
  if (!t || !t.active) return null;
  if (!isAdmin(groups) && !t.requiredGroups.some((g) => groups.includes(g))) return null;
  const row = await app.prisma.notificationSubscription.upsert({
    where: { userId_typeKey: { userId, typeKey } },
    create: { userId, typeKey, enabled, sound: sound ?? null },
    update: { enabled, ...(sound !== undefined ? { sound } : {}) },
  });
  return { enabled: row.enabled, sound: row.sound ?? t.sound };
}

// ── Admin: tip katalogu ─────────────────────────────────────────────────────
export async function listTypes(app: FastifyInstance): Promise<NotificationType[]> {
  return app.prisma.notificationType.findMany({ orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }, { key: 'asc' }] });
}

export async function upsertType(app: FastifyInstance, input: {
  key: string; label: string; section: string; requiredGroups: string[]; severity: NotificationSeverity; sound: string; defaultOn: boolean; active: boolean; sortOrder: number;
}): Promise<NotificationType> {
  const { key, ...rest } = input;
  return app.prisma.notificationType.upsert({ where: { key }, create: input, update: rest });
}

export async function deleteType(app: FastifyInstance, key: string): Promise<boolean> {
  try { await app.prisma.notificationType.delete({ where: { key } }); return true; }
  catch { return false; }
}

/** Boot'ta idempotent başlangıç tip katalogu (sekme + grup); mevcutlar korunur. */
export async function seedTypes(app: FastifyInstance): Promise<void> {
  const seed = [
    { key: 'ingest.completed',           label: 'Ingest tamamlandı',            section: 'ingest',            requiredGroups: ['Ingest', 'MCR'],               severity: 'info' as NotificationSeverity,     sound: 'normal',   defaultOn: true,  active: true, sortOrder: 1 },
    { key: 'ingest.failed',              label: 'Ingest hatası',                section: 'ingest',            requiredGroups: ['Ingest', 'MCR'],               severity: 'warning' as NotificationSeverity,  sound: 'critical', defaultOn: true,  active: true, sortOrder: 2 },
    { key: 'restore.completed',          label: 'Restore tamamlandı',           section: 'restore',           requiredGroups: ['MCR', 'PCR', 'SystemEng'],     severity: 'info' as NotificationSeverity,     sound: 'normal',   defaultOn: true,  active: true, sortOrder: 1 },
    { key: 'restore.failed',             label: 'Restore hatası',               section: 'restore',           requiredGroups: ['MCR', 'PCR', 'SystemEng'],     severity: 'warning' as NotificationSeverity,  sound: 'critical', defaultOn: true,  active: true, sortOrder: 2 },
    { key: 'booking.created',            label: 'Yeni booking',                 section: 'bookings',          requiredGroups: ['Booking', 'YayınPlanlama'],    severity: 'info' as NotificationSeverity,     sound: 'normal',   defaultOn: true,  active: true, sortOrder: 1 },
    { key: 'booking.status_changed',     label: 'Booking durumu değişti',       section: 'bookings',          requiredGroups: ['Booking', 'YayınPlanlama'],    severity: 'info' as NotificationSeverity,     sound: 'normal',   defaultOn: false, active: true, sortOrder: 2 },
    { key: 'schedule.created',           label: 'Yayın planı oluştu',           section: 'yayin-planlama',    requiredGroups: ['YayınPlanlama', 'Transmisyon'], severity: 'info' as NotificationSeverity,    sound: 'normal',   defaultOn: true,  active: true, sortOrder: 1 },
    { key: 'schedule.updated',           label: 'Yayın planı değişti',          section: 'yayin-planlama',    requiredGroups: ['YayınPlanlama', 'Transmisyon'], severity: 'info' as NotificationSeverity,    sound: 'normal',   defaultOn: false, active: true, sortOrder: 2 },
    { key: 'live_plan.technical_changed', label: 'Canlı-plan teknik değişiklik', section: 'canli-yayin-plan',  requiredGroups: ['Transmisyon', 'Tekyon'],       severity: 'info' as NotificationSeverity,     sound: 'normal',   defaultOn: true,  active: true, sortOrder: 1 },
    { key: 'service.down',               label: 'Servis/watcher düştü',         section: 'system',            requiredGroups: ['SystemEng'],                   severity: 'critical' as NotificationSeverity, sound: 'critical', defaultOn: true,  active: true, sortOrder: 1 },
  ];
  try { await app.prisma.notificationType.createMany({ data: seed, skipDuplicates: true }); }
  catch (err) { app.log.warn({ err }, 'Notification type seed atlandı'); }
}
