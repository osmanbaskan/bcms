#!/usr/bin/env node

// BCMS API smoke — minimal post-B5a Block 1 form.
//
// Why minimal:
//   - Legacy `POST/PATCH/DELETE /api/v1/schedules` and the usageScope /
//     channelId payload shape were dropped in SCHED-B5a Block 1
//     (commit 23ef5f4, 2026-05-08). Canonical writes go through
//     `/api/v1/schedules/broadcast/*` and require selectedLivePlanEntryId
//     plus full canonical fields (event_key, schedule_date/time,
//     channel_1/2/3, commercial/logo/format option).
//   - All canonical write endpoints are auth-gated. Running a smoke
//     against them needs a JWT, a live-plan entry to bind to, and a
//     proper cleanup chain. That work is intentionally deferred to a
//     follow-up "canonical smoke" PR.
//
// Current scope:
//   - GET /health (open endpoint) — confirms HTTP layer + database +
//     RabbitMQ + OPTA wiring reach a green state.
//
// Follow-up:
//   - Canonical broadcast-flow smoke (create live-plan entry → create
//     schedule via /broadcast → optimistic-lock PATCH → DELETE → cleanup
//     live-plan entry) with JWT acquisition via Keycloak service account.
//   - Booking optimistic-lock smoke wired against the canonical
//     schedule helper.

const baseUrl = process.env.BCMS_API_URL ?? 'http://127.0.0.1:3000/api/v1';
const rootUrl = baseUrl.replace(/\/api\/v1\/?$/, '');

async function smokeHealth() {
  const response = await fetch(`${rootUrl}/health`);
  if (!response.ok) throw new Error(`health: expected 2xx, got ${response.status}`);
  console.log(`health: ${response.status}`);
}

try {
  await smokeHealth();
  console.log('api smoke: ok');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
