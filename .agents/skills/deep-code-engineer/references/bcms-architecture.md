# BCMS Architecture Reference

Load this reference when designing new backend modules, infrastructure changes, or service interactions.

## Runtime Topology

10-service Docker Compose (`docker-compose.yml`):

| Service | Port | Role |
|---------|------|------|
| postgres | 5433:5432 | PostgreSQL 16 — single source of truth |
| rabbitmq | 5673:5672, 127.0.0.1:15673:15672 | 7 durable queues |
| keycloak | 8080 | Keycloak 23 — group-based identity |
| api | 127.0.0.1:3000:3000 | Fastify 5.8.5 — HTTP only |
| web | 4200:80 | Angular 21 + nginx |
| worker | — | Background services only |
| opta-watcher | host network | Python SMB watcher |
| prometheus | 127.0.0.1:9090 | Metrics (localhost-only) |
| grafana | 3001 | Dashboards |
| mailhog | — | Email testing |

## API / Worker Split (Hard Rule)

- `api` container: `BCMS_BACKGROUND_SERVICES=none` — serves HTTP only.
- `worker` container: runs `notifications`, `ingest-worker`, `ingest-watcher`, `audit-retention`, `audit-partition`, `outbox-poller`. OPTA watcher is a separate Python container. BXF watcher removed in SCHED-B5a Block 2 (2026-05-10).
- **Never** merge these roles. The `app.ts` factory uses `enabledBackgroundServices()` parsed from `BCMS_BACKGROUND_SERVICES` env.

## RabbitMQ Queues (Durable)

```ts
SCHEDULE_CREATED
SCHEDULE_UPDATED
BOOKING_CREATED
INGEST_NEW
INGEST_COMPLETED
NOTIFICATIONS_EMAIL
NOTIFICATIONS_SLACK
```

If RabbitMQ is unavailable in non-production, the app logs a warning and continues (messages are lost). In production, missing RabbitMQ is fatal.

## Health Check

`GET /health` — rate-limit exempt. Checks:
- Database (`SELECT 1`)
- RabbitMQ (`isConnected()`)
- OPTA (`getOptaWatcherStatus().connected` or `fs.stat` fallback)

Returns `200` or `503` with a `checks` object.

## Background Service Registration

New background services must:
1. Be added to `BACKGROUND_SERVICES` array in `app.ts`
2. Have a `startXxx(app)` entry point
3. Be called inside `startBackgroundServices(app)`
4. Respect the `BCMS_BACKGROUND_SERVICES` env filter

## Turborepo / Monorepo Layout

```
apps/
  api/       — Fastify ESM backend
  web/       — Angular 21 frontend
packages/
  shared/    — Types, constants, PERMISSIONS map
infra/       — Docker, Grafana, Keycloak, Postgres, Prometheus, RabbitMQ
```
