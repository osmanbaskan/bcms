import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';

// ORTA-API-1.9.4 fix (2026-05-04): finite + makul aralık zorunluluğu.
// Eski hâl: z.number() Infinity ve NaN'ı kabul ediyordu. Yayıncılık
// pratiğindeki saha sınırlarına yakın aralıklar:
//   - signalDb: 0–120 dBm (tipik 50–65)
//   - snr: -10 .. +60 dB (tipik 20–30)
//   - ber: 0 .. 1 (oran)
//   - audioLufs: -100 .. +10 LUFS (EBU R128: -23 ideal)
const submitSchema = z.object({
  channelId: z.number().int().positive(),
  signalDb:  z.number().finite().min(0).max(120).optional(),
  snr:       z.number().finite().min(-10).max(60).optional(),
  ber:       z.number().finite().min(0).max(1).optional(),
  audioLufs: z.number().finite().min(-100).max(10).optional(),
  status:    z.enum(['OK', 'DEGRADED', 'LOST']).default('OK'),
  source:    z.string().max(50).optional(),
});

// ORTA-API-1.9.5 fix (2026-05-04): auto-incident dedup.
// Flapping signal'de saniyede 10+ incident yaratmasın diye in-memory
// rate-limit. Aynı (channelId, status) için 60sn'de bir incident.
// Kapsam: bu API instance'ı; restart'ta sıfırlanır (kabul edilebilir,
// gerçek dedup üst katmanda Prisma uniq index ile incident_dedup_key olur).
const incidentDedupCache = new Map<string, number>();
const INCIDENT_DEDUP_WINDOW_MS = 60_000;
function shouldCreateIncident(channelId: number, status: string): boolean {
  const key = `${channelId}:${status}`;
  const now = Date.now();
  const last = incidentDedupCache.get(key) ?? 0;
  if (now - last < INCIDENT_DEDUP_WINDOW_MS) return false;
  incidentDedupCache.set(key, now);
  // Cache 1000+ entry olursa eski entry'leri temizle (TTL bazlı).
  if (incidentDedupCache.size > 1000) {
    for (const [k, ts] of incidentDedupCache.entries()) {
      if (now - ts > INCIDENT_DEDUP_WINDOW_MS) incidentDedupCache.delete(k);
    }
  }
  return true;
}

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

    // MED-API-008 fix (2026-05-05): take cap dinamik. Default 1 okuma/10sn,
    // ama daha hızlı sample rate'te overflow ediyor. Hard upper bound 1500
    // (1 saat × 25 saniyede bir = 144, 5sn = 720, 2.5sn = 1440 — pratikteki
    // tüm rates için yeterli). DB cost: 1500 row × ~200 byte = ~300KB/req.
    return app.prisma.signalTelemetry.findMany({
      where: { channelId, measuredAt: { gte: since } },
      orderBy: { measuredAt: 'asc' },
      take: 1500,
    });
  });

  // POST /api/v1/signals — MCR ekipmanından veya simülatörden yeni okuma
  app.post('/', {
    preHandler: app.requireGroup(...PERMISSIONS.monitoring.write),
    schema: { tags: ['Signals'], summary: 'Yeni sinyal telemetri kaydı oluştur' },
  }, async (request, reply) => {
    const dto = submitSchema.parse(request.body);

    // ORTA-API hijyen (2026-05-04): channel existence pre-check.
    // Foreign key violation P2003 yerine açık 404 — UI hata mesajı net.
    const ch = await app.prisma.channel.findUnique({
      where: { id: dto.channelId },
      select: { id: true, active: true },
    });
    if (!ch) throw Object.assign(new Error('Channel bulunamadı'), { statusCode: 404 });
    if (!ch.active) throw Object.assign(new Error('Channel pasif — telemetri kabul edilmiyor'), { statusCode: 409 });

    const record = await app.prisma.signalTelemetry.create({ data: dto });

    // DEGRADED veya LOST ise otomatik incident oluştur (ORTA-API-1.9.5: dedup'lu)
    if (dto.status !== 'OK' && shouldCreateIncident(dto.channelId, dto.status)) {
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
        // DÜŞÜK-API-1.9.6: P2002/P2004 sessiz catch yerine metric/log.
        if (!isDuplicateSignalIncident(error)) throw error;
        app.log.warn({ channelId: dto.channelId, status: dto.status }, 'Auto-incident duplicate (DB unique) — silindi');
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
      // LOW-API-022 fix (2026-05-05): cast'lere gerek yok; +(toExponential(2))
      // zaten number döner.
      const ber       = +(Math.random() * 1e-6).toExponential(2);
      const audioLufs = +(Math.random() * 6 - 23).toFixed(1);    // -23 ± 3 LUFS
      const status    = signalDb < 57 ? 'DEGRADED' : 'OK';

      return app.prisma.signalTelemetry.create({
        data: { channelId: ch.id, signalDb, snr, ber, audioLufs, status, source: 'SIMULATOR' },
      });
    }));

    reply.status(201).send(records);
  });
}
