import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { prismaPlugin } from './plugins/prisma.js';
import { authPlugin } from './plugins/auth.js';
import { rabbitmqPlugin } from './plugins/rabbitmq.js';
import { metricsPlugin } from './plugins/metrics.js';

import { scheduleRoutes } from './modules/schedules/schedule.routes.js';
import { bookingRoutes } from './modules/bookings/booking.routes.js';
import { channelRoutes } from './modules/channels/channel.routes.js';
import { ingestRoutes } from './modules/ingest/ingest.routes.js';
import { incidentRoutes } from './modules/incidents/incident.routes.js';
import { signalRoutes } from './modules/signals/signal.routes.js';
import { playoutRoutes } from './modules/playout/playout.routes.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { matchRoutes } from './modules/matches/match.routes.js';
import { startNotificationConsumer } from './modules/notifications/notification.consumer.js';
import { startIngestWorker } from './modules/ingest/ingest.worker.js';
import { startIngestWatcher } from './modules/ingest/ingest.watcher.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  // ── Security ─────────────────────────────────────────────────────────────────
  await app.register(helmet, { contentSecurityPolicy: false });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200',
    credentials: true,
  });

  // ── API Docs (Swagger) ────────────────────────────────────────────────────────
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'BCMS API',
        description: 'Broadcast Content Management System',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // ── Plugins ───────────────────────────────────────────────────────────────────
  await app.register(prismaPlugin);
  await app.register(authPlugin);
  await app.register(rabbitmqPlugin);
  await app.register(metricsPlugin);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // max 10 MB

  // ── Health check ──────────────────────────────────────────────────────────────
  app.get('/health', { schema: { hide: true } }, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // ── Consumers & watchers ──────────────────────────────────────────────────────
  await startNotificationConsumer(app);
  await startIngestWorker(app);
  startIngestWatcher(app);

  // ── Routes ────────────────────────────────────────────────────────────────────
  await app.register(scheduleRoutes, { prefix: '/api/v1/schedules' });
  await app.register(bookingRoutes,  { prefix: '/api/v1/bookings' });
  await app.register(channelRoutes,  { prefix: '/api/v1/channels' });
  await app.register(ingestRoutes,   { prefix: '/api/v1/ingest' });
  await app.register(incidentRoutes, { prefix: '/api/v1/incidents' });
  await app.register(signalRoutes,   { prefix: '/api/v1/signals' });
  await app.register(playoutRoutes,  { prefix: '/api/v1/playout' });
  await app.register(auditRoutes,    { prefix: '/api/v1/audit' });
  await app.register(matchRoutes,    { prefix: '/api/v1/matches' });

  // ── Global error handler ──────────────────────────────────────────────────────
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    app.log.error({ err: error, url: request.url }, 'Unhandled error');
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      statusCode,
      error: error.name,
      message: error.message,
    });
  });

  return app;
}
