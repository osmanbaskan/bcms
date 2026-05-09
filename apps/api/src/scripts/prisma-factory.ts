import { PrismaClient } from '@prisma/client';
import { buildAuditExtension } from '../plugins/audit.js';

/**
 * Audit-enabled Prisma client factory for one-shot CLI scripts.
 *
 * Why: CLI backfill / maintenance scripts MUST NOT bypass the Prisma `$extends`
 * audit plugin (CLAUDE.md: "All writes MUST go through the Prisma `$extends`
 * audit plugin"). This factory wraps a fresh `PrismaClient` with the same
 * `buildAuditExtension` used by `auditPlugin` in HTTP context.
 *
 * Audit semantics in script context:
 *   - No `als.getStore()` is set (script runs outside a Fastify request).
 *   - The extension's worker/background branch flushes audit entries
 *     IMMEDIATELY via `base.auditLog.createMany(...)` after each write.
 *   - `user` defaults to `'system'` (same convention as background workers).
 *
 * Tests can pass a pre-built base client (e.g. `getRawPrisma()` from the
 * integration helpers) to share the connection pool with the test harness.
 */
export interface AuditedPrismaHandle {
  /** Audit-extended client — use this for ALL writes. */
  client: ReturnType<typeof buildAuditExtension>;
  /** Underlying base client — for $disconnect and direct reads only. */
  base: PrismaClient;
}

export function createAuditedPrisma(base?: PrismaClient): AuditedPrismaHandle {
  const root = base ?? new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
    log: ['warn', 'error'],
  });
  const client = buildAuditExtension(root);
  return { client, base: root };
}
