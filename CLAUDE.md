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
Authorization is driven by Keycloak `groups` claim (NOT roles). There are 12 groups (see `packages/shared/src/types/rbac.ts`): `Admin`, `Tekyon`, `Transmisyon`, `Booking`, `YayınPlanlama`, `SystemEng`, `Ingest`, `Kurgu`, `MCR`, `PCR`, `Ses`, `StudyoSefi`. The `Admin` group bypasses every `requireGroup` check via `isAdminPrincipal()` in `apps/api/src/plugins/auth.ts`. `SystemEng` is the operational super-group and is listed explicitly in most `PERMISSIONS` arrays, but it does NOT auto-bypass — it must be enumerated.

Never hardcode group strings in route handlers. Always import from `@bcms/shared` using the `PERMISSIONS` map (or the `GROUP` constant for single-name references):
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
The `api` container runs `BCMS_BACKGROUND_SERVICES=none` (HTTP only). The `worker` container runs background services: `notifications`, `ingest-worker`, `ingest-watcher`, `audit-retention`, `audit-partition`, `outbox-poller`. Never merge these roles. The OPTA watcher is a **separate Python container** (`bcms_opta_watcher`), not a Node background service. BXF watcher (legacy) was removed in SCHED-B5a Block 2 (2026-05-10) — no replacement.

The `audit-retention` job purges `audit_logs` rows older than `AUDIT_RETENTION_DAYS` (default 90) — see `apps/api/src/modules/audit/audit-retention.job.ts`. After changing background services, rebuild with `docker compose up -d --build api worker` — env updates alone don't reload running containers.

### Schedule vs Live-Plan Domain Split (post-B5a Block 2)

`schedules.usage_scope` is **legacy**: removed in SCHED-B5a Block 2 (2026-05-10 migration `20260510120000_sched_b5a_block2_drop_legacy`). The `broadcast` vs `live-plan` discriminator no longer exists. Two separate canonical domains:

- **Schedule (broadcast flow)** — `schedules` table; canonical row marker is `event_key IS NOT NULL`. Required structured fields: `event_key`, `selected_live_plan_entry_id`, `schedule_date`, `schedule_time`, plus 3 channel slots (`channel_1_id` / `channel_2_id` / `channel_3_id`) and 3 lookup options (`commercial_option_id`, `logo_option_id`, `format_option_id`). Hard-delete domain (no `deleted_at` column).
- **Live-plan** — `live_plan_entries` table + structured satellite tables (`live_plan_technical_details`, `live_plan_transmission_segments`, 25 lookup tables). Soft-delete (`deleted_at`) preserved. JSON/metadata is **NOT** canonical (K15 lock); technical fields are structured DB columns or lookup FKs.

**Filter pattern**: For broadcast row guarantee use `eventKey: { not: null }`. Never filter by `usage_scope` — column is gone. Never filter via metadata JSON keys for canonical discrimination.

**Legacy columns still present (B5b scope, do NOT rely on for new code)**:
- `schedules.metadata`, `schedules.start_time`, `schedules.end_time` — kept for `/schedules/reporting` until B5b reporting canonicalization.
- `schedules.channel_id` + `schedules_channel_id_fkey` + `Schedule.channel` relation — kept for Playout/MCR coupling (Y5-8 follow-up; canonical is the 3-channel slot model).

### Timezone Lock (canonical: Europe/Istanbul)
- Canonical business timezone: **Europe/Istanbul** (IANA). All operational times — schedule, live-plan, ingest, OPTA, reporting, UI input/output, Excel/PDF exports — are Türkiye saati.
- User-entered times in the UI are treated as Türkiye saati; rendered times are shown in Türkiye saati.
- Browser TZ and server/Docker TZ are NOT trusted; route every conversion through a centralized helper.
- DB: `@db.Timestamptz` columns store UTC instants — render/parse via `Europe/Istanbul` helper. `@db.Date / @db.Time` columns are interpreted as Türkiye-naive business date/time. `IngestPlanItem.plannedStartMinute/EndMinute` is a TZ-independent Türkiye day-minute.
- **Forbidden**: `T${time}.000Z` compose for user-entered local times; `toLocaleString / toLocaleDateString / toLocaleTimeString` without an explicit `timeZone` argument.
- `+03:00` literal is allowed only inside a helper as fallback/compose; never spread it into modules.
- B5b reporting and any future time-bound refactor must comply with this lock.

### Rate Limiting
Global rate limit is 300 req/min per IP. Exempt endpoints must set `config: { rateLimit: false }`. Currently exempt: `/health`, `/opta/sync` (Python watcher batch sync), and the ingest `/callback`. The rate-limit `keyGenerator` reads `X-Real-IP` first so nginx-forwarded IPs are preserved.

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
