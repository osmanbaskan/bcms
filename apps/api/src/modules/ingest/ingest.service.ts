import type { FastifyInstance } from 'fastify';
import { Prisma, type IngestJob } from '@prisma/client';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { writeShadowEvent } from '../outbox/outbox.helpers.js';
import { validateIngestSourcePath } from './ingest.paths.js';

/**
 * Madde 2+7 PR-B3b-1: manual ingest tetikleme — route handler'dan extract.
 *
 * Domain flow watcher'dan ayrı tutulur (guard #2): her ikisi de aynı outbox
 * helper'ını (writeShadowEvent) kullanır ama kendi $transaction akışını korur.
 * Manual path metadata + ingestPlanItem.updateMany() ek işlemler içerebilir;
 * watcher path saf yeni job creation.
 *
 * Route handler bu fonksiyonu çağırır. Auth (preHandler requireGroup
 * PERMISSIONS.ingest.write) route layer'ında kalır.
 *
 * Direct publish (queue.ingest.new) tx dışında, mevcut davranış korunur.
 */

export interface TriggerManualIngestDto {
  sourcePath: string;
  targetId?:  number;
  metadata?:  Record<string, unknown>;
}

export async function triggerManualIngest(
  app: FastifyInstance,
  dto: TriggerManualIngestDto,
): Promise<IngestJob> {
  const sourcePath = validateIngestSourcePath(dto.sourcePath);

  if (dto.targetId) {
    const schedule = await app.prisma.schedule.findFirst({
      where: { id: dto.targetId, usageScope: 'live-plan' },
      select: { id: true },
    });
    if (!schedule) {
      throw Object.assign(
        new Error('Ingest hedefi canlı yayın planı kaydı olmalıdır'),
        { statusCode: 400 },
      );
    }
  }

  const planSourceKey = typeof dto.metadata?.ingestPlanSourceKey === 'string'
    ? dto.metadata.ingestPlanSourceKey
    : null;

  const job = await app.prisma.$transaction(async (tx) => {
    const created = await tx.ingestJob.create({
      data: {
        sourcePath,
        targetId: dto.targetId,
        metadata: dto.metadata as Prisma.InputJsonValue,
      },
    });

    if (planSourceKey) {
      await tx.ingestPlanItem.updateMany({
        where: { sourceKey: planSourceKey },
        data: {
          sourcePath,
          status: 'INGEST_STARTED',
          jobId:  created.id,
        },
      });
    }

    await writeShadowEvent(tx, {
      eventType:     'ingest.job_started',
      aggregateType: 'IngestJob',
      aggregateId:   created.id,
      payload: {
        jobId:      created.id,
        sourcePath: created.sourcePath,
        targetId:   created.targetId,
      },
    });

    return created;
  });

  await app.rabbitmq.publish(QUEUES.INGEST_NEW, {
    jobId:      job.id,
    sourcePath: job.sourcePath,
    targetId:   job.targetId,
  });

  return job;
}
