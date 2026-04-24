import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Prisma, PrismaClient } from '@prisma/client';

interface RequestContext {
  userId?: string;
  userRoles?: string[];
  ipAddress?: string;
}

export const als = new AsyncLocalStorage<RequestContext>();

/**
 * Her isteğin kullanıcı bilgilerini ve IP adresini yakalayıp
 * asenkron yerel depolamaya (ALS) koyan Fastify hook'u.
 */
const contextPlugin: FastifyPluginAsync = fp(async (fastify) => {
  fastify.addHook('onRequest', (request, reply, done) => {
    const user = (request.user as any) ?? {};
    const store: RequestContext = {
      userId: user.sub,
      userRoles: user.roles,
      ipAddress: request.ip,
    };
    als.run(store, done);
  });
});

/**
 * Prisma yazma işlemlerini yakalayan ve audit log oluşturan middleware.
 */
function createAuditMiddleware(prisma: PrismaClient): Prisma.Middleware {
  return async (params, next) => {
    // AuditLog tablosuna yapılan yazma işlemlerini tekrar loglama (sonsuz döngüden kaçın)
    if (params.model === 'AuditLog') {
      return next(params);
    }

    const isWriteAction = ['create', 'update', 'upsert', 'delete', 'createMany', 'updateMany', 'deleteMany'].includes(params.action);

    if (!isWriteAction) {
      return next(params);
    }

    const { model, action, args } = params;
    const context = als.getStore();

    // Değişiklik öncesi veriyi al (sadece tekil update/delete için)
    let before: any = null;
    if ((action === 'update' || action === 'delete') && args.where?.id) {
      before = await (prisma as any)[model!].findUnique({ where: { id: args.where.id } });
    }

    // Asıl veritabanı işlemini gerçekleştir
    const result = await next(params);

    // Değişiklik sonrası veriyi al
    const after = (action.startsWith('create') || action.startsWith('update')) ? result : null;
    const targetId = (result as any)?.id ?? args.where?.id;

    // Değişiklikleri logla
    await prisma.auditLog.create({
      data: {
        entityType: model!,
        entityId: Number(targetId ?? 0),
        action: action.toUpperCase(),
        beforePayload: before ?? undefined,
        afterPayload: after ?? undefined,
        user: context?.userId ?? 'system',
        ipAddress: context?.ipAddress,
      },
    });

    return result;
  };
}

/**
 * Prisma'yı audit middleware ile genişleten ana Fastify plugini.
 */
export const auditPlugin: FastifyPluginAsync = fp(async (fastify: FastifyInstance) => {
  // 1. İstek contexte'ini her istek için kur
  await fastify.register(contextPlugin);

  // 2. Mevcut Prisma client'ı al
  const prisma = fastify.prisma;

  // 3. Audit middleware'ini Prisma client'a ekle
  prisma.$use(createAuditMiddleware(prisma));

  fastify.log.info('Prisma Audit Log middleware başarıyla yüklendi.');
});