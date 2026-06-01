/**
 * Restore V2 — kademe 3 (transfer) REST routes (3 kademe modeli).
 *
 *  POST /api/v1/transfer/jobs       → body { restoreJobId } → 202
 *  GET  /api/v1/transfer/jobs?date= → liste (200)
 *
 * Precondition: restore_jobs.findUnique({ id, status=DONE, avidAssetId NOT NULL }).
 * Yoksa 409 `restore_not_done`.
 */

import type { FastifyInstance } from 'fastify';
import { PERMISSIONS, type JwtPayload, type TransferJobDto } from '@bcms/shared';
import { istanbulTodayDate } from '../../core/tz.js';
import {
  enqueueTransferSchema,
  listJobsQuerySchema,
  mapTransferJob,
} from './transfer.dto.js';
import {
  enqueueTransferJob,
  listTransferJobs,
  RestoreNotDoneError,
} from './transfer.service.js';
import { ResponseCache } from '../../lib/response-cache.js';
import { responseCacheTotal } from '../../plugins/metrics.js';

// YP0.4-B (2026-05-29, 250 user scale): transfer jobs liste cache.
// POST /jobs success path cache invalidate eder.
type TransferJobsResponse = {
  date: string;
  scope: 'single-date' | 'today-future';
  jobs: TransferJobDto[];
};
const transferJobsCache = new ResponseCache<TransferJobsResponse>({
  ttlMs: 5_000,
  maxEntries: 16,
  onResult: (result) => responseCacheTotal.inc({ key: 'transfer-jobs', result }),
});

export async function transferRoutes(app: FastifyInstance) {
  // POST /api/v1/transfer/jobs — precondition + idempotent enqueue
  app.post('/jobs', {
    preHandler: app.requireGroup(...PERMISSIONS.transfer.execute),
    schema: { tags: ['Transfer'], summary: 'Avid transfer job enqueue (kademe 3)' },
  }, async (request, reply) => {
    const body = enqueueTransferSchema.parse(request.body);
    const user = (request.user as JwtPayload | undefined)?.preferred_username ?? null;
    try {
      const result = await enqueueTransferJob(app, body, user);
      // YP0.4-B: yeni job enqueue cache'i stale yapar → invalidate.
      transferJobsCache.invalidate();
      // `return reply` ŞART (2026-06-02 fix — "Reply already sent" / HEADERS_SENT).
      return reply.status(202).send({
        jobId:    result.job.id,
        status:   result.job.status,
        existing: result.existing,
      });
    } catch (err) {
      if (err instanceof RestoreNotDoneError) {
        return reply.status(409).send({
          statusCode: 409,
          error:      'Conflict',
          code:       err.code,
          message:    err.message,
        });
      }
      throw err;
    }
  });

  // GET /api/v1/transfer/jobs[?date=YYYY-MM-DD]
  // 2026-05-28 revize: date opsiyonel; yoksa scheduleDate >= today (today-future).
  app.get('/jobs', {
    preHandler: app.requireGroup(...PERMISSIONS.transfer.read),
    schema: { tags: ['Transfer'], summary: 'List transfer jobs (today-future veya tek gün)' },
  }, async (request) => {
    const q = listJobsQuerySchema.parse(request.query);
    const today = istanbulTodayDate();
    const date = q.date ?? null;
    const cacheKey = date ? `date:${date}` : `today-future:${today}`;
    return transferJobsCache.getOrCompute(cacheKey, async () => {
      const rows = await listTransferJobs(app, date, today);
      return {
        date: date ?? today,
        scope: date ? ('single-date' as const) : ('today-future' as const),
        jobs: rows.map(mapTransferJob),
      };
    });
  });
}
