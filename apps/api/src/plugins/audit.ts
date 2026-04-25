import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';

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
 * Prisma $extends ile yazma işlemlerini yakalayan audit intercept.
 * base client kapatmada tutulur; before-snapshot sorguları için kullanılır.
 *
 * - update/delete: findFirst ile tam before snapshot alır (where koşulu ne olursa olsun)
 * - updateMany/deleteMany: etkilenen ID listesini kaydeder, her ID için ayrı log girer
 */
function buildAuditExtension(base: PrismaClient) {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          if (model === 'AuditLog') return query(args);

          const isWrite = ['create', 'update', 'upsert', 'delete', 'createMany', 'updateMany', 'deleteMany'].includes(operation);
          if (!isWrite) return query(args);

          const context = als.getStore();
          let before: any = null;
          let affectedIds: number[] | null = null;

          if (operation === 'update' || operation === 'delete') {
            before = await (base as any)[model].findFirst({ where: args.where });
          } else if (operation === 'updateMany' || operation === 'deleteMany') {
            const rows = await (base as any)[model].findMany({
              where:  args.where,
              select: { id: true },
            });
            affectedIds = rows.map((r: any) => r.id);
          }

          const result = await query(args);

          const after = ['create', 'update', 'upsert'].includes(operation) ? result : null;

          if (affectedIds) {
            await Promise.all(
              affectedIds.map((id: number) =>
                base.auditLog.create({
                  data: {
                    entityType: model,
                    entityId:   id,
                    action:     operation.toUpperCase(),
                    user:       context?.userId ?? 'system',
                    ipAddress:  context?.ipAddress,
                  },
                }),
              ),
            );
          } else {
            const targetId = (result as any)?.id ?? (before as any)?.id;
            await base.auditLog.create({
              data: {
                entityType:    model,
                entityId:      Number(targetId ?? 0),
                action:        operation.toUpperCase(),
                beforePayload: before ?? undefined,
                afterPayload:  after  ?? undefined,
                user:          context?.userId ?? 'system',
                ipAddress:     context?.ipAddress,
              },
            });
          }

          return result;
        },
      },
    },
  });
}

export const auditPlugin: FastifyPluginAsync = fp(async (fastify: FastifyInstance) => {
  await fastify.register(contextPlugin);

  // $extends yeni bir client örneği döner; fastify.prisma'yı in-place güncelliyoruz.
  // Fastify dekoratörü mühürlü değil, değer ataması güvenli.
  (fastify as any).prisma = buildAuditExtension(fastify.prisma);

  fastify.log.info('Prisma Audit extension ($extends) başarıyla yüklendi.');
});
