import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';

const submitSchema = z.object({
  channelId: z.number().int().positive(),
  signalDb:  z.number().optional(),
  snr:       z.number().optional(),
  ber:       z.number().min(0).optional(),
  audioLufs: z.number().optional(),
  status:    z.enum(['OK', 'DEGRADED', 'LOST']).default('OK'),
  source:    z.string().max(50).optional(),
});

function isDuplicateSignalIncident(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2004'].includes(error.code);
}

export async function signalRoutes(app: FastifyInstance) {
  // GET /api/v1/signals/latest — Her kanal için en son okunan telemetri
  app.get('/latest', {
    preHandler: app.requireGroup(...PERMISSIONS.monitoring.read),
    schema: { tags: ['Signals'], summary: 'En son sinyal okumalarını getir (kanal başına)' },
  }, async () => {
    // Her kanal için en güncel kaydı getir
    const channels = await app.prisma.channel.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        type: true,
        telemetry: {
          orderBy: { measuredAt: 'desc' },
          take: 1,
        },
      },
    });

    return channels.map((ch) => ({
      channelId:  ch.id,
      channelName: ch.name,
      channelType: ch.type,
      telemetry:  ch.telemetry[0] ?? null,
    }));
  });

  // GET /api/v1/signals/:channelId/history — Geçmiş okumalar (son 1 saat)
  app.get<{ Params: { channelId: string } }>('/:channelId/history', {
    preHandler: app.requireGroup(...PERMISSIONS.monitoring.read),
    schema: { tags: ['Signals'], summary: 'Kanal sinyal geçmişi (son 1 saat)' },
  }, async (request) => {
    const channelId = z.coerce.number().int().positive().parse(request.params.channelId);
    const since = new Date(Date.now() - 60 * 60 * 1000);

    return app.prisma.signalTelemetry.findMany({
      where: { channelId, measuredAt: { gte: since } },
      orderBy: { measuredAt: 'asc' },
      take: 360, // max 1 okuma/10 sn → 360 kayıt
    });
  });

  // POST /api/v1/signals — MCR ekipmanından veya simülatörden yeni okuma
  app.post('/', {
    preHandler: app.requireGroup(...PERMISSIONS.monitoring.write),
    schema: { tags: ['Signals'], summary: 'Yeni sinyal telemetri kaydı oluştur' },
  }, async (request, reply) => {
    const dto = submitSchema.parse(request.body);

    const record = await app.prisma.signalTelemetry.create({ data: dto });

    // DEGRADED veya LOST ise otomatik incident oluştur
    if (dto.status !== 'OK') {
      const severity = dto.status === 'LOST' ? 'CRITICAL' : 'WARNING';
      const desc = dto.status === 'LOST'
        ? `Kanal sinyali kayboldu (${dto.source ?? 'bilinmiyor'})`
        : `Kanal sinyal kalitesi düştü — SNR: ${dto.snr ?? '?'} dB`;

      try {
        await app.prisma.incident.create({
          data: {
            eventType:   'SIGNAL_LOSS',
            description: desc,
            severity,
            metadata:    { channelId: dto.channelId, source: dto.source },
          },
        });
      } catch (error) {
        if (!isDuplicateSignalIncident(error)) throw error;
      }
    }

    reply.status(201).send(record);
  });

  // POST /api/v1/signals/simulate — Demo/test amaçlı rastgele telemetri üret
  app.post('/simulate', {
    preHandler: app.requireGroup(...PERMISSIONS.monitoring.write),
    schema: { tags: ['Signals'], summary: 'Tüm aktif kanallar için simüle edilmiş telemetri gönder' },
  }, async (_req, reply) => {
    if (process.env.NODE_ENV === 'production') {
      throw Object.assign(new Error('Signal simulation is not available in production'), { statusCode: 403 });
    }

    const channels = await app.prisma.channel.findMany({ where: { active: true } });

    const records = await Promise.all(channels.map(async (ch) => {
      const signalDb  = +(Math.random() * 10 + 55).toFixed(1);   // 55–65 dBm
      const snr       = +(Math.random() * 8 + 22).toFixed(1);    // 22–30 dB
      const ber       = +(Math.random() * 1e-6).toExponential(2) as unknown as number;
      const audioLufs = +(Math.random() * 6 - 23).toFixed(1);    // -23 ± 3 LUFS
      const status    = signalDb < 57 ? 'DEGRADED' : 'OK';

      return app.prisma.signalTelemetry.create({
        data: { channelId: ch.id, signalDb, snr, ber, audioLufs, status, source: 'SIMULATOR' },
      });
    }));

    reply.status(201).send(records);
  });
}
