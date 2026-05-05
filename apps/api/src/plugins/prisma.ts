import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

function buildDatabaseUrl(): string {
  const base = process.env.DATABASE_URL ?? '';
  if (!base) return base;

  const url = new URL(base);
  const isApi =
    (process.env.BCMS_BACKGROUND_SERVICES ?? 'all').trim().toLowerCase() ===
    'none';

  url.searchParams.set('connection_limit', isApi ? '10' : '5');
  // MED-API-024 fix (2026-05-05): pool_timeout 20s çok uzundu — HTTP isteği
  // 20sn DB bağlantısı bekleyebilirdi (rate-limit etmek mümkün ama UX kötü).
  // 5sn'de fail-fast → request 503 alır, kullanıcı tekrar dener.
  url.searchParams.set('pool_timeout', '5');

  return url.toString();
}

export const prismaPlugin = fp(async (app: FastifyInstance) => {
  const prisma = new PrismaClient({
    datasources: { db: { url: buildDatabaseUrl() } },
    log:
      process.env.NODE_ENV !== 'production'
        ? [{ emit: 'event', level: 'query' }, 'info', 'warn', 'error']
        : ['warn', 'error'],
  });

  if (process.env.NODE_ENV !== 'production') {
    prisma.$on('query', (e) => {
      app.log.debug({ query: e.query, duration: e.duration }, 'Prisma query');
    });
  }

  await prisma.$connect();
  app.log.info('Prisma connected');

  app.decorate('prisma', prisma);

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
    app.log.info('Prisma disconnected');
  });
});
