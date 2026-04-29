# BCMS Security Reference

Load this reference when implementing authentication, authorization, audit, or any security-sensitive code.

## Identity Model

- **Group-based** (not role-based). Keycloak `groups` claim via `oidc-group-membership-mapper`.
- 11 valid groups: `Tekyon`, `Transmisyon`, `Booking`, `YayınPlanlama`, `SystemEng`, `Ingest`, `Kurgu`, `MCR`, `PCR`, `Ses`, `StudyoSefi`.
- `SystemEng` = universal access to all routes and nav items.

## JWT Verification

- Algorithm: RS256
- JWKS endpoint: `${KEYCLOAK_URL}/realms/${realm}/protocol/openid-connect/certs`
- `jwks-rsa` with `cache: true, rateLimit: true`
- `iss` and `aud`/`azp` validation against allowed lists.
- Token decode: `{ complete: true }` to access header `kid`.

## SKIP_AUTH Guard (Production Block)

**Blocked in two places:**
1. `validateRuntimeEnv()` in `app.ts`: throws if `NODE_ENV=production` and `SKIP_AUTH=true`.
2. `authPlugin`: throws if `NODE_ENV=production` and `SKIP_AUTH=true`.

**Dev behavior:** `SKIP_AUTH=true` → all requests treated as `dev-admin` with `groups: ['SystemEng']`.

## Rate Limiting

- Global: 300 req/min per IP (`x-real-ip` header preferred, fallback `req.ip`).
- `skipOnError: true` — if Redis/memory store fails, requests are not blocked.
- **Exempt endpoints:** Must set `config: { rateLimit: false }` in route config.
- Currently exempt: `/health`.
- **Known gap:** `/opta/sync` is NOT exempt, causing OPTA watcher 429 errors.

## Audit Logging

- All writes (create/update/delete/upsert/createMany/updateMany/deleteMany) are logged.
- Captured: `entityType`, `entityId`, `action`, `beforePayload`, `afterPayload`, `user`, `ipAddress`, `timestamp`.
- Phantom-write protection: logs queued in ALS, flushed only on successful response (< 400).
- Worker writes: logged immediately (no ALS context).
- Raw SQL writes bypass audit — **forbidden**.

## Input Sanitization

- **API:** Zod schemas validate all inputs. No raw user input reaches Prisma queries.
- **Frontend:** `escapeHtml()` used in `printableHtml()` for PDF generation. Angular's built-in sanitization protects templates.
- **Excel:** `exceljs` handles cell values; no formula injection risk in current usage.

## Secrets & Credentials

**Required in production:**
```
DATABASE_URL
RABBITMQ_URL
CORS_ORIGIN
KEYCLOAK_CLIENT_ID
KEYCLOAK_ADMIN_PASSWORD
INGEST_CALLBACK_SECRET
INGEST_ALLOWED_ROOTS
OPTA_SYNC_SECRET
```

- `INGEST_CALLBACK_SECRET`: HMAC-safe comparison via `requireWorkerSecret` in `ingest.routes.ts`.
- `OPTA_SYNC_SECRET`: Bearer token comparison for `/opta/sync`.
- Keycloak admin password used by `weekly-shift.routes.ts` for Admin API token retrieval.

## Permission Map (PERMISSIONS)

Defined in `packages/shared/src/`. Each module exports read/write/delete arrays of group names.

Example:
```ts
export const PERMISSIONS = {
  schedules: { read: ['SystemEng', 'Tekyon', ...], write: ['SystemEng', 'Booking', ...] },
  bookings:  { read: ['SystemEng'], write: ['SystemEng'] },
  ...
};
```

Never hardcode group strings in route handlers. Always import from `@bcms/shared`.

## Keycloak Admin API Usage

`weekly-shift.routes.ts` and `users.routes.ts` call Keycloak Admin API:
- Token: `grant_type=password` against `admin-cli` client in master realm.
- Cached: `adminToken` + `tokenExpiry` with 10s buffer.
- Scope: user listing, group membership, attribute updates.
