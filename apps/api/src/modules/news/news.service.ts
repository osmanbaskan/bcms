import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import type {
  NewsBulletin,
  NewsLowerThird,
  NewsLowerThirdKind,
  NewsMosAction,
  NewsMosDevice,
  NewsMosDeviceKind,
  NewsMosJob,
  NewsMosJobStatus,
  NewsStory,
  NewsStoryType,
  NewsWireItem,
  NewsWirePriority,
} from '@bcms/shared';

/**
 * Haber (NewsWorks NRCS) — ortak helper + mapper'lar.
 *
 * DB satırlarını (@db.Date / @db.Timestamptz) shared DTO'lara serialize eder.
 * TZ-lock: bulletinDate yalnız gün (YYYY-MM-DD), onAirMinute gün-dakikası
 * (Türkiye-naive) — UTC kaymasından etkilenmesin diye Date UTC gece-yarısı
 * olarak saklanır/okunur (studio-plan ile aynı yaklaşım).
 */

// ---- kullanıcı / yetki ----

export function currentUser(request: FastifyRequest): string {
  return (request.user as { preferred_username?: string })?.preferred_username ?? 'unknown';
}

export function isAdmin(request: FastifyRequest): boolean {
  const groups = (request.user as { groups?: string[] })?.groups ?? [];
  return groups.includes('Admin');
}

/** If-Match header → optimistic-lock beklenen version (yoksa undefined). */
export function readIfMatch(request: FastifyRequest): number | undefined {
  const raw = request.headers['if-match'];
  const str = Array.isArray(raw) ? raw[0] : raw;
  const n = str ? parseInt(str, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// ---- tarih helper'ları (UTC gece-yarısı = Türkiye gün anahtarı) ----

export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

// ---- mapper'lar ----

type DbLowerThird = Prisma.NewsLowerThirdGetPayload<Record<string, never>>;
type DbStory = Prisma.NewsStoryGetPayload<{ include: { lowerThirds: true } }>;
type DbStoryNoChildren = Prisma.NewsStoryGetPayload<Record<string, never>>;
type DbBulletin = Prisma.NewsBulletinGetPayload<Record<string, never>>;
type DbBulletinWithStories = Prisma.NewsBulletinGetPayload<{
  include: { stories: { include: { lowerThirds: true } } };
}>;
type DbWire = Prisma.NewsWireItemGetPayload<Record<string, never>>;
type DbMosDevice = Prisma.NewsMosDeviceGetPayload<Record<string, never>>;
type DbMosJob = Prisma.NewsMosJobGetPayload<Record<string, never>>;

export function serializeLowerThird(lt: DbLowerThird): NewsLowerThird {
  return {
    id: lt.id,
    storyId: lt.storyId,
    kind: lt.kind as NewsLowerThirdKind,
    orderIndex: lt.orderIndex,
    title: lt.title,
    line1: lt.line1,
    line2: lt.line2,
  };
}

export function serializeStory(story: DbStory): NewsStory {
  return {
    id: story.id,
    bulletinId: story.bulletinId,
    orderIndex: story.orderIndex,
    title: story.title,
    displayName: story.displayName,
    storyType: story.storyType as NewsStoryType,
    clipDurationSec: story.clipDurationSec,
    anchorName: story.anchorName,
    description: story.description,
    prompterText: story.prompterText,
    newsGroup: story.newsGroup,
    sourceStoryId: story.sourceStoryId,
    locked: story.locked,
    lockedBy: story.lockedBy,
    version: story.version,
    createdBy: story.createdBy,
    updatedBy: story.updatedBy,
    createdAt: story.createdAt.toISOString(),
    updatedAt: story.updatedAt.toISOString(),
    lowerThirds: [...story.lowerThirds]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map(serializeLowerThird),
  };
}

export function serializeBulletin(
  bulletin: DbBulletin | DbBulletinWithStories,
  extra?: { storyCount?: number; totalDurationSec?: number },
): NewsBulletin {
  const stories = 'stories' in bulletin ? bulletin.stories : undefined;
  return {
    id: bulletin.id,
    name: bulletin.name,
    bulletinCode: bulletin.bulletinCode,
    bulletinDate: dateOnly(bulletin.bulletinDate),
    onAirMinute: bulletin.onAirMinute,
    anchorName: bulletin.anchorName,
    newsGroup: bulletin.newsGroup,
    status: bulletin.status as NewsBulletin['status'],
    version: bulletin.version,
    createdBy: bulletin.createdBy,
    updatedBy: bulletin.updatedBy,
    createdAt: bulletin.createdAt.toISOString(),
    updatedAt: bulletin.updatedAt.toISOString(),
    storyCount: extra?.storyCount ?? stories?.length,
    totalDurationSec:
      extra?.totalDurationSec ??
      stories?.reduce((sum, s) => sum + (s.clipDurationSec ?? 0), 0),
    stories: stories
      ? [...stories].sort((a, b) => a.orderIndex - b.orderIndex).map(serializeStory)
      : undefined,
  };
}

export function serializeWire(wire: DbWire): NewsWireItem {
  return {
    id: wire.id,
    source: wire.source,
    externalId: wire.externalId,
    category: wire.category,
    priority: wire.priority as NewsWirePriority,
    headline: wire.headline,
    body: wire.body,
    receivedAt: wire.receivedAt.toISOString(),
    usedStoryId: wire.usedStoryId,
  };
}

export function serializeMosDevice(d: DbMosDevice): NewsMosDevice {
  return {
    id: d.id,
    name: d.name,
    kind: d.kind as NewsMosDeviceKind,
    host: d.host,
    port: d.port,
    mosId: d.mosId,
    ncsId: d.ncsId,
    templateMap: (d.templateMap as Record<string, unknown> | null) ?? null,
    active: d.active,
  };
}

export function serializeMosJob(j: DbMosJob): NewsMosJob {
  return {
    id: j.id,
    storyId: j.storyId,
    lowerThirdId: j.lowerThirdId,
    deviceId: j.deviceId,
    action: j.action as NewsMosAction,
    payloadXml: j.payloadXml,
    status: j.status as NewsMosJobStatus,
    attempts: j.attempts,
    error: j.error,
    sentAt: j.sentAt ? j.sentAt.toISOString() : null,
    createdBy: j.createdBy,
    createdAt: j.createdAt.toISOString(),
  };
}

/** Soft-delete query filtreleri için ortak where parçası. */
export const NOT_DELETED = { deletedAt: null } as const;

/** include: bülten detayında story + KJ/SPOT sıralı getir. */
export const BULLETIN_DETAIL_INCLUDE = {
  stories: {
    where: NOT_DELETED,
    orderBy: { orderIndex: 'asc' as const },
    include: { lowerThirds: { orderBy: { orderIndex: 'asc' as const } } },
  },
} satisfies Prisma.NewsBulletinInclude;

export const STORY_DETAIL_INCLUDE = {
  lowerThirds: { orderBy: { orderIndex: 'asc' as const } },
} satisfies Prisma.NewsStoryInclude;

/** Standart statusCode'lu hata fırlatıcı (global error handler matrisine uyar). */
export function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}
