# PostgreSQL Restore Runbook

Backups are written by the `postgres_backup` sidecar (`prodrigestivill/postgres-backup-local:16`).
Schedule: daily at 03:00 Europe/Istanbul. Retention: 7 daily + 4 weekly + 6 monthly.
Storage: `infra/postgres/backups/` on host.

> **Current quirk (v1):** The wrapper image (v0.0.11) writes plain SQL files with a misleading
> `.sql.gz` extension — they are NOT actually gzipped. Restore commands below use `cat` rather
> than `gunzip`. Tracked as follow-up: switch to a properly-compressing backup tool, or wrap
> with a post-process gzip step. Backup contract (full pg_dump, daily, retained) is intact.

## Layout

```
infra/postgres/backups/
├── daily/
│   ├── bcms-2026-04-30.sql.gz
│   └── keycloak-2026-04-30.sql.gz
├── weekly/
│   ├── bcms-2026-W17.sql.gz
│   └── keycloak-2026-W17.sql.gz
├── monthly/
│   ├── bcms-2026-04.sql.gz
│   └── keycloak-2026-04.sql.gz
└── last/
    ├── bcms-latest.sql.gz   (symlink, always newest)
    └── keycloak-latest.sql.gz
```

## Restore — single database (bcms)

**Always test on staging first.** Restore overwrites all current data via `--clean --if-exists`.

### 1. Stop dependent services

```bash
docker compose stop api worker web
```

### 2. Restore the dump

```bash
cat infra/postgres/backups/last/bcms-latest.sql.gz | \
  docker exec -i bcms_postgres psql -U bcms_user -d bcms
```

For a specific date:
```bash
cat infra/postgres/backups/daily/bcms-2026-04-30.sql.gz | \
  docker exec -i bcms_postgres psql -U bcms_user -d bcms
```

### 3. Restart services

```bash
docker compose start api worker web
docker compose ps   # verify healthy
```

### 4. Smoke test

```bash
curl -sf http://127.0.0.1:3000/health
docker exec bcms_postgres psql -U bcms_user -d bcms -c \
  "SELECT MAX(timestamp) AS last_audit FROM audit_logs;"
```

## Restore — Keycloak

Keycloak realm config is in the dump but secret material (admin password, client secrets) is also persisted. After restore, **rotate any potentially leaked secrets** if the backup pre-dates a known compromise window.

```bash
docker compose stop api worker web keycloak
cat infra/postgres/backups/last/keycloak-latest.sql.gz | \
  docker exec -i bcms_postgres psql -U bcms_user -d keycloak
docker compose start keycloak
# Wait for keycloak healthy, then:
docker compose start api worker web
```

## Restore — full disaster (postgres_data volume gone)

```bash
# 1. Bring postgres up empty (init scripts will recreate roles/DBs)
docker compose up -d postgres
docker compose exec postgres pg_isready -U bcms_user -d bcms

# 2. Restore both databases
cat infra/postgres/backups/last/bcms-latest.sql.gz | \
  docker exec -i bcms_postgres psql -U bcms_user -d bcms
cat infra/postgres/backups/last/keycloak-latest.sql.gz | \
  docker exec -i bcms_postgres psql -U bcms_user -d keycloak

# 3. Start everything
docker compose up -d
```

> **Note:** The current migrations directory does NOT include a baseline (CREATE TABLE for
> `schedules`, `bookings`, etc.). For a brand-new environment without a backup, the Prisma
> migration deploy alone is insufficient — a SQL dump is required. This is tracked as a
> separate finding ("CRIT-010 baseline migration").

## Verification — backup health

The sidecar exposes a health endpoint on port 8080. Quick check:

```bash
docker exec bcms_postgres_backup wget -qO- http://localhost:8080
# Expected: "OK"
```

List recent backups:

```bash
ls -lh infra/postgres/backups/last/
ls -lh infra/postgres/backups/daily/ | tail -10
```

## Off-host copy (recommended follow-up)

Local volume backup protects against most failures except total host loss. To extend
coverage, add an out-of-band copy:

- **rsync to remote host** (cron on host): `rsync -az --delete infra/postgres/backups/ user@dr-host:/srv/bcms-backups/`
- **S3/B2 sync**: `aws s3 sync infra/postgres/backups/ s3://bcms-backups/ --storage-class STANDARD_IA`
- **borgbackup** to encrypted off-site repo

Pick one based on existing infra. Update this file with the chosen method and credentials handling.

## Recovery drill

Schedule a quarterly drill: take the latest backup, restore to a scratch postgres container, run smoke tests against it. A backup that has never been tested is not a backup.
