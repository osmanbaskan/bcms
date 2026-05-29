/**
 * Restore V2 — kademe 1 (search) REST routes.
 *
 *  POST  /api/v1/search/jobs         → idempotent enqueue (202)
 *  GET   /api/v1/search/jobs?date=   → liste (200)
 *  PATCH /api/v1/search/jobs/:id/select → AWAITING_SELECTION → SELECTED (200)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, type JwtPayload, type SearchJobDto } from '@bcms/shared';
import { istanbulTodayDate } from '../../core/tz.js';
import {
  enqueueSearchSchema,
  selectAssetSchema,
  listJobsQuerySchema,
  mapSearchJob,
} from './search.dto.js';
import {
  enqueueSearchJob,
  listSearchJobs,
  selectAsset,
  SelectNotAwaitingError,
  AssetNotInResultsError,
} from './search.service.js';
import { ResponseCache } from '../../lib/response-cache.js';
import { responseCacheTotal } from '../../plugins/metrics.js';

// YP0.4-B (2026-05-29, 250 user scale): search jobs liste cache.
// POST /jobs + PATCH /jobs/:id/select success path cache invalidate eder.
type SearchJobsResponse = {
  date: string;
  scope: 'single-date' | 'today-future';
  jobs: SearchJobDto[];
};
const searchJobsCache = new ResponseCache<SearchJobsResponse>({
  ttlMs: 5_000,
  maxEntries: 16,
  onResult: (result) => responseCacheTotal.inc({ key: 'search-jobs', result }),
});

export async function searchRoutes(app: FastifyInstance) {
  // POST /api/v1/search/jobs
  app.post('/jobs', {
    preHandler: app.requireGroup(...PERMISSIONS.search.execute),
    schema: { tags: ['Search'], summary: 'Avid search enqueue (kademe 1)' },
  }, async (request, reply) => {
    const body = enqueueSearchSchema.parse(request.body);
    const user = (request.user as JwtPayload | undefined)?.preferred_username ?? null;
    const result = await enqueueSearchJob(app, body, user);
    // YP0.4-B: yeni enqueue cache'i stale yapar → invalidate.
    searchJobsCache.invalidate();
    reply.status(202).send({
      jobId:    result.job.id,
      status:   result.job.status,
      existing: result.existing,
    });
  });

  // GET /api/v1/search/jobs[?date=YYYY-MM-DD]
  // 2026-05-28 revize: date opsiyonel; yoksa scheduleDate >= today (today-future).
  app.get('/jobs', {
    preHandler: app.requireGroup(...PERMISSIONS.search.read),
    schema: { tags: ['Search'], summary: 'List search jobs (today-future veya tek gün)' },
  }, async (request) => {
    const q = listJobsQuerySchema.parse(request.query);
    const today = istanbulTodayDate();
    const date = q.date ?? null;
    const cacheKey = date ? `date:${date}` : `today-future:${today}`;
    return searchJobsCache.getOrCompute(cacheKey, async () => {
      const rows = await listSearchJobs(app, date, today);
      return {
        date: date ?? today,
        scope: date ? ('single-date' as const) : ('today-future' as const),
        jobs: rows.map(mapSearchJob),
      };
    });
  });

  // PATCH /api/v1/search/jobs/:id/select
  app.patch<{ Params: { id: string } }>('/jobs/:id/select', {
    preHandler: app.requireGroup(...PERMISSIONS.search.execute),
    schema: { tags: ['Search'], summary: 'AWAITING_SELECTION → SELECTED' },
  }, async (request, reply) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const body = selectAssetSchema.parse(request.body);
    const user = (request.user as JwtPayload | undefined)?.preferred_username ?? null;
    try {
      const job = await selectAsset(app, id, body, user);
      if (!job) {
        reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Search job not found' });
        return;
      }
      // YP0.4-B: AWAITING_SELECTION → SELECTED transition cache'i stale yapar.
      searchJobsCache.invalidate();
      return mapSearchJob(job);
    } catch (err) {
      if (err instanceof SelectNotAwaitingError) {
        reply.status(409).send({ statusCode: 409, error: 'Conflict', code: err.code, message: err.message });
        return;
      }
      if (err instanceof AssetNotInResultsError) {
        reply.status(400).send({ statusCode: 400, error: 'Bad Request', code: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });
}
