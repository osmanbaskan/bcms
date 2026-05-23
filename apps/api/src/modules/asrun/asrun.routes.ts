import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ASRUN_CHANNELS,
  ASRUN_CHANNEL_SLUGS,
  type AsrunChannelSlug,
  type AsrunItemDto,
  type AsrunCategory,
} from '@bcms/shared';
import { PERMISSIONS } from '@bcms/shared';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const channelQuerySchema = z.object({
  channel: z.enum(ASRUN_CHANNEL_SLUGS as [string, ...string[]]),
});

const channelDateQuerySchema = z.object({
  channel: z.enum(ASRUN_CHANNEL_SLUGS as [string, ...string[]]),
  date: z.string().regex(ISO_DATE_RE).optional(),
});

function istanbulTodayDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function dateToIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface AsrunDbRow {
  id: number;
  channelSlug: string;
  scheduleDate: Date;
  eventId: string;
  sequence: number;
  startAt: Date;
  durationMs: number | null;
  startTimecode: string | null;
  durationTimecode: string | null;
  frameRate: number | null;
  dcCode: string | null;
  title: string;
  rawKind: string | null;
  category: string;
  sourceFile: string;
  updatedAt: Date;
}

function rowToDto(r: AsrunDbRow): AsrunItemDto {
  return {
    id: r.id,
    channelSlug: r.channelSlug as AsrunChannelSlug,
    scheduleDate: dateToIso(r.scheduleDate),
    eventId: r.eventId,
    sequence: r.sequence,
    startAt: r.startAt.toISOString(),
    durationMs: r.durationMs,
    startTimecode: r.startTimecode,
    durationTimecode: r.durationTimecode,
    frameRate: r.frameRate,
    dcCode: r.dcCode,
    title: r.title,
    rawKind: r.rawKind,
    category: r.category as AsrunCategory,
    sourceFile: r.sourceFile,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function asrunRoutes(app: FastifyInstance) {
  // GET /api/v1/asrun/channels — sabit kanal kataloğu
  app.get('/channels', {
    preHandler: app.requireGroup(...PERMISSIONS.asrun.read),
    schema: { tags: ['Asrun'], summary: 'Asrun kanal kataloğu' },
  }, async () => {
    return ASRUN_CHANNELS.map((c) => ({
      slug: c.slug,
      displayName: c.displayName,
      fileCode: c.fileCode,
    }));
  });

  // GET /api/v1/asrun/items?channel=<slug>&date=YYYY-MM-DD
  app.get('/items', {
    preHandler: app.requireGroup(...PERMISSIONS.asrun.read),
    schema: { tags: ['Asrun'], summary: 'Kanalın seçili güne ait as-run kayıtları' },
  }, async (request: FastifyRequest) => {
    const parsed = channelDateQuerySchema.parse(request.query);
    const date = parsed.date ?? istanbulTodayDate();
    const dt = new Date(`${date}T00:00:00Z`);
    const rows = await app.prisma.asrunItem.findMany({
      where: { channelSlug: parsed.channel, scheduleDate: dt },
      orderBy: [
        { startAt: 'asc' },
        { startTimecode: 'asc' },
        { sourceFile: 'asc' },
        { sequence: 'asc' },
      ],
    });
    return rows.map(rowToDto);
  });

  // GET /api/v1/asrun/dates?channel=<slug> — DB'de mevcut günler (newest first)
  app.get('/dates', {
    preHandler: app.requireGroup(...PERMISSIONS.asrun.read),
    schema: { tags: ['Asrun'], summary: 'Kanal için mevcut as-run günleri' },
  }, async (request: FastifyRequest) => {
    const parsed = channelQuerySchema.parse(request.query);
    const rows = await app.prisma.asrunItem.findMany({
      where: { channelSlug: parsed.channel },
      select: { scheduleDate: true },
      distinct: ['scheduleDate'],
      orderBy: { scheduleDate: 'desc' },
    });
    return rows.map((r) => dateToIso(r.scheduleDate));
  });
}
