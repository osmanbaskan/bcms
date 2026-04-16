import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JwtPayload } from '@bcms/shared';

interface AuditParams {
  entityType: string;
  entityId: number;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  before?: unknown;
  after?: unknown;
  request: FastifyRequest;
}

export async function writeAuditLog(
  app: FastifyInstance,
  params: AuditParams,
): Promise<void> {
  const user =
    (params.request.user as JwtPayload | undefined)?.preferred_username ?? 'system';
  const ipAddress =
    params.request.headers['x-forwarded-for']?.toString().split(',')[0].trim() ??
    params.request.ip;

  try {
    await app.prisma.auditLog.create({
      data: {
        entityType:    params.entityType,
        entityId:      params.entityId,
        action:        params.action,
        beforePayload: params.before ? (params.before as object) : undefined,
        afterPayload:  params.after  ? (params.after  as object) : undefined,
        user,
        ipAddress,
      },
    });
  } catch (err) {
    // Audit logging must never break the main flow
    app.log.error({ err }, 'Failed to write audit log');
  }
}
