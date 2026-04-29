# BCMS Backend Patterns Reference

Load this reference when writing or editing API routes, services, Prisma models, or plugins.

## 1. Prisma Audit Extension (Mandatory for All Writes)

**Rule:** All writes go through the `$extends` audit plugin in `plugins/audit.ts`. Never disable it. Never use raw SQL for writes.

**How it works:**
- AsyncLocalStorage (`als`) stores request context (`userId`, `ipAddress`, `pendingAuditLogs`).
- `$allOperations` intercepts: `create`, `update`, `upsert`, `delete`, `createMany`, `updateMany`, `deleteMany`.
- `updateMany`/`deleteMany`: full before-snapshots are captured (not just IDs).
- Phantom-write protection: entries queued in ALS during request; flushed in `onResponse` only if status < 400.
- Worker context (no ALS store): writes audit logs immediately.

**Consequence:** If you bypass Prisma (e.g., raw SQL `$queryRaw` for `INSERT`/`UPDATE`/`DELETE`), audit logs are lost.

## 2. Optimistic Locking

**Applies to:** `Schedule` and `Booking` entities.

**Pattern:**
1. Entity has a `version: Int @default(1)` field.
2. Client sends `If-Match: <version>` header on PATCH/PUT.
3. Server uses `$transaction` with `updateMany`:
   ```ts
   await tx.model.updateMany({ where: { id, version: ifMatchVersion }, data: { ...data, version: { increment: 1 } } });
   if (result.count !== 1) throw { statusCode: 412 };
   return tx.model.findUniqueOrThrow({ where: { id } });
   ```
4. Service layer (`schedule.service.ts`, `booking.service.ts`) wraps this logic.

**Never** use `update` directly for these entities without version check.

## 3. Group-Based Auth (Not Role-Based)

**Rule:** Keycloak `groups` claim drives authorization. `SystemEng` group has universal access.

**Pattern:**
```ts
app.get('/', { preHandler: app.requireGroup(...PERMISSIONS.schedules.read) }, ...)
```

- `PERMISSIONS` map is defined in `packages/shared/src/`.
- `app.requireGroup()` with no args = any authenticated user.
- Never hardcode group names in routes; always use `PERMISSIONS` map.

## 4. Zod Validation

**Rule:** Every route handler validates input with Zod before touching Prisma.

**Pattern:**
```ts
const querySchema = z.object({ page: z.coerce.number().int().positive().default(1) });
const dto = querySchema.parse(request.query); // 400 on failure
```

**Global error handler** in `app.ts` converts `ZodError` → `400` with `issues` array.

## 5. Error Handling Conventions

| Source | HTTP | Response |
|--------|------|----------|
| Zod validation | 400 | `{ statusCode, error, message, issues }` |
| Prisma P2025 | 404 | `{ statusCode, error, message }` |
| Prisma P2002/P2003 | 409 | `{ statusCode, error, message }` |
| Optimistic lock conflict | 412 | `{ statusCode, error, message }` |
| Auth failure | 401/403 | `{ statusCode, error, message }` |
| Unknown (production) | 500 | Generic message (stack hidden) |
| Unknown (dev) | 500 | Full error details |

**Pattern for throwing:**
```ts
throw Object.assign(new Error('message'), { statusCode: 404 });
```

## 6. Prisma Schema Conventions

- `@map("snake_case")` for all DB columns.
- `@db.VarChar(n)` for strings with limits.
- `@@index(...)` for query paths.
- `@@map("snake_case_plural")` for table names.
- Soft delete via `active` Boolean (Channel) or `deletedAt` timestamp (ShiftAssignment).
- Enums map to PascalCase with `@@map("snake_case")`.

## 7. Background Worker Patterns

- Workers receive the same Fastify app instance but with `BCMS_BACKGROUND_SERVICES=none` on the API.
- Use `app.rabbitmq.consume()` to process queues.
- Use `app.prisma` for DB access.
- Audit logs are written immediately (no ALS in worker context).

## 8. Raw SQL Guidelines

**Allowed:** `SELECT` queries, aggregations, reports (`$queryRaw`).
**Forbidden:** `INSERT`, `UPDATE`, `DELETE` via raw SQL (bypasses audit).

When using `$queryRaw`, always parameterize with Prisma's tagged template literals to prevent SQL injection.
