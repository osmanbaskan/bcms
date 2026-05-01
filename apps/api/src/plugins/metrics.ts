import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { Counter, Registry } from 'prom-client';

/**
 * Prometheus metrics plugin (prom-client v15+).
 *
 * Migration note: previously hand-rolled `Record<string, number>` counters.
 * Refactored to prom-client to support labels (HIGH-003 OPTA observability).
 * External contract preserved:
 * - Existing metric names unchanged: http_requests_total, http_errors_total
 * - /metrics endpoint URL, auth (none), rate limit (false) unchanged
 * - Output format remains Prometheus-parseable
 *
 * Module-level singleton registry — duplicate registration on plugin
 * re-register is guarded by exporting metrics from module scope.
 */

const registry = new Registry();

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests handled',
  registers: [registry],
});

const httpErrorsTotal = new Counter({
  name: 'http_errors_total',
  help: 'Total HTTP responses with status >= 500',
  registers: [registry],
});

/**
 * OPTA league sync action counter (HIGH-003).
 * Counts every league sync decision: actual write (create|update) vs idempotent skip.
 *
 * Alert rules (infra/prometheus/alerts.yml):
 * - sum(increase(bcms_opta_league_sync_total[1h])) > 500       — caller anomaly
 * - sum(increase(...{action=~"create|update"}[1h])) > 200      — data write anomaly
 *
 * Label series initialized to 0 below so Prometheus sees consistent
 * baseline before first inc() and increase() works from sync start.
 */
export const optaLeagueSyncTotal = new Counter({
  name: 'bcms_opta_league_sync_total',
  help: 'OPTA league sync actions per /opta/sync invocation',
  labelNames: ['action'] as const,
  registers: [registry],
});

optaLeagueSyncTotal.inc({ action: 'create' }, 0);
optaLeagueSyncTotal.inc({ action: 'update' }, 0);
optaLeagueSyncTotal.inc({ action: 'skip' }, 0);

export const metricsPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('onResponse', (_request, reply, done) => {
    httpRequestsTotal.inc();
    if (reply.statusCode >= 500) httpErrorsTotal.inc();
    done();
  });

  app.get('/metrics', { schema: { hide: true }, config: { rateLimit: false } }, async (_req, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
});
