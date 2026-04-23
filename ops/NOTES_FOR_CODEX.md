# Notes For Future Codex Sessions

BCMS is intended to stay up after terminal closes and PC restarts. Do not switch it back to `ng serve` or `tsx watch` as the primary runtime unless the user explicitly asks for temporary development mode.

Stable runtime:

- API systemd service: `bcms-api-dev.service`
- Web systemd service: `bcms-web-dev.service`
- OPTA mount systemd service: `bcms-opta-mount.service`
- API command: `node /home/ubuntu/Desktop/bcms/apps/api/dist/server.js`
- Web command: `node /home/ubuntu/Desktop/bcms/ops/scripts/bcms-web-static-server.mjs`
- Web serves `apps/web/dist/web/browser`
- Web proxies `/api` and `/webhooks` to `http://127.0.0.1:3000`

Daily commands:

```bash
./ops/scripts/bcms-status.sh
./ops/scripts/bcms-restart.sh
./ops/scripts/bcms-logs.sh
```

Expected URLs:

- Web: `http://172.28.204.133:4200`
- API: `http://172.28.204.133:3000`

Frontend architecture/current UI notes:

- Admin navigation includes three new routes:
  - `Stüdyo Planı` -> `/studio-plan`
  - `Haftalık Shift` -> `/weekly-shift`
  - `Provys İçerik Kontrol` -> `/provys-content-control`
- `apps/web/src/app/features/studio-plan/studio-plan.component.ts` is a
  standalone Angular component for preparing a weekly studio plan on the web.
- The studio plan screen persists to backend through
  `apps/web/src/app/core/services/studio-plan.service.ts`.
- It intentionally does not read/write `schedules`. Studio planning uses its
  own Prisma models and tables:
  - `StudioPlan` -> `studio_plans`
  - `StudioPlanSlot` -> `studio_plan_slots`
- API routes live in `apps/api/src/modules/studio-plans/studio-plan.routes.ts`
  and are registered under `/api/v1/studio-plans`.
- Supported endpoints:
  - `GET /api/v1/studio-plans/:weekStart`
  - `PUT /api/v1/studio-plans/:weekStart`
- `weekStart` must be a Monday date. PUT replaces that week's slot set
  transactionally.
- It supports Monday-Sunday week view, single day view, 06:00-02:00 half-hour
  cells, 5 studio columns per day, program/color select boxes, merged visual
  runs for adjacent same program+color cells, a single-cell eraser, and a
  button that moves the current week cells to the next week.
- `Export PDF` currently uses `window.print()` and print CSS.
- Migration file: `apps/api/prisma/migrations/20260423000000_studio_plans/migration.sql`.
- On 2026-04-23 Prisma Client generation again required the clean reinstall
  pattern: delete `node_modules/.prisma`, `node_modules/@prisma/client`, and
  `node_modules/prisma`, reinstall `prisma@5.22.0` and
  `@prisma/client@5.22.0`, then run `npm run db:generate -w apps/api`.
  Generated client includes `studioPlan` and `studioPlanSlot`.
- `npm run build -w packages/shared`, `npm run build -w apps/api`, and
  `npm run build -w apps/web` passed after this change.
- Migration `20260423000000_studio_plans` was applied successfully on the
  local PostgreSQL DB on 2026-04-23 with
  `npm run db:migrate:prod -w apps/api`.
- `weekly-shift` and `provys-content-control` are placeholder feature
  components until the user defines their business rules.

Reinstall services:

```bash
printf '%s\n' 'ubuntu' | sudo -S ./ops/scripts/bcms-install-system-services.sh
```

Expected healthy state:

- `systemctl is-enabled bcms-api-dev.service bcms-web-dev.service` returns `enabled` for both
- `curl -fsS http://127.0.0.1:3000/health` succeeds
- `curl -fsS http://127.0.0.1:4200/` succeeds
- `curl -fsS http://127.0.0.1:4200/api/v1/channels` succeeds
- `tsx watch` and `ng serve` should not be running

Important local context:

- PostgreSQL is snap-managed: `snap.postgresql.postgresql.service`
- RabbitMQ is `rabbitmq-server.service`
- `.env` uses `SKIP_AUTH=true` for local development
- Correct OPTA_DIR is `/mnt/opta-backups/OPTAfromFTP20511`, not `/home/ubuntu/opta`
- API service depends on `/mnt/opta-backups` through `RequiresMountsFor` and `bcms-opta-mount.service`
- User has provided sudo password as `ubuntu` in this environment

Live plan data rule:

- Records created from the Canli Yayin Plani UI are not generic broadcast schedule records.
- They must carry `usageScope="live-plan"` in the `schedules.usage_scope` DB column.
- `schedules.usage_scope` is the canonical decision point; do not reintroduce metadata JSON filtering for this rule.
- Normal schedule records use `usageScope="broadcast"`.
- DB has `schedules_usage_scope_check` allowing only `broadcast` and `live-plan`.
- Old `metadata.usageScope` transition values were cleaned with migration `20260422000001_cleanup_live_plan_metadata_usage_scope`.
- On 2026-04-22 a broken Prisma generate state was fixed by deleting
  `node_modules/.prisma`, `node_modules/@prisma/client`, and
  `node_modules/prisma`, then reinstalling `prisma@5.22.0` and
  `@prisma/client@5.22.0`.
- After that clean reinstall, generated Prisma Client includes
  `Schedule.usageScope`; API code should use Prisma `usageScope` for
  list/filter/create/update/export/ingest target validation.
- Do not bring back the temporary raw SQL bridge for `usage_scope` unless the
  user explicitly accepts a short-term emergency workaround.
- Generic schedule consumers should use the default `/api/v1/schedules` behavior, which excludes those records.
- Live plan UI/reporting/ingest should query `usage=live-plan` or the dedicated endpoints:
  - `/api/v1/schedules/ingest-candidates`
  - `/api/v1/schedules/reports/live-plan`
  - `/api/v1/schedules/reports/live-plan/export`

Prisma DB baseline:

- On 2026-04-22 the local PostgreSQL schema was inspected and the repo's 8
  Prisma migrations were marked applied with `prisma migrate resolve --applied`.
- `npm run db:migrate:prod -w apps/api` should now report no pending migrations.
- The database still uses legacy PostgreSQL enum type names:
  `booking_status`, `ingest_status`, and `incident_severity`.
- Prisma schema intentionally maps these to TypeScript enum names
  `BookingStatus`, `IngestStatus`, and `IncidentSeverity` with enum `@@map`.
- If booking/ingest/incident Prisma writes fail with a missing PascalCase enum
  type, check generated client freshness before changing DB enum names.
- For a brand-new empty PostgreSQL database, use
  `./ops/scripts/bcms-db-bootstrap-empty.sh`. It refuses to run if the public
  schema already has tables, applies SQL generated from the current Prisma
  schema, then marks existing repo migrations applied.

Security/dependency notes:

- On 2026-04-22 `npm audit fix` removed the moderate `@fastify/static`/`ajv`
  audit findings.
- The vulnerable `xlsx` package had no fix available and was replaced with
  `exceljs`.
- API import accepts `.xlsx` only; do not re-enable `.xls` unless a maintained
  parser is selected and audited.
- `npm run smoke:api` runs health, schedule optimistic lock, booking optimistic
  lock, and playout transition guard checks against the local API.
- GitHub Actions CI lives at `.github/workflows/ci.yml`. It runs npm audit,
  Prisma generate, empty DB bootstrap, full build, starts the API with
  `BCMS_BACKGROUND_SERVICES=none`, and runs `npm run smoke:api`.
- Angular production build has realistic bundle budgets and allows the two
  CommonJS dependencies currently pulled by Keycloak (`base64-js`, `js-sha256`).
  Google Fonts inlining is disabled so CI builds do not depend on fonts network
  fetches.
