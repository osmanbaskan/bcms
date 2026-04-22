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
