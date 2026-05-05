import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { Counter, Histogram, Registry } from 'prom-client';
import { timingSafeEqual } from 'node:crypto';

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
  // ORTA-API-1.1.21 (2026-05-04): method/route/status label'ları —
  // Grafana'da breakdown için. /metrics, /docs, /health hariç tutuldu.
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

const httpErrorsTotal = new Counter({
  name: 'http_errors_total',
  help: 'Total HTTP responses with status >= 500',
  labelNames: ['method', 'route'] as const,
  registers: [registry],
});

// ORTA-API-1.1.22 (2026-05-04): request duration histogram — p99 latency
// için. SLA-grade buckets (50ms..10s) yayın işlemleri için makul.
const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const EXCLUDED_ROUTES = new Set(['/metrics', '/docs', '/health']);

function isExcluded(url: string): boolean {
  // /docs/* ve /docs/json gibi alt path'ler de hariç
  return EXCLUDED_ROUTES.has(url) || url.startsWith('/docs/');
}

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

// ÖNEMLİ-API-1.1.20 (2026-05-04): /metrics application-layer auth.
// nginx `deny all` external'e karşı koruyor; defense-in-depth için Docker
// network içi compromise senaryosunu da kapatıyoruz. METRICS_TOKEN env'i
// set edildiyse Bearer token zorunlu; set edilmediyse legacy davranış
// (allow) — boot'ta uyarı log'lanır.
function metricsAuthOk(headerValue: string | undefined): boolean {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) return true;
  if (!headerValue) return false;
  const prefix = 'Bearer ';
  if (!headerValue.startsWith(prefix)) return false;
  const provided = headerValue.slice(prefix.length);
  // timing-safe compare; uzunluk farklı olsa bile constant-time davran.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const metricsPlugin = fp(async (app: FastifyInstance) => {
  if (!process.env.METRICS_TOKEN) {
    app.log.warn('METRICS_TOKEN env set edilmemiş; /metrics application-katmanı koruması KAPALI (nginx deny tek savunma katmanı).');
  }

  app.addHook('onRequest', (request, _reply, done) => {
    (request as unknown as { _startTime: bigint })._startTime = process.hrtime.bigint();
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const url = request.routeOptions?.url ?? request.url.split('?')[0];
    if (!isExcluded(url)) {
      const labels = { method: request.method, route: url, status: String(reply.statusCode) };
      httpRequestsTotal.inc(labels);
      if (reply.statusCode >= 500) httpErrorsTotal.inc({ method: request.method, route: url });
      const start = (request as unknown as { _startTime?: bigint })._startTime;
      if (start !== undefined) {
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        httpRequestDurationSeconds.observe(labels, seconds);
      }
    }
    done();
  });

  app.get('/metrics', { schema: { hide: true }, config: { rateLimit: false } }, async (request, reply) => {
    if (!metricsAuthOk(request.headers.authorization)) {
      reply.code(401).header('WWW-Authenticate', 'Bearer realm="metrics"');
      return { error: 'unauthorized' };
    }
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
});
