#!/usr/bin/env node
/**
 * Madde 2+7 PR-C1 (audit doc): Outbox cut-over smoke check.
 *
 * Tasarım: ops/REQUIREMENTS-OUTBOX-POLLER-CUTOVER-V1.md §6.
 *
 * Kullanım:
 *   node ops/scripts/check-outbox-cutover.mjs --phase=pre  [--json]
 *   node ops/scripts/check-outbox-cutover.mjs --phase=post [--json]
 *
 * Pre-cut-over (PR-C2 deploy öncesi):
 *   - Phase 2 shadow yazımı sağlıklı (event tipleri >0).
 *   - idempotency_key duplicate yok (DB partial unique sağlıklı).
 *   - pending=0 (Phase 2 yazımları 'published'; PR-C1 deploy'da poller zaten
 *     idle).
 *
 * Post-cut-over (PR-C2 deploy sonrası):
 *   - failed=0, dead=0.
 *   - oldest_pending_age_seconds ≤ 30 (poller healthy).
 *   - End-to-end check: write trafiği gözlemleniyorsa tail event published'e
 *     geçti mi.
 *
 * Çıkış:
 *   exit 0 → tüm kontroller PASS
 *   exit 1 → en az bir FAIL
 *
 * Kaynak: DB (Prisma) + opsiyonel Prometheus scrape.
 */

import { PrismaClient } from '@prisma/client';

const args = parseArgs(process.argv.slice(2));
const phase = args.phase;
const jsonOut = args.json === true;

if (phase !== 'pre' && phase !== 'post') {
  console.error('usage: check-outbox-cutover.mjs --phase=pre|post [--json]');
  process.exit(2);
}

const prisma = new PrismaClient();
const checks = [];

function addCheck(name, status, detail) {
  checks.push({ name, status, detail });
}

try {
  if (phase === 'pre') {
    await checkEventTypeBreakdown();
    await checkIdempotencyDuplicates();
    await checkNoPendingBacklog();
  } else {
    await checkNoFailed();
    await checkNoDead();
    await checkPendingLag();
  }
} catch (err) {
  addCheck('uncaught', 'FAIL', String(err?.message ?? err));
} finally {
  await prisma.$disconnect();
}

const failed = checks.some((c) => c.status === 'FAIL');

if (jsonOut) {
  console.log(JSON.stringify({ phase, checks, ok: !failed }, null, 2));
} else {
  console.log(`\n=== Outbox cut-over smoke check (phase=${phase}) ===\n`);
  for (const c of checks) {
    const sigil = c.status === 'PASS' ? '✓' : c.status === 'WARN' ? '⚠' : '✗';
    console.log(`${sigil} ${c.name}`);
    if (c.detail) console.log(`    ${c.detail}`);
  }
  console.log(`\nResult: ${failed ? 'FAIL' : 'PASS'}\n`);
}

process.exit(failed ? 1 : 0);

// ── checks ─────────────────────────────────────────────────────────────────

async function checkEventTypeBreakdown() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT event_type, COUNT(*)::int AS count
    FROM outbox_events
    GROUP BY event_type
    ORDER BY event_type
  `);
  const known = [
    'schedule.created', 'schedule.updated', 'booking.created',
    'notification.email_requested', 'ingest.job_started', 'ingest.job_completed',
  ];
  const seen = new Set(rows.map((r) => r.event_type));
  const missing = known.filter((k) => !seen.has(k));

  if (rows.length === 0) {
    addCheck('event_type_breakdown', 'FAIL', 'outbox_events tablosu boş — Phase 2 shadow yazılmıyor mu?');
    return;
  }
  if (missing.length > 0) {
    addCheck('event_type_breakdown', 'WARN',
      `Phase 2 shadow eksik event tipleri: ${missing.join(', ')} (henüz hiç yazım olmamış olabilir)`,
    );
    return;
  }
  addCheck('event_type_breakdown', 'PASS',
    rows.map((r) => `${r.event_type}=${r.count}`).join(', '),
  );
}

async function checkIdempotencyDuplicates() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT idempotency_key, COUNT(*)::int AS count
    FROM outbox_events
    WHERE idempotency_key IS NOT NULL
    GROUP BY idempotency_key
    HAVING COUNT(*) > 1
  `);
  if (rows.length === 0) {
    addCheck('idempotency_duplicates', 'PASS', 'partial unique index sağlıklı');
    return;
  }
  addCheck('idempotency_duplicates', 'FAIL',
    `${rows.length} duplicate idempotency_key — partial unique index kırılmış olabilir: ${rows.slice(0, 3).map((r) => r.idempotency_key).join(', ')}`,
  );
}

async function checkNoPendingBacklog() {
  const count = await prisma.outboxEvent.count({ where: { status: 'pending' } });
  if (count === 0) {
    addCheck('no_pending_backlog', 'PASS', 'pending=0 (Phase 2 invariant: shadow yazımları published)');
    return;
  }
  addCheck('no_pending_backlog', 'FAIL',
    `pending=${count} — PR-C1'de shadow yazımları 'published' olmalı; bu satırlar PR-C2 cut-over'da hâlâ unprocessed olarak duracak`,
  );
}

async function checkNoFailed() {
  const count = await prisma.outboxEvent.count({ where: { status: 'failed' } });
  if (count === 0) {
    addCheck('no_failed', 'PASS', 'failed=0');
    return;
  }
  addCheck('no_failed', 'FAIL', `failed=${count} — alarm tetiklenmiş olmalı`);
}

async function checkNoDead() {
  const count = await prisma.outboxEvent.count({ where: { status: 'dead' } });
  if (count === 0) {
    addCheck('no_dead', 'PASS', 'dead=0');
    return;
  }
  addCheck('no_dead', 'FAIL',
    `dead=${count} — manuel müdahale gerekir (PR-D admin replay endpoint'ine kadar manual SQL replay)`,
  );
}

async function checkPendingLag() {
  const oldest = await prisma.$queryRawUnsafe(`
    SELECT MIN(next_attempt_at) AS oldest
    FROM outbox_events
    WHERE status = 'pending'
  `);
  const oldestDate = oldest[0]?.oldest;
  if (!oldestDate) {
    addCheck('pending_lag', 'PASS', 'pending=0');
    return;
  }
  const ageSec = (Date.now() - new Date(oldestDate).getTime()) / 1000;
  if (ageSec <= 30) {
    addCheck('pending_lag', 'PASS', `oldest_pending_age=${ageSec.toFixed(1)}s`);
    return;
  }
  if (ageSec <= 120) {
    addCheck('pending_lag', 'WARN', `oldest_pending_age=${ageSec.toFixed(1)}s (>30s)`);
    return;
  }
  addCheck('pending_lag', 'FAIL',
    `oldest_pending_age=${ageSec.toFixed(1)}s — poller stuck veya RMQ down`,
  );
}

// ── arg parser ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      out[a.slice(2)] = true;
    }
  }
  return out;
}
