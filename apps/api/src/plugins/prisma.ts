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
  // ORTA-API-1.1.12 fix (2026-05-04): fail-fast. Eski hâlinde boş URL silently
  // fall-through ediyor, Prisma kendi error'ıyla başlıyordu — daha geç fail.
  // validateRuntimeEnv() prod'da zaten zorunlu olarak set ediyor; ama dev/test
  // ortamında defansif fail-fast yararlı.
  if (!base) {
    throw new Error('DATABASE_URL env değişkeni set edilmemiş');
  }

  const url = new URL(base);
  // ORTA-API-1.1.13 fix (2026-05-04): isApi tespiti güçlendirildi.
  // Eski hâlinde BCMS_BACKGROUND_SERVICES='' boş set edilirse 'all' default'a
  // düşmüyordu — empty trimmed === '' !== 'none' → isApi=false → worker pool
  // (5 conn) kullanılıyordu. Açık eşitlik dışında boş'u 'all' kabul et.
  const bgRaw = (process.env.BCMS_BACKGROUND_SERVICES ?? '').trim().toLowerCase();
  const bgValue = bgRaw === '' ? 'all' : bgRaw;
  const isApi = bgValue === 'none';

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
