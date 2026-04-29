import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';

interface AuditEntry {
  entityType: string;
  entityId: number;
  action: string;
  beforePayload?: any;
  afterPayload?: any;
  user: string;
  ipAddress?: string;
}

interface RequestContext {
  userId?: string;
  userRoles?: string[];
  ipAddress?: string;
  pendingAuditLogs: AuditEntry[];
}

export const als = new AsyncLocalStorage<RequestContext>();

/**
 * İki hook: onRequest store'u kurar (tüm request lifecycle'ı sarar),
 * preHandler userId'yi auth doğrulamasından sonra doldurur.
 */
const contextPlugin: FastifyPluginAsync = fp(async (fastify) => {
  fastify.addHook('onRequest', (request, _reply, done) => {
    als.run({ ipAddress: request.ip, pendingAuditLogs: [] }, done);
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
 *
 * HTTP request bağlamında: audit girişleri ALS kuyruğuna eklenir,
 * onResponse hook'unda (yalnızca 2xx/3xx) toplu yazılır.
 * Bu sayede $transaction rollback → 5xx durumunda phantom write oluşmaz.
 *
 * Arka plan worker bağlamında (ALS store yok): anında yazılır.
 *
 * updateMany/deleteMany: tam before-snapshot alınır (salt ID yerine).
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
          const user = context?.userId ?? 'system';
          const ipAddress = context?.ipAddress;

          let before: any = null;
          let beforeSnapshots: any[] = [];
          let affectedIds: number[] | null = null;

          if (operation === 'update' || operation === 'delete') {
            before = await (base as any)[model].findFirst({ where: args.where });
          } else if (operation === 'updateMany' || operation === 'deleteMany') {
            const rows = await (base as any)[model].findMany({ where: args.where });
            affectedIds = rows.map((r: any) => r.id);
            beforeSnapshots = rows;
          }

          const result = await query(args);
          const after = ['create', 'update', 'upsert'].includes(operation) ? result : null;
          const action = toAuditAction(operation);

          const buildEntries = (): AuditEntry[] => {
            if (affectedIds) {
              return affectedIds.map((id: number, index: number) => ({
                entityType: model,
                entityId: id,
                action,
                beforePayload: beforeSnapshots[index],
                user,
                ipAddress,
              }));
            }
            const targetId = (result as any)?.id ?? (before as any)?.id;
            return [{
              entityType: model,
              entityId: Number(targetId ?? 0),
              action,
              beforePayload: before ?? undefined,
              afterPayload: after ?? undefined,
              user,
              ipAddress,
            }];
          };

          if (context) {
            // HTTP bağlamı: kuyruğa ekle, onResponse'ta toplu yaz
            context.pendingAuditLogs.push(...buildEntries());
          } else {
            // Worker/arka plan bağlamı: anında yaz
            try {
              await base.auditLog.createMany({ data: buildEntries().map(toDbRow) as any });
            } catch (err) {
              // Audit hatası ana işlemi durdurmaz
            }
          }

          return result;
        },
      },
    },
  });
}

function toAuditAction(operation: string): string {
  if (operation === 'createMany') return 'CREATEMANY';
  if (operation === 'updateMany') return 'UPDATE';
  if (operation === 'deleteMany') return 'DELETE';
  return operation.toUpperCase();
}

function toDbRow(e: AuditEntry) {
  return {
    entityType: e.entityType,
    entityId: e.entityId,
    action: e.action,
    beforePayload: e.beforePayload ?? null,
    afterPayload: e.afterPayload ?? null,
    user: e.user,
    ipAddress: e.ipAddress ?? null,
  };
}

export const auditPlugin: FastifyPluginAsync = fp(async (fastify: FastifyInstance) => {
  await fastify.register(contextPlugin);

  const base = fastify.prisma as PrismaClient;
  (fastify as any).prisma = buildAuditExtension(base);

  /**
   * Phantom write koruması:
   * Yalnızca başarılı yanıtlarda (< 400) audit logları DB'ye yazılır.
   * $transaction rollback → 5xx → audit loglar atılır → phantom write yok.
   */
  fastify.addHook('onResponse', async (_request, reply) => {
    if (reply.statusCode >= 400) return;
    const store = als.getStore();
    if (!store?.pendingAuditLogs?.length) return;
    const entries = store.pendingAuditLogs.splice(0);
    try {
      await base.auditLog.createMany({ data: entries.map(toDbRow) as any });
    } catch (err) {
      fastify.log.error({ err }, 'Audit log flush hatası');
    }
  });

  fastify.log.info('Prisma Audit extension ($extends) başarıyla yüklendi.');
});
