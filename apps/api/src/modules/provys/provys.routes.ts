import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  PROVYS_CHANNELS,
  PROVYS_CHANNEL_SLUGS,
  type ProvysItemDto,
  type ProvysStreamEvent,
} from '@bcms/shared';
import { closeProvysPgListener, getProvysPgListener } from './provys.pg-listener.js';

const channelQuerySchema = z.object({
  channel: z.enum(PROVYS_CHANNEL_SLUGS as [string, ...string[]]),
});

const itemDtoSchema = z.object({
  id: z.number().int(),
  channelSlug: z.enum(PROVYS_CHANNEL_SLUGS as [string, ...string[]]),
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

function rowsToDto(rows: Array<{
  id: number;
  channelSlug: string;
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

async function fetchChannelSnapshot(
  app: FastifyInstance,
  channelSlug: string,
): Promise<ProvysItemDto[]> {
  const rows = await app.prisma.provysItem.findMany({
    where: { channelSlug },
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

  // GET /api/v1/provys/items?channel=<slug>
  app.get('/items', {
    preHandler: app.requireGroup(...PERMISSIONS.provys.read),
    schema: { tags: ['Provys'], summary: 'Kanalın current akış listesi' },
  }, async (request: FastifyRequest) => {
    const parsed = channelQuerySchema.parse(request.query);
    const items = await fetchChannelSnapshot(app, parsed.channel);
    return itemsResponseSchema.parse(items);
  });

  // GET /api/v1/provys/stream — SSE
  // Bearer JWT cookie tabanlı değil; native EventSource Authorization header
  // setleyemez → client tarafında fetch-streaming SSE reader kullanılır
  // (frontend: provys-sse.client.ts). Token query param'a YAZILMAZ.
  // requireGroup zaten preHandler'da kontrol eder.
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

    // İlk snapshot — tüm kanalların güncel hali (UI 6 tab'ı tek bağlantıyla besler).
    for (const channel of PROVYS_CHANNELS) {
      const items = await fetchChannelSnapshot(app, channel.slug);
      writeEvent({ type: 'snapshot', channel: channel.slug, items });
    }

    const listener = getProvysPgListener(databaseUrl, app.log);
    let unsubscribe: (() => Promise<void>) | null = null;
    try {
      unsubscribe = await listener.subscribe((payload) => {
        // Notify alındı — etkilenen kanalı yeniden oku ve push'la.
        fetchChannelSnapshot(app, payload.channelSlug)
          .then((items) => writeEvent({
            type: 'update',
            channel: payload.channelSlug as ProvysItemDto['channelSlug'],
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

    // Fastify'ın "lifecycle bitti" sayması için reply tamamlanmadan tutuyoruz.
    // Hijack: raw yanıt kullanılıyor.
    reply.hijack();
  });

  app.addHook('onClose', async () => {
    await closeProvysPgListener();
  });
}
