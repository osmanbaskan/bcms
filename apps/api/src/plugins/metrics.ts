import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

/**
 * Minimal Prometheus-compatible /metrics endpoint.
 * For production, add prom-client for full histogram/gauge support.
 */
export const metricsPlugin = fp(async (app: FastifyInstance) => {
  const counters: Record<string, number> = {
    http_requests_total: 0,
    http_errors_total: 0,
  };

  app.addHook('onResponse', (request, reply, done) => {
    counters['http_requests_total']++;
    if (reply.statusCode >= 500) counters['http_errors_total']++;
    done();
  });

  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => {
    const lines = Object.entries(counters).map(
      ([key, val]) => `# TYPE ${key} counter\n${key} ${val}`,
    );
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return lines.join('\n') + '\n';
  });
});
