import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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

export async function ingestRoutes(app: FastifyInstance) {
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

    const job = await app.prisma.ingestJob.create({
      data: {
        sourcePath: dto.sourcePath,
        targetId:   dto.targetId,
        metadata:   dto.metadata,
      },
    });

    await app.rabbitmq.publish(QUEUES.INGEST_NEW, {
      jobId:      job.id,
      sourcePath: job.sourcePath,
      targetId:   job.targetId,
    });

    reply.status(202).send(job);
  });

  // POST /webhooks/ingest/callback — Called by worker when job completes
  app.post('/callback', {
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
        create: { jobId: dto.jobId, ...dto.qcReport },
        update: dto.qcReport,
      });
    }

    await app.rabbitmq.publish(QUEUES.INGEST_COMPLETED, { jobId: dto.jobId, status: dto.status });

    reply.status(200).send(job);
  });
}
