import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { PERMISSIONS } from '@bcms/shared';

const createIngestSchema = z.object({
  sourcePath: z.string().min(1),
  targetId:   z.number().int().positive().optional(),
  metadata:   z.record(z.unknown()).optional(),
});

const callbackSchema = z.object({
  jobId:     z.number().int(),
  status:    z.enum(['PENDING', 'PROCESSING', 'PROXY_GEN', 'QC', 'COMPLETED', 'FAILED']),
  proxyPath: z.string().optional(),
  checksum:  z.string().optional(),
  errorMsg:  z.string().optional(),
  qcReport:  z.object({
    codec:      z.string().optional(),
    resolution: z.string().optional(),
    duration:   z.number().optional(),
    frameRate:  z.number().optional(),
    bitrate:    z.number().int().optional(),
    loudness:   z.number().optional(),
    errors:     z.array(z.unknown()).optional(),
    warnings:   z.array(z.unknown()).optional(),
    passed:     z.boolean(),
  }).optional(),
});

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

export async function ingestRoutes(app: FastifyInstance) {
  const requireWorkerSecret = async (request: { headers: Record<string, string | string[] | undefined> }) => {
    const expected = process.env.INGEST_CALLBACK_SECRET;
    if (!expected) {
      throw Object.assign(new Error('Ingest callback secret is not configured'), { statusCode: 503 });
    }

    const rawHeader = request.headers['x-bcms-worker-secret'];
    const received = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!received || !safeEqual(received, expected)) {
      throw Object.assign(new Error('Invalid ingest callback secret'), { statusCode: 401 });
    }
  };

  // GET /api/v1/ingest
  app.get('/', {
    preHandler: app.requireRole(...PERMISSIONS.ingest.read),
    schema: { tags: ['Ingest'] },
  }, async (request) => {
    const q = request.query as { status?: string; page?: string; pageSize?: string };
    const page     = q.page     ? Number(q.page)     : 1;
    const pageSize = q.pageSize ? Number(q.pageSize) : 50;
    const skip = (page - 1) * pageSize;

    const where = q.status ? { status: q.status as never } : {};
    const [data, total] = await Promise.all([
      app.prisma.ingestJob.findMany({ where, skip, take: pageSize, include: { qcReport: true }, orderBy: { createdAt: 'desc' } }),
      app.prisma.ingestJob.count({ where }),
    ]);
    return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  });

  // GET /api/v1/ingest/:id
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireRole(...PERMISSIONS.ingest.read),
    schema: { tags: ['Ingest'] },
  }, async (request) => {
    const job = await app.prisma.ingestJob.findUnique({
      where: { id: Number(request.params.id) },
      include: { qcReport: true },
    });
    if (!job) throw Object.assign(new Error('Ingest job not found'), { statusCode: 404 });
    return job;
  });

  // POST /api/v1/ingest — Trigger new ingest job (watch folder or manual)
  app.post('/', {
    preHandler: app.requireRole(...PERMISSIONS.ingest.write),
    schema: { tags: ['Ingest'], summary: 'Trigger a new ingest job' },
  }, async (request, reply) => {
    const dto = createIngestSchema.parse(request.body);

    if (dto.targetId) {
      const schedule = await app.prisma.schedule.findFirst({
        where: { id: dto.targetId, usageScope: 'live-plan' },
        select: { id: true },
      });
      if (!schedule) {
        throw Object.assign(new Error('Ingest hedefi canlı yayın planı kaydı olmalıdır'), { statusCode: 400 });
      }
    }

    const job = await app.prisma.ingestJob.create({
      data: {
        sourcePath: dto.sourcePath,
        targetId:   dto.targetId,
        metadata:   dto.metadata as Prisma.InputJsonValue,
      },
    });

    await app.rabbitmq.publish(QUEUES.INGEST_NEW, {
      jobId:      job.id,
      sourcePath: job.sourcePath,
      targetId:   job.targetId,
    });

    reply.status(202).send(job);
  });

  // DELETE /api/v1/ingest/:id
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireRole(...PERMISSIONS.ingest.delete),
    schema: { tags: ['Ingest'], summary: 'Delete ingest job' },
  }, async (request, reply) => {
    const id = Number(request.params.id);
    const job = await app.prisma.ingestJob.findUnique({ where: { id } });
    if (!job) throw Object.assign(new Error('Ingest job not found'), { statusCode: 404 });
    if (job.status === 'PROCESSING' || job.status === 'PROXY_GEN' || job.status === 'QC') {
      throw Object.assign(new Error('Aktif iş silinemez'), { statusCode: 409 });
    }
    await app.prisma.ingestJob.delete({ where: { id } });
    reply.status(204).send();
  });

  // POST /webhooks/ingest/callback — Called by worker when job completes
  app.post('/callback', {
    preHandler: requireWorkerSecret,
    schema: { tags: ['Ingest'], summary: 'Worker callback on job completion' },
  }, async (request, reply) => {
    const dto = callbackSchema.parse(request.body);

    const job = await app.prisma.ingestJob.update({
      where: { id: dto.jobId },
      data: {
        status:     dto.status,
        proxyPath:  dto.proxyPath,
        checksum:   dto.checksum,
        errorMsg:   dto.errorMsg,
        finishedAt: ['COMPLETED', 'FAILED'].includes(dto.status) ? new Date() : undefined,
      },
    });

    if (dto.qcReport) {
      await app.prisma.qcReport.upsert({
        where:  { jobId: dto.jobId },
        create: { jobId: dto.jobId, ...dto.qcReport, errors: dto.qcReport.errors as Prisma.InputJsonValue, warnings: dto.qcReport.warnings as Prisma.InputJsonValue },
        update: { ...dto.qcReport, errors: dto.qcReport.errors as Prisma.InputJsonValue, warnings: dto.qcReport.warnings as Prisma.InputJsonValue },
      });
    }

    await app.rabbitmq.publish(QUEUES.INGEST_COMPLETED, { jobId: dto.jobId, status: dto.status });

    reply.status(200).send(job);
  });
}
