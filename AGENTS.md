# BCMS Agent Knowledge Base

> This file provides coding discipline, architecture rules, and domain knowledge for any AI agent (Kimi, Claude, GPT, Cursor, etc.) working on the BCMS codebase.

## ⚠️ CRITICAL USER INTERACTION RULE — READ FIRST

**NEVER take any action (file edit, build, git command, docker command, ANYTHING) before stating what you will do and receiving explicit user confirmation.**  
Always explain the exact step you intend to take, wait for the user to respond with approval ("Evet", "Tamam", "Do it", "Yap", "1", etc.), and only then execute.  
This is a hard rule. No exceptions. If the user says "revert", "undo", or "geri al", ask for clarification on the exact scope before proceeding.

## Project Overview

**BCMS** = Broadcast Content Management System. Monorepo with:
- `apps/api` — Fastify 5.8.5 + TypeScript ESM + Prisma 5.22.0 + PostgreSQL 16
- `apps/web` — Angular 21.2.8 standalone, Signals-first, Angular Material M3 Dark
- `packages/shared` — Types, constants, PERMISSIONS map
- 10 Docker services (postgres, rabbitmq, keycloak, api, web, worker, opta-watcher, prometheus, grafana, mailhog)

## Coding Discipline (Mandatory for All Changes)

Before writing any code, follow the 4-phase discipline. Surface-level solutions are prohibited.

### Phase 1: Deep Analysis
1. Decompose requirements: core problem vs secondary concerns.
2. Enumerate edge cases: empty inputs, max inputs, malformed data, concurrency, race conditions.
3. Read existing code before modifying. Identify patterns already in use.
4. Map integration points: who calls this, what does it depend on?

### Phase 2: Architecture & Design
1. Match the problem to an appropriate design pattern (see `.agents/skills/deep-code-engineer/references/design-patterns.md`).
2. Define function signatures, types, and interfaces BEFORE implementation.
3. Prefer composition over inheritance. Use dependency injection.
4. Apply Single Responsibility Principle: one reason to change per module/function.
5. Minimize coupling. Design for testability.

### Phase 3: Implementation Discipline
1. **Validate all inputs** at function entry points with Zod. Fail fast.
2. **Error handling:** Never swallow exceptions silently. Categorize recoverable vs fatal.
3. **Type safety:** Avoid `any`, `unknown` without guards. Prefer explicit typing.
4. **Early returns** to reduce nesting. Keep functions under ~30 lines.
5. **Comments explain WHY, not WHAT.**

### Phase 4: Verification & Refinement
1. Walk through happy path, edge case, and error path.
2. Verify resource cleanup: files closed, connections released, subscriptions cancelled.
3. Apply the quality checklist before delivery (see `.agents/skills/deep-code-engineer/references/quality-checklist.md`).
4. Define unit tests for pure functions. Mock external dependencies.

## BCMS-Specific Architecture Rules

### API / Worker Split (Hard Rule)
- `api` container: `BCMS_BACKGROUND_SERVICES=none` — HTTP only.
- `worker` container: runs `notifications`, `ingest-worker`, `ingest-watcher`, `audit-retention`, `audit-partition`, `outbox-poller`.
- The OPTA watcher is a **separate Python container** (`bcms_opta_watcher`), not a Node background service.
- **Never merge these roles.**

### Prisma Audit Extension (Mandatory for All Writes)
- All writes go through the `$extends` audit plugin in `apps/api/src/plugins/audit.ts`.
- Never disable it. Never use raw SQL (`$queryRaw`) for INSERT/UPDATE/DELETE.
- Raw SQL SELECT is allowed for reports/aggregations only.

### Optimistic Locking
- Applies to `Schedule` and `Booking`.
- Pattern: `version` field + `If-Match` header on PATCH/PUT.
- Use `$transaction` with `updateMany` where clause including `version` check.
- See `apps/api/src/modules/schedules/schedule.service.ts` for the canonical implementation.

### Group-Based Auth (Not Role-Based)
- Keycloak `groups` claim drives authorization.
- 12 groups: `Admin`, `Tekyon`, `Transmisyon`, `Booking`, `YayınPlanlama`, `SystemEng`, `Ingest`, `Kurgu`, `MCR`, `PCR`, `Ses`, `StudyoSefi`.
- `Admin` and `SystemEng` = universal access.
- Never hardcode group strings in routes. Import from `@bcms/shared` `PERMISSIONS` map.
- `app.requireGroup()` with no args = any authenticated user.

### Schedule vs Live-Plan Domain Split (post-B5a Block 2)
- `schedules.usage_scope` is **legacy** — removed in SCHED-B5a Block 2 (2026-05-10). No discriminator column.
- **Schedule (broadcast flow)** canonical row marker: `event_key IS NOT NULL` + structured fields (`schedule_date`, `schedule_time`, `channel_1/2/3_id`, `commercial/logo/format_option_id`). Hard-delete domain.
- **Live-plan** canonical: `live_plan_entries` + structured satellites (`live_plan_technical_details`, `live_plan_transmission_segments`, 25 lookup tables). Soft-delete preserved. JSON/metadata is NOT canonical (K15 lock).
- Filter: use `eventKey: { not: null }` for broadcast row guarantee. Never filter by `usage_scope` (column gone) or via metadata JSON for canonical discrimination.
- Legacy columns still present (B5b scope): `metadata`, `start_time`, `end_time` (reporting). `channel_id` + relation dropped from Prisma in Y5-8 (`70a7150`, 2026-05-11); DB migration `20260511120000_drop_legacy_schedule_channel_id` pending runtime apply.

### Timezone Lock (canonical: Europe/Istanbul)
- Canonical business timezone: **Europe/Istanbul** (IANA). All operational times — schedule, live-plan, ingest, OPTA, reporting, UI input/output, Excel/PDF exports — are Türkiye saati.
- User-entered times in the UI are treated as Türkiye saati; rendered times are shown in Türkiye saati.
- Browser TZ and server/Docker TZ are NOT trusted; route every conversion through a centralized helper.
- DB: `@db.Timestamptz` columns store UTC instants — render/parse via `Europe/Istanbul` helper. `@db.Date / @db.Time` columns are interpreted as Türkiye-naive business date/time. `IngestPlanItem.plannedStartMinute/EndMinute` is a TZ-independent Türkiye day-minute.
- **Forbidden**: `T${time}.000Z` compose for user-entered local times; `toLocaleString / toLocaleDateString / toLocaleTimeString` without an explicit `timeZone` argument.
- `+03:00` literal is allowed only inside a helper as fallback/compose; never spread it into modules.
- B5b reporting and any future time-bound refactor must comply with this lock.

### Error Handling Matrix
| Source | HTTP | Notes |
|--------|------|-------|
| Zod validation | 400 | Returns `issues` array |
| Prisma P2025 | 404 | Record not found |
| Prisma P2002/P2003/P2004 | 409 | Unique/foreign key/exclusion constraint conflict |
| Optimistic lock conflict | 412 | Version mismatch |
| Auth failure | 401/403 | JWT or group check failed |

### Rate Limiting
- Global: 300 req/min per IP.
- Exempt endpoints must set `config: { rateLimit: false }` in route config.
- Currently exempt: `/health`, `/metrics`, `/api/v1/ingest/callback`, `/api/v1/opta/sync`.
- `/opta/sync` also uses timing-safe Bearer token comparison.

### Production Environment Guard
- `SKIP_AUTH=true` is blocked in production by `validateRuntimeEnv()` in `app.ts` AND by `authPlugin`.
- Angular `environment.prod.ts` must be active via `angular.json` `fileReplacements`.

## Frontend Rules (Angular 21)

- **Standalone Components** + **Signals-first**. Prefer `signal()` over `BehaviorSubject` for local state.
- Use `computed()` for derived state.
- Dialogs are standalone components with `MAT_DIALOG_DATA` + `inject()`.
- Keep components under ~300 lines. Extract dialogs and complex forms.
- Use `ngModel` with `[ngModelOptions]="{standalone:true}"` for simple forms.
- Group-based nav visibility via `computed(() => navItems.filter(...))`.

## Security Rules

- JWT: RS256, JWKS endpoint with `cache: true, rateLimit: true`.
- `iss` and `aud`/`azp` validation against allowed lists.
- All secrets listed in `apps/api/src/app.ts` `validateRuntimeEnv()` must be set in production.
- `INGEST_CALLBACK_SECRET`: HMAC-safe comparison via `requireWorkerSecret`.
- `OPTA_SYNC_SECRET`: Bearer token comparison for `/opta/sync`.
- Keycloak Admin API is used by `weekly-shift.routes.ts` and `users.routes.ts`.

## File Locations for Deep Reference

Load these files when the topic is relevant:

| Topic | File |
|-------|------|
| Generic design patterns | `.agents/skills/deep-code-engineer/references/design-patterns.md` |
| Quality checklist | `.agents/skills/deep-code-engineer/references/quality-checklist.md` |
| BCMS architecture (Docker, RabbitMQ, services) | `.agents/skills/deep-code-engineer/references/bcms-architecture.md` |
| BCMS backend patterns (Prisma, auth, Zod, errors) | `.agents/skills/deep-code-engineer/references/bcms-patterns.md` |
| BCMS frontend patterns (Angular, Signals, Keycloak) | `.agents/skills/deep-code-engineer/references/bcms-frontend.md` |
| BCMS security (JWT, groups, audit, secrets) | `.agents/skills/deep-code-engineer/references/bcms-security.md` |
| Full technical audit (latest) | Previous conversation history (2026-04-28) |

## Anti-Patterns to Reject

- God classes / God functions.
- Magic numbers and strings without named constants.
- Deep nesting (arrowhead anti-pattern).
- Copy-paste programming; extract shared logic immediately.
- Premature optimization without profiling data.
- Tight coupling to concrete implementations.
- Leaving TODO/FIXME in delivered code without documentation.
- Bypassing Prisma audit with raw SQL writes.
- Hardcoding group names instead of using `PERMISSIONS` map.
- Using `any` or `unknown` without type guards.

## User Interaction Rule (Mandatory)

**NEVER take action before explaining to the user what you will do and receiving explicit confirmation.**  
Always state your intended action clearly and wait for the user to approve (e.g., "Yes", "OK", "Do it") before executing.  
This applies to all destructive operations (`git checkout`, `git reset`, `rm`, `docker system prune`), builds, and any file modifications.  
If the user says "revert", "undo", or "geri al", ask for clarification on the exact scope before proceeding.
