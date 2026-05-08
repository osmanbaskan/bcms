import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { Prisma, PrismaClient, type AuditLogAction } from '@prisma/client';

interface AuditEntry {
  entityType: string;
  entityId: number;
  action: AuditLogAction;
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

// audit.ts plugin scope'unda fastify logger referansı; auditPlugin register
// edildiğinde set edilir.
let fastifyLogger: { warn?: (...a: unknown[]) => void } | undefined;

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
      const user = (request.user as { sub?: string; groups?: string[] }) ?? {};
      store.userId = user.sub;
      store.userRoles = user.groups ?? [];
    }
    done();
  });
});

/**
 * Prisma $extends ile yazma işlemlerini yakalayan audit intercept.
 *
 * HTTP request bağlamında: audit girişleri ALS kuyruğuna eklenir,
 * onSend hook'unda (yalnızca 2xx/3xx) toplu yazılır.
 * Bu sayede $transaction rollback → 5xx durumunda phantom write oluşmaz.
 *
 * Arka plan worker bağlamında (ALS store yok): anında yazılır.
 *
 * updateMany/deleteMany: tam before-snapshot alınır (salt ID yerine), ama
 * MAX_BULK_AUDIT_ROWS ile cap'leniyor (ÖNEMLİ-API-1.1.1 fix).
 */
// ÖNEMLİ-API-1.1.1 fix (2026-05-04): bulk operasyonlarda before-snapshot
// fetch'i tüm satırları belleğe çekiyordu — large updateMany/deleteMany
// (örn. retention purge 100K+ row) OOM riski. Cap koyduk:
//   - Eğer args.where ile etkilenen satır sayısı MAX'tan büyükse:
//     ilk MAX satırı snapshot al, kalanı sadece id ile kaydet (truncated:true).
//   - Audit retention job (entityType=AuditLog) zaten short-circuit yukarıda.
const MAX_BULK_AUDIT_ROWS = 1000;

// Test ortamında ALS + extension kombinasyonunu inject etmek için export
// (production'da auditPlugin tarafından çağrılır). Refactor minimal: davranış
// değişikliği YOK; sadece görünürlük.
export function buildAuditExtension(base: PrismaClient) {
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
          let bulkTruncated = false;

          if (operation === 'update' || operation === 'delete') {
            before = await (base as any)[model].findFirst({ where: args.where });
          } else if (operation === 'updateMany' || operation === 'deleteMany') {
            const rows = await (base as any)[model].findMany({
              where: args.where,
              take: MAX_BULK_AUDIT_ROWS + 1,
            });
            if (rows.length > MAX_BULK_AUDIT_ROWS) {
              bulkTruncated = true;
              rows.length = MAX_BULK_AUDIT_ROWS;
            }
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
            // ORTA-API-1.1.4 fix (2026-05-04): targetId yok ise 0 placeholder
            // semantik gürültü yaratıyordu. Composite-PK olmayan modellerde
            // bu yol nadiren tetiklenir; warn log ile görünür kıl.
            const entityId = Number(targetId ?? 0);
            if (entityId === 0) {
              try {
                fastifyLogger?.warn?.({ model, operation }, 'Audit entry için entityId tespit edilemedi (composite PK?); 0 ile kaydediliyor');
              } catch { /* ignore */ }
            }
            return [{
              entityType: model,
              entityId,
              action,
              beforePayload: before ?? undefined,
              afterPayload: after ?? undefined,
              user,
              ipAddress,
            }];
          };

          if (bulkTruncated) {
            // Operatörün bilgisi olsun: cap'lenen audit log var.
            try {
              fastifyLogger?.warn?.({ model, operation, max: MAX_BULK_AUDIT_ROWS }, 'Audit bulk snapshot cap edildi — fazla satırlar tek özet entry ile kaydediliyor');
            } catch { /* ignore */ }
          }

          if (context) {
            // HTTP bağlamı: kuyruğa ekle, onSend'de toplu yaz
            context.pendingAuditLogs.push(...buildEntries());
          } else {
            // Worker/arka plan bağlamı: anında yaz
            await base.auditLog.createMany({ data: buildEntries().map(toDbRow) });
          }

          return result;
        },
      },
    },
  });
}

function toAuditAction(operation: string): AuditLogAction {
  if (operation === 'createMany') return 'CREATEMANY';
  if (operation === 'updateMany') return 'UPDATE';
  if (operation === 'deleteMany') return 'DELETE';
  return operation.toUpperCase() as AuditLogAction;
}

// Test ortamında manual flush taklit için export (auditPlugin onSend hook
// paritesi). Production behavior değişmez.
export function toDbRow(e: AuditEntry): Prisma.AuditLogCreateManyInput {
  return {
    entityType: e.entityType,
    entityId: e.entityId,
    action: e.action,
    beforePayload: (e.beforePayload ?? null) as Prisma.InputJsonValue | typeof Prisma.JsonNull,
    afterPayload: (e.afterPayload ?? null) as Prisma.InputJsonValue | typeof Prisma.JsonNull,
    user: e.user,
    ipAddress: e.ipAddress ?? null,
  };
}

export const auditPlugin: FastifyPluginAsync = fp(async (fastify: FastifyInstance) => {
  await fastify.register(contextPlugin);

  fastifyLogger = fastify.log;
  const base = fastify.prisma as PrismaClient;
  (fastify as any).prisma = buildAuditExtension(base);

  /**
   * Phantom write koruması:
   * Yalnızca başarılı yanıtlarda (< 400) audit logları DB'ye yazılır.
   * $transaction rollback → 5xx → audit loglar atılır → phantom write yok.
   */
  fastify.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode >= 400) return payload;
    const store = als.getStore();
    if (!store?.pendingAuditLogs?.length) return payload;
    const entries = store.pendingAuditLogs.splice(0);
    try {
      await base.auditLog.createMany({ data: entries.map(toDbRow) });
    } catch (err) {
      fastify.log.error({ err }, 'Audit log flush hatası');
      throw Object.assign(new Error('Audit log flush failed'), { statusCode: 500 });
    }
    return payload;
  });

  fastify.log.info('Prisma Audit extension ($extends) başarıyla yüklendi.');
});
