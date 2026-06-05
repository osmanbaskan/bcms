import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, type SendToAirResult } from '@bcms/shared';
import {
  NOT_DELETED,
  currentUser,
  httpError,
  serializeMosDevice,
  serializeMosJob,
} from './news.service.js';
import { buildMosXml, type MosBuildInput } from './news-mos.xml.js';

const deviceKindSchema = z.enum(['MOS_TCP', 'VIZRT_REST', 'XML_FILE']);
const actionSchema = z.enum(['KJ', 'SPOT', 'CRAWL', 'ROLL']);

const createDeviceSchema = z.object({
  name: z.string().min(1).max(120),
  kind: deviceKindSchema,
  host: z.string().max(200).nullish(),
  port: z.number().int().min(1).max(65_535).nullish(),
  mosId: z.string().max(120).nullish(),
  ncsId: z.string().max(120).nullish(),
  templateMap: z.record(z.string(), z.unknown()).nullish(),
  active: z.boolean().optional(),
});
const updateDeviceSchema = createDeviceSchema.partial();

const sendSchema = z.object({
  action: actionSchema,
  lowerThirdId: z.number().int().positive().optional(),
  deviceId: z.number().int().positive().nullish(),
  dryRun: z.boolean().optional(),
});

const jobsQuerySchema = z.object({
  status: z.enum(['PENDING', 'SENT', 'FAILED']).optional(),
  storyId: z.coerce.number().int().positive().optional(),
});

/**
 * MOS / Vizrt çıkış route'ları — /api/v1/news.
 *  - /mos/devices*  : çıkış cihazı config (admin)
 *  - /mos/jobs      : gönderim işleri / durum (read)
 *  - /stories/:id/send : KJ/SPOT/CRAWL/ROLL "Yayına Gönder" (send) + dry-run
 */
export async function mosRoutes(app: FastifyInstance) {
  // ---- Cihaz config (admin) ----
  app.get('/mos/devices', {
    preHandler: app.requireGroup(...PERMISSIONS.news.admin),
    schema: { tags: ['News'], summary: 'MOS/Vizrt çıkış cihazlarını listele' },
  }, async () => {
    const devices = await app.prisma.newsMosDevice.findMany({
      where: NOT_DELETED, orderBy: { name: 'asc' },
    });
    return devices.map(serializeMosDevice);
  });

  app.post('/mos/devices', {
    preHandler: app.requireGroup(...PERMISSIONS.news.admin),
    schema: { tags: ['News'], summary: 'MOS/Vizrt çıkış cihazı ekle' },
  }, async (request, reply) => {
    const dto = createDeviceSchema.parse(request.body);
    const created = await app.prisma.newsMosDevice.create({
      data: {
        name: dto.name,
        kind: dto.kind,
        host: dto.host ?? null,
        port: dto.port ?? null,
        mosId: dto.mosId ?? null,
        ncsId: dto.ncsId ?? null,
        templateMap: (dto.templateMap ?? undefined) as object | undefined,
        active: dto.active ?? true,
      },
    });
    reply.status(201);
    return serializeMosDevice(created);
  });

  app.patch<{ Params: { id: string } }>('/mos/devices/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.news.admin),
    schema: { tags: ['News'], summary: 'MOS/Vizrt çıkış cihazı güncelle' },
  }, async (request) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const dto = updateDeviceSchema.parse(request.body);
    const exists = await app.prisma.newsMosDevice.findFirst({ where: { id, ...NOT_DELETED }, select: { id: true } });
    if (!exists) throw httpError(404, 'Cihaz bulunamadı');
    const updated = await app.prisma.newsMosDevice.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
        ...(dto.host !== undefined ? { host: dto.host ?? null } : {}),
        ...(dto.port !== undefined ? { port: dto.port ?? null } : {}),
        ...(dto.mosId !== undefined ? { mosId: dto.mosId ?? null } : {}),
        ...(dto.ncsId !== undefined ? { ncsId: dto.ncsId ?? null } : {}),
        ...(dto.templateMap !== undefined ? { templateMap: (dto.templateMap ?? undefined) as object | undefined } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
    return serializeMosDevice(updated);
  });

  app.delete<{ Params: { id: string } }>('/mos/devices/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.news.admin),
    schema: { tags: ['News'], summary: 'MOS/Vizrt çıkış cihazı sil (soft)' },
  }, async (request, reply) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const exists = await app.prisma.newsMosDevice.findFirst({ where: { id, ...NOT_DELETED }, select: { id: true } });
    if (!exists) throw httpError(404, 'Cihaz bulunamadı');
    await app.prisma.newsMosDevice.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
    reply.status(204);
    return null;
  });

  // ---- Gönderim işleri (read) ----
  app.get('/mos/jobs', {
    preHandler: app.requireGroup(...PERMISSIONS.news.read),
    schema: { tags: ['News'], summary: 'MOS gönderim işleri / durum' },
  }, async (request) => {
    const q = jobsQuerySchema.parse(request.query);
    const jobs = await app.prisma.newsMosJob.findMany({
      where: { ...(q.status ? { status: q.status } : {}), ...(q.storyId ? { storyId: q.storyId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return jobs.map(serializeMosJob);
  });

  // ---- "Yayına Gönder" (send) + dry-run önizleme ----
  app.post<{ Params: { id: string } }>('/stories/:id/send', {
    preHandler: app.requireGroup(...PERMISSIONS.news.send),
    schema: { tags: ['News'], summary: 'KJ/SPOT/CRAWL/ROLL yayına gönder (MOS/Vizrt) — dryRun ile önizleme' },
  }, async (request): Promise<SendToAirResult> => {
    const storyId = z.coerce.number().int().positive().parse(request.params.id);
    const dto = sendSchema.parse(request.body);

    const story = await app.prisma.newsStory.findFirst({
      where: { id: storyId, ...NOT_DELETED },
      select: { id: true, title: true, description: true, prompterText: true },
    });
    if (!story) throw httpError(404, 'Haber bulunamadı');

    // KJ/SPOT için lowerThird zorunlu; CRAWL/ROLL story metnini kullanır.
    let lt: { id: number; title: string | null; line1: string | null; line2: string | null } | null = null;
    if (dto.action === 'KJ' || dto.action === 'SPOT') {
      if (!dto.lowerThirdId) throw httpError(400, `${dto.action} göndermek için lowerThirdId gerekli`);
      lt = await app.prisma.newsLowerThird.findFirst({
        where: { id: dto.lowerThirdId, storyId },
        select: { id: true, title: true, line1: true, line2: true },
      });
      if (!lt) throw httpError(404, 'KJ/SPOT (lower-third) bulunamadı');
    }

    // Cihaz çöz: deviceId verildiyse onu, yoksa ilk aktif cihaz, o da yoksa null (dry-run).
    const device = dto.deviceId
      ? await app.prisma.newsMosDevice.findFirst({ where: { id: dto.deviceId, active: true, ...NOT_DELETED } })
      : await app.prisma.newsMosDevice.findFirst({ where: { active: true, ...NOT_DELETED }, orderBy: { id: 'asc' } });
    if (dto.deviceId && !device) throw httpError(404, 'Çıkış cihazı bulunamadı / aktif değil');

    const input: MosBuildInput = {
      action: dto.action,
      deviceKind: device?.kind ?? 'VIZRT_REST',
      mosId: device?.mosId ?? null,
      ncsId: device?.ncsId ?? null,
      templateMap: (device?.templateMap as Record<string, unknown> | null) ?? null,
      storyId: story.id,
      storyTitle: story.title,
      title: lt?.title ?? null,
      line1: lt?.line1 ?? null,
      line2: lt?.line2 ?? null,
      text: story.description ?? story.prompterText ?? story.title,
    };
    const previewXml = buildMosXml(input);

    // dry-run ya da cihaz yok → sadece önizleme (job oluşturma).
    if (dto.dryRun || !device) {
      return { job: null, previewXml, dryRun: true };
    }

    const job = await app.prisma.newsMosJob.create({
      data: {
        storyId: story.id,
        lowerThirdId: lt?.id ?? null,
        deviceId: device.id,
        action: dto.action,
        payloadXml: previewXml,
        status: 'PENDING',
        createdBy: currentUser(request),
      },
    });
    return { job: serializeMosJob(job), previewXml, dryRun: false };
  });
}
