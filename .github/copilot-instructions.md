# Copilot Instructions for BCMS

## Project Overview
BCMS = Broadcast Content Management System. Monorepo with Fastify 5.8.5 backend (TypeScript ESM, Prisma 5.22.0, PostgreSQL 16) and Angular 21.2.8 frontend (standalone components, Signals-first, Angular Material M3 Dark). 10 Docker services including Keycloak 23, RabbitMQ 3.12, Prometheus, Grafana.

## Critical Rules

### 1. Prisma Audit Extension (Non-Negotiable)
All database writes MUST go through the Prisma `$extends` audit plugin in `apps/api/src/plugins/audit.ts`. Never disable it. Never use raw SQL (`$queryRaw`) for INSERT, UPDATE, or DELETE operations. Raw SQL SELECT is permitted only for read-only reports and aggregations.

### 2. Group-Based Authorization (Not Role-Based)
Authorization uses Keycloak `groups` claim. There are 11 valid groups: Yayın Muhendisligi, Transmisyon, Booking, Yayın Planlama Mudurlugu, Sistem Muhendisligi, Ingest, Kurgu, MCR, PCR, Ses, Studyo Sefligi. The `Sistem Muhendisligi` group has universal access to all endpoints and navigation items.

Always import group permissions from `@bcms/shared` using the `PERMISSIONS` map. Never hardcode group name strings in route handlers.

Example:
```typescript
app.get('/', { preHandler: app.requireGroup(...PERMISSIONS.schedules.read) }, handler)
```

### 3. Optimistic Locking for Schedule and Booking
Both entities have a `version` field. All PATCH/PUT requests must accept an `If-Match` header containing the expected version. Implement updates using a Prisma `$transaction` with `updateMany` that includes the version in the WHERE clause, then increment the version in the data. If `result.count !== 1`, return HTTP 412.

Canonical implementation: `apps/api/src/modules/schedules/schedule.service.ts`

### 4. Input Validation
Every API route handler must validate all input using Zod schemas before any Prisma operation. The global error handler in `app.ts` automatically converts `ZodError` into HTTP 400 with a detailed `issues` array.

### 5. API and Worker Role Separation
The `api` Docker container runs `BCMS_BACKGROUND_SERVICES=none` and serves HTTP only. The `worker` container runs background services (notifications, ingest-worker, ingest-watcher, bxf-watcher, opta-watcher). These roles must never be merged.

## Error Handling Standards

| Error Type | HTTP Status | Response Format |
|------------|-------------|-----------------|
| Zod validation failure | 400 | `{ statusCode, error, message, issues }` |
| Prisma P2025 (not found) | 404 | `{ statusCode, error, message }` |
| Prisma P2002/P2003 (conflict) | 409 | `{ statusCode, error, message }` |
| Optimistic locking conflict | 412 | `{ statusCode, error, message }` |
| Authentication failure | 401 | `{ statusCode, error, message }` |
| Authorization failure | 403 | `{ statusCode, error, message }` |
| Unknown error (production) | 500 | Generic message, stack trace hidden |

## Frontend Standards

- Use Angular 21 standalone components with Signals-first state management.
- Prefer `signal()` and `computed()` over RxJS `BehaviorSubject` for component-local state.
- Keep components under approximately 300 lines; extract dialogs and complex forms into separate standalone components.
- Use `ngModel` with `[ngModelOptions]="{standalone:true}"` for simple forms.
- Dialogs are standalone components using `MAT_DIALOG_DATA` and `inject()`.
- Group-based navigation visibility uses `computed(() => navItems.filter(...))`.

## Security Standards

- `SKIP_AUTH=true` is blocked in production by both `validateRuntimeEnv()` in `app.ts` and the auth plugin.
- JWT verification uses RS256 with JWKS endpoint caching. Both `iss` and `aud`/`azp` claims are validated.
- Global rate limiting: 300 requests per minute per IP. Exempt endpoints must explicitly set `config: { rateLimit: false }`.
- Never log passwords, tokens, or Keycloak admin credentials.

## Code Quality

- Prefer composition over inheritance.
- Apply Single Responsibility Principle.
- Keep functions under approximately 30 lines; extract pure logic into helpers.
- Use early returns to reduce nesting depth.
- Comments should explain WHY, not WHAT.
- Avoid magic numbers and strings without named constants.
- Avoid deep nesting (arrowhead anti-pattern).
- Do not leave TODO or FIXME comments in delivered code without accompanying documentation.

## Reference Files

When working on specific areas, read these reference files:
- Backend patterns: `.agents/skills/deep-code-engineer/references/bcms-patterns.md`
- Frontend patterns: `.agents/skills/deep-code-engineer/references/bcms-frontend.md`
- Security details: `.agents/skills/deep-code-engineer/references/bcms-security.md`
- Architecture overview: `.agents/skills/deep-code-engineer/references/bcms-architecture.md`
