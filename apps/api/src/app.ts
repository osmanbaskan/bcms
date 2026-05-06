import fs from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { GROUP } from '@bcms/shared';

import { prismaPlugin } from './plugins/prisma.js';
import { authPlugin } from './plugins/auth.js';
import { auditPlugin } from './plugins/audit.js';
import { rabbitmqPlugin } from './plugins/rabbitmq.js';
import { metricsPlugin } from './plugins/metrics.js';

import { scheduleRoutes } from './modules/schedules/schedule.routes.js';
import { livePlanRoutes } from './modules/live-plan/live-plan.routes.js';
import { livePlanLookupRoutes } from './modules/live-plan/lookup.routes.js';
import { bookingRoutes } from './modules/bookings/booking.routes.js';
import { channelRoutes } from './modules/channels/channel.routes.js';
import { ingestRoutes } from './modules/ingest/ingest.routes.js';
import { incidentRoutes } from './modules/incidents/incident.routes.js';
import { signalRoutes } from './modules/signals/signal.routes.js';
import { playoutRoutes } from './modules/playout/playout.routes.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { matchRoutes } from './modules/matches/match.routes.js';
import { optaRoutes }  from './modules/opta/opta.routes.js';
import { optaSyncRoutes } from './modules/opta/opta.sync.routes.js';
import { usersRoutes } from './modules/users/users.routes.js';
import { broadcastTypeRoutes } from './modules/broadcast-types/broadcast-type.routes.js';
import { studioPlanRoutes } from './modules/studio-plans/studio-plan.routes.js';
import { weeklyShiftRoutes } from './modules/weekly-shifts/weekly-shift.routes.js';
import { startNotificationConsumer } from './modules/notifications/notification.consumer.js';
import { startIngestWorker } from './modules/ingest/ingest.worker.js';
import { startIngestWatcher } from './modules/ingest/ingest.watcher.js';
import { startBxfWatcher } from './modules/bxf/bxf.watcher.js';
import { startOptaWatcher, getOptaWatcherStatus } from './modules/opta/opta.watcher.js';
import { startAuditRetentionJob } from './modules/audit/audit-retention.job.js';
import { startAuditPartitionJob } from './modules/audit/audit-partition.job.js';
import { startOutboxPoller } from './modules/outbox/outbox.poller.js';

const BACKGROUND_SERVICES = [
  'notifications',
  'ingest-worker',
  'ingest-watcher',
  'bxf-watcher',
  'opta-watcher',
  'audit-retention',
  'audit-partition',
  'outbox-poller',
] as const;

type BackgroundService = (typeof BACKGROUND_SERVICES)[number];

function validateRuntimeEnv(): void {
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) return;

  if (process.env.SKIP_AUTH === 'true') {
    throw new Error('SKIP_AUTH cannot be enabled in production');
  }

  // MED-API-023 fix (2026-05-05): SMTP_HOST/PORT/FROM prod'da zorunlu
  // (notification consumer için).
  const required = [
    'DATABASE_URL',
    'RABBITMQ_URL',
    'CORS_ORIGIN',
    'KEYCLOAK_URL',
    'KEYCLOAK_REALM',
    'KEYCLOAK_CLIENT_ID',
    'KEYCLOAK_ADMIN',
    'KEYCLOAK_ADMIN_PASSWORD',
    'INGEST_CALLBACK_SECRET',
    'INGEST_ALLOWED_ROOTS',
    'OPTA_SYNC_SECRET',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_FROM',
  ];

  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required production environment variables: ${missing.join(', ')}`);
  }
}

function corsOrigin(): string | string[] {
  const value = process.env.CORS_ORIGIN ?? 'http://localhost:4200';
  const origins = value.split(',').map((origin) => origin.trim()).filter(Boolean);
  return origins.length > 1 ? origins : origins[0] ?? 'http://localhost:4200';
}

function enabledBackgroundServices(): Set<BackgroundService> {
  const value = process.env.BCMS_BACKGROUND_SERVICES ?? 'all';
  const normalized = value.trim().toLowerCase();

  if (normalized === 'none') return new Set<BackgroundService>();
  if (normalized === 'all') return new Set(BACKGROUND_SERVICES);

  const valid = new Set<string>(BACKGROUND_SERVICES);
  const requested = normalized
    .split(',')
    .map((service) => service.trim())
    .filter(Boolean);

  const unknown = requested.filter((service) => !valid.has(service));
  if (unknown.length > 0) {
    throw new Error(`Unknown BCMS_BACKGROUND_SERVICES entries: ${unknown.join(', ')}`);
  }

  return new Set(requested as BackgroundService[]);
}

async function startBackgroundServices(app: FastifyInstance): Promise<void> {
  const enabled = enabledBackgroundServices();

  const run = async (service: BackgroundService, start: () => Promise<void> | void) => {
    if (!enabled.has(service)) {
      app.log.info({ service }, 'Background service disabled');
      return;
    }
    await start();
    app.log.info({ service }, 'Background service started');
  };

  await run('notifications', () => startNotificationConsumer(app));
  await run('ingest-worker', () => startIngestWorker(app));
  await run('ingest-watcher', () => startIngestWatcher(app));
  await run('bxf-watcher', () => startBxfWatcher(app));
  await run('opta-watcher', () => startOptaWatcher(app));
  await run('audit-retention', () => startAuditRetentionJob(app));
  await run('audit-partition', () => startAuditPartitionJob(app));
  await run('outbox-poller',   () => startOutboxPoller(app));
}

function errorResponse(error: Error & { statusCode?: number; code?: string }) {
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      body: {
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        issues: error.issues,
      },
    };
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const statusCode = error.code === 'P2025' ? 404 : ['P2002', 'P2003', 'P2004'].includes(error.code) ? 409 : 500;
    // HIGH-API-009 fix (2026-05-05): Prisma error.message client'a schema detayı
    // (kolon adları, constraint adları, query parçaları) sızdırıyor. Sadece kod
    // bazlı generic mesaj dön; tam detay server log'unda.
    const message =
      statusCode === 404 ? 'Kayıt bulunamadı' :
      statusCode === 409 && error.code === 'P2002' ? 'Benzersiz kısıtlama ihlali' :
      statusCode === 409 && error.code === 'P2003' ? 'Foreign key kısıtlaması ihlali' :
      statusCode === 409 ? 'Veritabanı kısıtlama ihlali' :
      'Internal Server Error';
    return {
      statusCode,
      body: {
        statusCode,
        error: statusCode >= 500 ? 'Internal Server Error' : error.code,
        message,
      },
    };
  }

  const statusCode = error.statusCode ?? 500;
  return {
    statusCode,
    body: {
      statusCode,
      error: statusCode >= 500 ? 'Internal Server Error' : error.name,
      message: statusCode >= 500 ? 'Internal Server Error' : error.message,
    },
  };
}

export async function buildApp() {
  validateRuntimeEnv();

  // HIGH-API-019 fix (2026-05-05): trustProxy aktif — nginx reverse proxy
  // arkasında çalışıyoruz; X-Forwarded-For + X-Real-IP header'larını gerçek
  // istemci IP'si olarak değerlendir. Aksi halde request.ip = nginx container
  // IP'si (172.18.x.x) olur, rate-limit tek IP'ye uygulanır, audit IP yanlış
  // kayıt edilir. Güvenli CIDR: docker bridge (172.18.0.0/16) + loopback.
  const app = Fastify({
    trustProxy: ['127.0.0.1', '::1', '172.18.0.0/16'],
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  // ── Security ─────────────────────────────────────────────────────────────────
  // ORTA-API-1.12.1 fix (2026-05-04): helmet defaults aktif, CSP kapalı.
  // Edge'de (nginx) CSP ana savunma; ama mobil/native client veya direct
  // port erişiminde minimal default-src koruması sağlamak için Fastify
  // tarafında "report-only" pattern düşünülmedi (worker side-effect riski).
  // Bunun yerine helmet'in diğer header'ları (HSTS, frameguard, noSniff,
  // xssFilter, hidePoweredBy) açık bırakıldı. CSP sıkılaştırma follow-up
  // PR'ında nginx config ile aynı policy'yi backend'e de senkronize edecek.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false, // Swagger UI ve external font'lar
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: corsOrigin(),
    credentials: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    skipOnError: false,
    // LOW-API-011 fix (2026-05-05): x-real-ip header bazı proxy'lerde array
    // olarak gelebilir; ilk değeri al.
    keyGenerator: (req) => {
      const realIp = req.headers['x-real-ip'];
      if (Array.isArray(realIp)) return realIp[0] ?? req.ip;
      return realIp ?? req.ip;
    },
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)}s.`,
    }),
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

  // HIGH-API-010 fix (2026-05-05) — Swagger UI prod gate.
  // Prod'da /docs ve /docs/json sadece SystemEng/Admin grubu erişebilir.
  // Dev'de (NODE_ENV !== 'production') koşulsuz açık. Public expose engellenir.
  if (process.env.NODE_ENV === 'production') {
    app.addHook('onRequest', async (request, reply) => {
      const url = request.url.split('?')[0];
      if (!url.startsWith('/docs')) return;
      try {
        await app.requireGroup(GROUP.SystemEng)(request);
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode ?? 401;
        return reply.code(status).send({
          statusCode: status,
          error: status === 401 ? 'Unauthorized' : 'Forbidden',
          message: status === 401
            ? 'Swagger /docs prod\'da auth gerektirir'
            : 'Swagger /docs sadece SystemEng/Admin için',
        });
      }
    });
  }
  await app.register(auditPlugin);
  await app.register(rabbitmqPlugin);
  await app.register(metricsPlugin);
  // ORTA-API-1.12.2 fix (2026-05-04): nginx client_max_body_size 100m ile
  // hizalı; eski 10MB sınırı 50MB Excel upload'larında ambiguous "413 vs.
  // multipart parse error" davranışına yol açıyordu. fields/files cap
  // eklendi (10 alan, 5 dosya) — DoS koruması.
  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100 MB — nginx ile aynı
      fields: 10,
      files: 5,
      headerPairs: 100,
    },
  });

  // ── Health check ──────────────────────────────────────────────────────────────
  app.get('/health', { schema: { hide: true }, config: { rateLimit: false } }, async (_req, reply) => {
    const checks: Record<string, 'ok' | 'degraded'> = {};

    // Database — MED-INF-004 fix (2026-05-05): findFirst typed query; sadece
    // bir row LIMIT 1, count(*) full scan'i tetiklemez. Healthcheck ucuz.
    try {
      await app.prisma.auditLog.findFirst({ select: { id: true } });
      checks.database = 'ok';
    } catch {
      checks.database = 'degraded';
    }

    // RabbitMQ
    checks.rabbitmq = app.rabbitmq.isConnected() ? 'ok' : 'degraded';

    // OPTA — API modunda (none) dizin varlığını kontrol et; worker'da ayrı container
    const enabledServices = enabledBackgroundServices();
    if (enabledServices.size === 0 || enabledServices.has('opta-watcher')) {
      const opta = getOptaWatcherStatus();
      if (opta.connected) {
        checks.opta = 'ok';
      } else {
        try {
          await fs.stat(opta.dir);
          checks.opta = 'ok';
        } catch {
          checks.opta = 'degraded';
        }
      }
    } else {
      checks.opta = 'ok';
    }

    const degraded = Object.values(checks).some((v) => v === 'degraded');
    return reply
      .status(degraded ? 503 : 200)
      .send({ status: degraded ? 'degraded' : 'ok', checks, timestamp: new Date().toISOString() });
  });

  // ── Consumers & watchers ──────────────────────────────────────────────────────
  await startBackgroundServices(app);

  // ── Global error handler ──────────────────────────────────────────────────────
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const response = errorResponse(error);
    const logPayload = { err: error, url: request.url, statusCode: response.statusCode };
    if (response.statusCode >= 500) {
      app.log.error(logPayload, 'Unhandled error');
    } else {
      app.log.warn(logPayload, 'Request failed');
    }
    reply.status(response.statusCode).send(response.body);
  });

  // ── Routes ────────────────────────────────────────────────────────────────────
  await app.register(scheduleRoutes, { prefix: '/api/v1/schedules' });
  await app.register(livePlanRoutes, { prefix: '/api/v1/live-plan' });
  await app.register(livePlanLookupRoutes, { prefix: '/api/v1/live-plan/lookups' });
  await app.register(bookingRoutes,  { prefix: '/api/v1/bookings' });
  await app.register(channelRoutes,  { prefix: '/api/v1/channels' });
  await app.register(ingestRoutes,   { prefix: '/api/v1/ingest' });
  await app.register(incidentRoutes, { prefix: '/api/v1/incidents' });
  await app.register(signalRoutes,   { prefix: '/api/v1/signals' });
  await app.register(playoutRoutes,  { prefix: '/api/v1/playout' });
  await app.register(auditRoutes,    { prefix: '/api/v1/audit' });
  await app.register(matchRoutes,    { prefix: '/api/v1/matches' });
  await app.register(optaRoutes,     { prefix: '/api/v1/opta' });
  await app.register(optaSyncRoutes, { prefix: '/api/v1/opta' });
  await app.register(usersRoutes,          { prefix: '/api/v1/users' });
  await app.register(broadcastTypeRoutes,  { prefix: '/api/v1/broadcast-types' });
  await app.register(studioPlanRoutes,     { prefix: '/api/v1/studio-plans' });
  await app.register(weeklyShiftRoutes,    { prefix: '/api/v1/weekly-shifts' });

  return app;
}
