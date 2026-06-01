/**
 * Restore V2 — kademe 2 (restore) REST routes (3 kademe modeli).
 *
 *  POST /api/v1/restore/jobs       → body { searchJobId } → 202
 *  GET  /api/v1/restore/jobs?date= → liste (200)
 *
 * preHandler: `PERMISSIONS.restore.execute` (POST) / `restore.read` (GET).
 * Admin auto-bypass `isAdminPrincipal()` üzerinden.
 */

import type { FastifyInstance } from 'fastify';
import { PERMISSIONS, type JwtPayload, type RestoreJobDto } from '@bcms/shared';
import { istanbulTodayDate } from '../../core/tz.js';
import {
  enqueueRestoreSchema,
  listJobsQuerySchema,
  mapRestoreJob,
} from './restore.dto.js';
import {
  enqueueRestoreJob,
  listRestoreJobs,
  SearchNotSelectedError,
} from './restore.service.js';
import { ResponseCache } from '../../lib/response-cache.js';
import { responseCacheTotal } from '../../plugins/metrics.js';

// YP0.4-B (2026-05-29, 250 user scale): restore jobs liste cache. Restore
// sekmesi 5sn polling × 250 user × 3 endpoint = 150 req/sn. 5sn TTL +
// dog-pile dedup → ~10 req/sn. POST /jobs success path cache.invalidate()
// ile yeni enqueue UI'da hemen görünür (worker tick gecikmesi ayrı).
type RestoreJobsResponse = {
  date: string;
  scope: 'single-date' | 'today-future';
  jobs: RestoreJobDto[];
};
const restoreJobsCache = new ResponseCache<RestoreJobsResponse>({
  ttlMs: 5_000,
  maxEntries: 16,
  onResult: (result) => responseCacheTotal.inc({ key: 'restore-jobs', result }),
});

export async function restoreRoutes(app: FastifyInstance) {
  // POST /api/v1/restore/jobs — body { searchJobId } + precondition guard
  app.post('/jobs', {
    preHandler: app.requireGroup(...PERMISSIONS.restore.execute),
    schema: { tags: ['Restore'], summary: 'Avid restore job enqueue (kademe 2)' },
  }, async (request, reply) => {
    const body = enqueueRestoreSchema.parse(request.body);
    const user = (request.user as JwtPayload | undefined)?.preferred_username ?? null;
    try {
      const result = await enqueueRestoreJob(app, body, user);
      // YP0.4-B: yeni job enqueue cache'i stale yapar → invalidate.
      restoreJobsCache.invalidate();
      // `return reply` ŞART (2026-06-02 fix — "Reply already sent" / HEADERS_SENT).
      return reply.status(202).send({
        jobId:    result.job.id,
        status:   result.job.status,
        existing: result.existing,
      });
    } catch (err) {
      if (err instanceof SearchNotSelectedError) {
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

  // GET /api/v1/restore/jobs[?date=YYYY-MM-DD]
  // 2026-05-28 revize: date opsiyonel; yoksa scheduleDate >= today (today-future).
  app.get('/jobs', {
    preHandler: app.requireGroup(...PERMISSIONS.restore.read),
    schema: { tags: ['Restore'], summary: 'List restore jobs (today-future veya tek gün)' },
  }, async (request) => {
    const q = listJobsQuerySchema.parse(request.query);
    const today = istanbulTodayDate();
    const date = q.date ?? null;
    const cacheKey = date ? `date:${date}` : `today-future:${today}`;
    return restoreJobsCache.getOrCompute(cacheKey, async () => {
      const rows = await listRestoreJobs(app, date, today);
      return {
        date: date ?? today,
        scope: date ? ('single-date' as const) : ('today-future' as const),
        jobs: rows.map(mapRestoreJob),
      };
    });
  });
}
