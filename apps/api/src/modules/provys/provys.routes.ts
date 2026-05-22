import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  PROVYS_CHANNELS,
  PROVYS_CHANNEL_SLUGS,
  type ProvysItemDto,
  type ProvysStreamEvent,
} from '@bcms/shared';
import { istanbulTodayDate } from '../../core/tz.js';
import { closeProvysPgListener, getProvysPgListener } from './provys.pg-listener.js';
import {
  exportFilename,
  exportProvysToExcelBuffer,
  exportProvysToPdfBuffer,
  type ProvysExportRow,
} from './provys.export.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const channelQuerySchema = z.object({
  channel: z.enum(PROVYS_CHANNEL_SLUGS as [string, ...string[]]),
});

const channelDateQuerySchema = z.object({
  channel: z.enum(PROVYS_CHANNEL_SLUGS as [string, ...string[]]),
  // Default: Europe/Istanbul bugünün tarihi. UI date picker tarihi sağlar.
  date: z.string().regex(ISO_DATE_RE).optional(),
});

const CATEGORY_ENUM = ['REKLAM', 'KAMU_SPOTU', 'CANLI', 'PROGRAM', 'TANITIM', 'DIGER'] as const;

const exportQuerySchema = z.object({
  channel: z.enum(PROVYS_CHANNEL_SLUGS as [string, ...string[]]),
  date: z.string().regex(ISO_DATE_RE).optional(),
  /**
   * Virgül-ayrımlı kategori listesi (örn. `REKLAM,CANLI,PROGRAM`). Opsiyonel;
   * verilmezse tüm kategoriler dahil edilir. Tek geçersiz değer dahi 400.
   */
  categories: z.string().optional().refine((s) => {
    if (s === undefined || s === '') return true;
    return s.split(',').every((c) => (CATEGORY_ENUM as readonly string[]).includes(c.trim()));
  }, { message: 'Invalid category in categories parameter' }),
});

function parseCategoriesFilter(value: string | undefined): ReadonlySet<string> | null {
  if (!value) return null;
  const set = new Set(value.split(',').map((c) => c.trim()).filter(Boolean));
  if (set.size === 0) return null;
  return set;
}

const itemDtoSchema = z.object({
  id: z.number().int(),
  channelSlug: z.enum(PROVYS_CHANNEL_SLUGS as [string, ...string[]]),
  scheduleDate: z.string().regex(ISO_DATE_RE),
  eventId: z.string(),
  sequence: z.number().int(),
  startAt: z.string(),
  durationMs: z.number().int().nullable(),
  startTimecode: z.string().nullable(),
  durationTimecode: z.string().nullable(),
  frameRate: z.number().int().nullable(),
  dcCode: z.string().nullable(),
  title: z.string(),
  rawKind: z.string().nullable(),
  category: z.enum(['REKLAM', 'KAMU_SPOTU', 'CANLI', 'PROGRAM', 'TANITIM', 'DIGER']),
  sourceFile: z.string(),
  updatedAt: z.string(),
});
const itemsResponseSchema = z.array(itemDtoSchema);

function dateToIso(d: Date): string {
  // @db.Date sütunu UTC midnight olarak okunur — slice 0..10 doğru günü verir.
  return d.toISOString().slice(0, 10);
}

function rowsToDto(rows: Array<{
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
}>): ProvysItemDto[] {
  return rows.map((r) => ({
    id: r.id,
    channelSlug: r.channelSlug as ProvysItemDto['channelSlug'],
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
    category: r.category as ProvysItemDto['category'],
    sourceFile: r.sourceFile,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

async function fetchChannelDateSnapshot(
  app: FastifyInstance,
  channelSlug: string,
  scheduleDate: string,
): Promise<ProvysItemDto[]> {
  const dt = new Date(`${scheduleDate}T00:00:00Z`);
  const rows = await app.prisma.provysItem.findMany({
    where: { channelSlug, scheduleDate: dt },
    orderBy: [{ sequence: 'asc' }, { startAt: 'asc' }],
  });
  return rowsToDto(rows);
}

export async function provysRoutes(app: FastifyInstance) {
  // GET /api/v1/provys/channels
  app.get('/channels', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'Provys kanal kataloğu' },
  }, async () => {
    return PROVYS_CHANNELS.map((c) => ({
      fileCode: c.fileCode,
      slug: c.slug,
      displayName: c.displayName,
    }));
  });

  // GET /api/v1/provys/items?channel=<slug>&date=YYYY-MM-DD
  // `date` opsiyonel — default Europe/Istanbul bugünün tarihi.
  app.get('/items', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'Kanalın seçili güne ait akış listesi' },
  }, async (request: FastifyRequest) => {
    const parsed = channelDateQuerySchema.parse(request.query);
    const date = parsed.date ?? istanbulTodayDate();
    const items = await fetchChannelDateSnapshot(app, parsed.channel, date);
    return itemsResponseSchema.parse(items);
  });

  // GET /api/v1/provys/export/excel?channel=<slug>&date=YYYY-MM-DD&categories=REKLAM,CANLI,...
  // `categories` opsiyonel — verilmezse tüm kategoriler dahil; verilirse
  // sadece o kategorilerdeki satırlar export'a yansır (UI filtre paritesi).
  app.get('/export/excel', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'Excel export — kanal × gün snapshot (kategori filtreli)' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = exportQuerySchema.parse(request.query);
    const date = parsed.date ?? istanbulTodayDate();
    const allow = parseCategoriesFilter(parsed.categories);
    const items = await fetchChannelDateSnapshot(app, parsed.channel, date);
    const rows: ProvysExportRow[] = items
      .filter((i) => !allow || allow.has(i.category))
      .map((i) => ({
        sequence: i.sequence,
        startTimecode: i.startTimecode,
        durationTimecode: i.durationTimecode,
        dcCode: i.dcCode,
        title: i.title,
        category: i.category,
        rawKind: i.rawKind,
        sourceFile: i.sourceFile,
      }));
    const buf = await exportProvysToExcelBuffer({ channelSlug: parsed.channel, scheduleDate: date, rows });
    const filename = exportFilename(parsed.channel, date, 'xlsx');
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(buf);
  });

  // GET /api/v1/provys/export/pdf?channel=<slug>&date=YYYY-MM-DD&categories=...
  app.get('/export/pdf', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'PDF export — kanal × gün snapshot (kategori filtreli)' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = exportQuerySchema.parse(request.query);
    const date = parsed.date ?? istanbulTodayDate();
    const allow = parseCategoriesFilter(parsed.categories);
    const items = await fetchChannelDateSnapshot(app, parsed.channel, date);
    const rows: ProvysExportRow[] = items
      .filter((i) => !allow || allow.has(i.category))
      .map((i) => ({
        sequence: i.sequence,
        startTimecode: i.startTimecode,
        durationTimecode: i.durationTimecode,
        dcCode: i.dcCode,
        title: i.title,
        category: i.category,
        rawKind: i.rawKind,
        sourceFile: i.sourceFile,
      }));
    const buf = await exportProvysToPdfBuffer({ channelSlug: parsed.channel, scheduleDate: date, rows });
    const filename = exportFilename(parsed.channel, date, 'pdf');
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(buf);
  });

  // GET /api/v1/provys/dates?channel=<slug>
  // O kanal için DB'de bulunan tüm yayın günlerini (en yeniden eskiye) döner.
  app.get('/dates', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'Kanal için mevcut yayın günleri' },
  }, async (request: FastifyRequest) => {
    const parsed = channelQuerySchema.parse(request.query);
    const rows = await app.prisma.provysItem.findMany({
      where: { channelSlug: parsed.channel },
      select: { scheduleDate: true },
      distinct: ['scheduleDate'],
      orderBy: { scheduleDate: 'desc' },
    });
    return rows.map((r) => dateToIso(r.scheduleDate));
  });

  // GET /api/v1/provys/stream — SSE
  // Native EventSource Authorization header setleyemez → client tarafında
  // fetch-streaming reader (Bearer JWT). Token query param'a YAZILMAZ.
  // SSE sadece update + heartbeat yayar; initial snapshot REST `/items`.
  // Client kendi state'inde aktif (channel, date) filtreleyerek uygular.
  app.get('/stream', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    config: { rateLimit: false },
    schema: { tags: ['Provys'], summary: 'Akış değişiklik bildirimleri (SSE)' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const databaseUrl = process.env.DATABASE_URL ?? '';
    if (!databaseUrl) {
      return reply.code(500).send({ message: 'DATABASE_URL set edilmemiş' });
    }

    reply.raw.statusCode = 200;
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const writeEvent = (event: ProvysStreamEvent): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const writeComment = (text: string): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`: ${text}\n\n`);
    };

    const listener = getProvysPgListener(databaseUrl, app.log);
    let unsubscribe: (() => Promise<void>) | null = null;
    try {
      unsubscribe = await listener.subscribe((payload) => {
        const channelSlug = payload.channelSlug;
        const scheduleDate = payload.scheduleDate;
        if (!channelSlug || !scheduleDate || !ISO_DATE_RE.test(scheduleDate)) return;
        fetchChannelDateSnapshot(app, channelSlug, scheduleDate)
          .then((items) => writeEvent({
            type: 'update',
            channel: channelSlug as ProvysItemDto['channelSlug'],
            scheduleDate,
            items,
          }))
          .catch((err) => app.log.warn({ err, payload }, 'Provys SSE: snapshot fetch hatası'));
      });
    } catch (err) {
      app.log.error({ err }, 'Provys SSE: pg listener subscribe hatası');
      reply.raw.end();
      return;
    }

    const heartbeatMs = Number(process.env.PROVYS_SSE_HEARTBEAT_MS ?? '25000');
    const heartbeat = setInterval(() => {
      writeComment('hb');
      writeEvent({ type: 'heartbeat', ts: Date.now() });
    }, heartbeatMs);
    heartbeat.unref();

    const cleanup = async (): Promise<void> => {
      clearInterval(heartbeat);
      if (unsubscribe) {
        try { await unsubscribe(); } catch (err) {
          app.log.warn({ err }, 'Provys SSE: listener cleanup hatası');
        }
        unsubscribe = null;
      }
    };

    request.raw.on('close', () => { void cleanup(); });
    reply.raw.on('close', () => { void cleanup(); });
    request.raw.on('error', () => { void cleanup(); });

    reply.hijack();
  });

  app.addHook('onClose', async () => {
    await closeProvysPgListener();
  });
}
