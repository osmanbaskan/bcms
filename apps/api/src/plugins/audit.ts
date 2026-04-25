import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { Prisma, PrismaClient } from '@prisma/client';

interface RequestContext {
  userId?: string;
  userRoles?: string[];
  ipAddress?: string;
}

export const als = new AsyncLocalStorage<RequestContext>();

/**
 * İki hook: onRequest store'u kurar (tüm request lifecycle'ı sarar),
 * preHandler userId'yi auth doğrulamasından sonra doldurur.
 */
const contextPlugin: FastifyPluginAsync = fp(async (fastify) => {
  fastify.addHook('onRequest', (request, _reply, done) => {
    als.run({ ipAddress: request.ip }, done);
  });

  fastify.addHook('preHandler', (request, _reply, done) => {
    const store = als.getStore();
    if (store) {
      const user = (request.user as any) ?? {};
      store.userId = user.sub;
      store.userRoles = user.roles;
    }
    done();
  });
});

/**
 * Prisma yazma işlemlerini yakalayan ve audit log oluşturan middleware.
 * - update/delete: findFirst ile tam before snapshot alır (where koşulu ne olursa olsun)
 * - updateMany/deleteMany: etkilenen ID listesini kaydeder, her ID için ayrı log girer
 */
function createAuditMiddleware(prisma: PrismaClient): Prisma.Middleware {
  return async (params, next) => {
    if (params.model === 'AuditLog') return next(params);

    const isWriteAction = ['create', 'update', 'upsert', 'delete', 'createMany', 'updateMany', 'deleteMany'].includes(params.action);
    if (!isWriteAction) return next(params);

    const { model, action, args } = params;
    const context = als.getStore();
    let before: any = null;
    let affectedIds: number[] | null = null;

    if (action === 'update' || action === 'delete') {
      before = await (prisma as any)[model!].findFirst({ where: args.where });
    } else if (action === 'updateMany' || action === 'deleteMany') {
      const rows = await (prisma as any)[model!].findMany({
        where:  args.where,
        select: { id: true },
      });
      affectedIds = rows.map((r: any) => r.id);
    }

    const result = await next(params);

    const after = ['create', 'update', 'upsert'].includes(action) ? result : null;

    if (affectedIds) {
      await Promise.all(
        affectedIds.map((id) =>
          prisma.auditLog.create({
            data: {
              entityType: model!,
              entityId:   id,
              action:     action.toUpperCase(),
              user:       context?.userId ?? 'system',
              ipAddress:  context?.ipAddress,
            },
          }),
        ),
      );
    } else {
      const targetId = (result as any)?.id ?? (before as any)?.id;
      await prisma.auditLog.create({
        data: {
          entityType:    model!,
          entityId:      Number(targetId ?? 0),
          action:        action.toUpperCase(),
          beforePayload: before ?? undefined,
          afterPayload:  after  ?? undefined,
          user:          context?.userId ?? 'system',
          ipAddress:     context?.ipAddress,
        },
      });
    }

    return result;
  };
}

export const auditPlugin: FastifyPluginAsync = fp(async (fastify: FastifyInstance) => {
  await fastify.register(contextPlugin);
  const prisma = fastify.prisma;
  prisma.$use(createAuditMiddleware(prisma));
  fastify.log.info('Prisma Audit Log middleware başarıyla yüklendi.');
});
