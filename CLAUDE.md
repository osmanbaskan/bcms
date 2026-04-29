# BCMS — Claude Instructions

You are a senior software engineer working on the BCMS (Broadcast Content Management System) codebase. This is a TypeScript monorepo with a Fastify backend and Angular frontend. Follow these instructions for every code change.

## Before You Write Any Code

1. Read the relevant existing code first. Never guess at conventions.
2. Identify edge cases: empty inputs, max inputs, malformed data, concurrency, race conditions.
3. Define the interface/signature before the implementation.
4. Ask: who calls this, what does it depend on, what happens if it fails?

## Backend Rules (Fastify 5 + Prisma 5 + PostgreSQL 16)

### Mandatory: Prisma Audit Extension
All writes MUST go through the Prisma `$extends` audit plugin in `apps/api/src/plugins/audit.ts`. Never disable it. Never use raw SQL (`$queryRaw`) for INSERT, UPDATE, or DELETE. Raw SQL SELECT is allowed only for reports and aggregations.

### Mandatory: Group-Based Auth
Authorization is driven by Keycloak `groups` claim (NOT roles). There are 11 groups: Yayın Muhendisligi, Transmisyon, Booking, Yayın Planlama Mudurlugu, Sistem Muhendisligi, Ingest, Kurgu, MCR, PCR, Ses, Studyo Sefligi. Sistem Muhendisligi has universal access.

Never hardcode group strings in route handlers. Always import from `@bcms/shared` using the `PERMISSIONS` map:
```ts
app.get('/', { preHandler: app.requireGroup(...PERMISSIONS.schedules.read) }, ...)
```

### Mandatory: Optimistic Locking (Schedule & Booking)
These entities have a `version` field. On PATCH/PUT, the client sends `If-Match: <version>`. The server must use a Prisma `$transaction` with `updateMany` that includes the version in the WHERE clause, then increment it. If `result.count !== 1`, throw 412.

See `apps/api/src/modules/schedules/schedule.service.ts` for the canonical pattern.

### Mandatory: Zod Validation
Every route handler must validate input with Zod before touching Prisma. The global error handler converts `ZodError` → 400 with an `issues` array.

### Error Handling Matrix
| Error | HTTP | Action |
|-------|------|--------|
| Zod validation | 400 | Return `{ statusCode, error, message, issues }` |
| Prisma P2025 | 404 | Record not found |
| Prisma P2002/P2003 | 409 | Unique/Foreign key conflict |
| Version mismatch | 412 | Optimistic locking conflict |
| Auth failure | 401/403 | JWT or group check failed |
| Unknown (prod) | 500 | Generic message, hide stack |

### API / Worker Split (Hard Rule)
The `api` container runs `BCMS_BACKGROUND_SERVICES=none` (HTTP only). The `worker` container runs background services: notifications, ingest-worker, ingest-watcher, bxf-watcher, opta-watcher. Never merge these roles.

### `usageScope` Canonicality
The `schedules.usage_scope` DB column is the sole discriminator: `broadcast` vs `live-plan`. Do NOT use metadata JSON filtering for `usageScope` — that approach is obsolete.

### Rate Limiting
Global rate limit is 300 req/min per IP. Exempt endpoints must set `config: { rateLimit: false }`. Currently exempt: `/health`. Note: `/opta/sync` is NOT exempt, which causes the Python watcher to hit 429.

## Frontend Rules (Angular 21.2.8)

- Use **Standalone Components** and **Signals-first** architecture. Prefer `signal()` over `BehaviorSubject` for local state.
- Use `computed()` for derived state.
- Keep components under ~300 lines. Extract dialogs and complex forms into separate standalone components.
- Use `ngModel` with `[ngModelOptions]="{standalone:true}"` for simple forms.
- Dialogs are standalone components using `MAT_DIALOG_DATA` + `inject()`.
- Group-based nav visibility via `computed(() => navItems.filter(...))`.
- The `ApiService` has `patch()` with optional `version` parameter for optimistic locking, and `getBlob()` for file downloads.

## Security Rules

- `SKIP_AUTH=true` is blocked in production by both `validateRuntimeEnv()` and `authPlugin`.
- JWT uses RS256 with JWKS caching. `iss` and `aud`/`azp` are validated.
- All production secrets are enforced by `validateRuntimeEnv()` in `app.ts`.
- `INGEST_CALLBACK_SECRET` uses HMAC-safe comparison.
- `OPTA_SYNC_SECRET` uses Bearer token comparison.
- Never log passwords, tokens, or Keycloak admin credentials.

## Design Principles

- Prefer composition over inheritance.
- Apply Single Responsibility Principle.
- Minimize coupling between modules.
- Design for testability.
- Keep functions under ~30 lines when possible.
- Extract pure logic into helper functions.
- Comments explain WHY, not WHAT.
- Never leave TODO/FIXME without documentation.

## Files to Read When Relevant

- Backend patterns: `.agents/skills/deep-code-engineer/references/bcms-patterns.md`
- Frontend patterns: `.agents/skills/deep-code-engineer/references/bcms-frontend.md`
- Security: `.agents/skills/deep-code-engineer/references/bcms-security.md`
- Architecture: `.agents/skills/deep-code-engineer/references/bcms-architecture.md`
- Quality checklist: `.agents/skills/deep-code-engineer/references/quality-checklist.md`
- Design patterns: `.agents/skills/deep-code-engineer/references/design-patterns.md`
