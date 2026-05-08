import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import {
  cleanupTransactional,
  getRawPrisma,
  makeAppHarness,
  type TestAppHarness,
} from '../../../test/integration/helpers.js';
import { cascadeOptaUpdates, type CascadeMatchUpdate } from './opta-cascade.service.js';
import { als, auditPlugin, buildAuditExtension, toDbRow } from '../../plugins/audit.js';
import { prismaPlugin } from '../../plugins/prisma.js';
import { optaSyncRoutes } from './opta.sync.routes.js';

const TEST_OPTA_SECRET = 'test-opta-secret-b3c';

/**
 * Mini Fastify app — route-level cascade testleri için (T13 audit actor +
 * T17 success path manualReconcileRequired). Production buildApp'in tam
 * stack'i yerine: prismaPlugin + auditPlugin + rabbitmq mock + opta routes.
 * Diğer pluginler (auth/rate-limit/swagger) cascade davranışı için gereksiz.
 */
async function buildOptaTestApp(): Promise<FastifyInstance> {
  process.env.OPTA_SYNC_SECRET = TEST_OPTA_SECRET;
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(auditPlugin);
  // RabbitMQ stub (cascade direct publish best-effort, no-op test scope).
  app.decorate('rabbitmq', {
    isConnected: () => true,
    publish:     async () => {},
    consume:     async () => {},
    close:       async () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  await app.register(optaSyncRoutes, { prefix: '/api/v1/opta' });
  await app.ready();
  return app;
}

/**
 * SCHED-B3c spec — OPTA sync cascade core (KO1-KO14).
 *
 * Test kapsamı (REQUIREMENTS-SCHEDULE-OPTA-SYNC-V1.md §3.2 paritesi):
 *   ✓ T1  Yeni match → live-plan/schedule create EDİLMEZ (KO6)
 *   ✓ T2  matchDate diff → eventStartTime + eventEndTime cascade (duration korunur) (KO9)
 *   ✓ T3  homeTeam/awayTeam diff → team1/2Name cascade (KO4)
 *   ✓ T4  Schedule canonical update + legacy start/end placeholder dual-write (KO3)
 *   ✓ T5  Aynı eventKey duplicate hepsi update (KO7 multi-target; KO1 skip yok)
 *   ✓ T6  live-plan COMPLETED → SKIP (KO14)
 *   ✓ T7  live-plan CANCELLED → SKIP (KO14)
 *   ✓ T8  live-plan IN_PROGRESS → UPDATE OK (KO14)
 *   ✓ T9  schedule ON_AIR → SKIP (KO14)
 *   ✓ T10 Only-changed-fields: diff yok → update YOK + outbox YOK (KO12)
 *   ✓ T11 Outbox `live_plan.updated` payload (livePlanEntryId, matchId,
 *         matchUid, source:'opta-sync', changedFields[]) (KO11)
 *   ✓ T12 Outbox `schedule.updated` payload (KO11)
 *   ✓ T14 metadata.transStart/transEnd shift edilmez (KO5)
 *
 *   ✓ T13 Audit actor `system:opta-sync` — route-level (mini Fastify +
 *         auditPlugin + inject); audit_logs.user assert (KO10)
 *   ✓ T16 Cascade service conflict counter + rollback (cascade tx error
 *         → livePlanConflicts++ + entry rollback) — service-level (KO13)
 *   ✓ T17 Route success → manualReconcileRequired=false +
 *         cascadedLivePlanEntries response shape (KO13 success path)
 *
 * Residual risk:
 * - T16 route-level test edilmedi: cascade tx error route üzerinden induce
 *   etmek zor (matchId connect P2025 path'i sync ana tx'i match'i upsert
 *   ettiği için route-level engellenir). T17 success path response shape'ini
 *   doğrular; tx-error → manualReconcileRequired=true assertion service-level
 *   counter ile birleştirildi (cascadeOptaUpdates conflict counter ↔ route
 *   response.manualReconcileRequired bağı doğrudan kod inceleme ile teyit edildi
 *   `opta.sync.routes.ts:livePlanCascadeConflicts > 0`).
 *
 * T15 (concurrency) — flaky riski; KO1 single-thread "skip yok + version++"
 *   davranışı T5 multi-target ve T2/T3 update path'lerinde implicit assert.
 */

const FIXED_NOW    = new Date('2026-06-01T19:00:00Z');
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// League.code VARCHAR(20). Route `opta-${compId}` pattern'iyle uyum: compId='L1'
// → code='opta-L1' (7 char). makeLeague helper aynı code'u kullanır ki route
// ana tx'i existing'i bulup skip etsin (no name diff → no conflict).
const TEST_COMP_ID    = 'L1';
const TEST_LEAGUE_CODE = `opta-${TEST_COMP_ID}`;
const TEST_COMP_NAME  = 'Test Lig';

async function makeLeague() {
  // leagues TRANSACTIONAL_TABLES'da YOK (seed-tier); var-ise reuse, yoksa
  // create. RESTART IDENTITY sequence drift'i upsert path'inde id conflict'e
  // sebep olabiliyor — explicit findUnique-then-create daha güvenli.
  const prisma = getRawPrisma();
  const existing = await prisma.league.findUnique({ where: { code: TEST_LEAGUE_CODE } });
  if (existing) return existing;
  return prisma.league.create({
    data: { code: TEST_LEAGUE_CODE, name: TEST_COMP_NAME, country: 'TR' },
  });
}

async function makeMatch(opts: {
  leagueId: number;
  optaUid:  string;
  homeTeamName?: string;
  awayTeamName?: string;
  matchDate?: Date;
}) {
  const prisma = getRawPrisma();
  return prisma.match.create({
    data: {
      leagueId:     opts.leagueId,
      optaUid:      opts.optaUid,
      homeTeamName: opts.homeTeamName ?? 'A',
      awayTeamName: opts.awayTeamName ?? 'B',
      matchDate:    opts.matchDate    ?? FIXED_NOW,
      season:       '2026',
    },
  });
}

async function makeOptaLivePlanEntry(opts: {
  matchId:       number;
  optaUid:       string;
  eventStart?:   Date;
  eventEnd?:     Date;
  team1Name?:    string | null;
  team2Name?:    string | null;
  status?:       'PLANNED' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
}) {
  const prisma = getRawPrisma();
  return prisma.livePlanEntry.create({
    data: {
      title:          `Test entry ${opts.optaUid}`,
      eventStartTime: opts.eventStart ?? FIXED_NOW,
      eventEndTime:   opts.eventEnd   ?? new Date(FIXED_NOW.getTime() + TWO_HOURS_MS),
      sourceType:     'OPTA',
      eventKey:       `opta:${opts.optaUid}`,
      optaMatchId:    opts.optaUid,
      matchId:        opts.matchId,
      team1Name:      opts.team1Name ?? 'A',
      team2Name:      opts.team2Name ?? 'B',
      status:         opts.status ?? 'PLANNED',
    },
  });
}

async function makeOptaSchedule(opts: {
  optaUid: string;
  status?: 'DRAFT' | 'CONFIRMED' | 'ON_AIR' | 'COMPLETED' | 'CANCELLED';
  team1Name?: string;
  team2Name?: string;
  title?: string;
}) {
  const prisma = getRawPrisma();
  return prisma.schedule.create({
    data: {
      title:        opts.title ?? 'A vs B',
      // Legacy NOT NULL alanlar (B5'e kadar paralel).
      startTime:    FIXED_NOW,
      endTime:      new Date(FIXED_NOW.getTime() + TWO_HOURS_MS),
      createdBy:    'test',
      usageScope:   'broadcast',
      // Canonical
      eventKey:     `opta:${opts.optaUid}`,
      scheduleDate: new Date('2026-06-01T00:00:00Z'),
      scheduleTime: new Date('1970-01-01T19:00:00Z'),
      team1Name:    opts.team1Name ?? 'A',
      team2Name:    opts.team2Name ?? 'B',
      status:       opts.status ?? 'DRAFT',
    },
  });
}

describe('OPTA sync cascade — SCHED-B3c (KO1-KO14)', () => {
  let harness: TestAppHarness;
  let app: FastifyInstance;

  beforeAll(async () => {
    // leagues sequence drift guard — leagues TRANSACTIONAL_TABLES'da YOK; SEED
    // migration kayıtları + sequence drift sebebi ile create id conflict riski.
    // Mevcut MAX(id)'i sequence'a set ederek nextval'ın mantıklı id vermesini
    // garantile.
    const prisma = getRawPrisma();
    await prisma.$executeRaw`SELECT setval('leagues_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM leagues), 1))`;
  });

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    app = harness.app as unknown as FastifyInstance;
  });

  // ─────────────────────────────────────────────────────────────────────
  // T1 — KO6: cascade EXISTING satırları update eder; create YOK
  // ─────────────────────────────────────────────────────────────────────
  test('T1: cascade yeni live-plan/schedule create ETMEZ (KO6)', async () => {
    const league = await makeLeague();
    const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-NEW' });

    const updates: CascadeMatchUpdate[] = [{
      matchId:        match.id,
      matchUid:       'M-NEW',
      newMatchDate:   new Date('2026-06-02T19:00:00Z'),
      homeTeamName:   'X',
      awayTeamName:   'Y',
      hasFieldChange: true,
    }];

    const r = await cascadeOptaUpdates(app, updates);
    expect(r.livePlanEntriesUpdated).toBe(0);
    expect(r.schedulesUpdated).toBe(0);

    const prisma = getRawPrisma();
    expect(await prisma.livePlanEntry.count({ where: { eventKey: 'opta:M-NEW' } })).toBe(0);
    expect(await prisma.schedule.count({ where: { eventKey: 'opta:M-NEW' } })).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // T2 — KO9: matchDate diff → eventStart + eventEnd cascade (duration korunur)
  // ─────────────────────────────────────────────────────────────────────
  test('T2: matchDate diff → eventStartTime + eventEndTime cascade; duration korunur (KO9)', async () => {
    const league = await makeLeague();
    const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T2' });

    const customDuration = 90 * 60 * 1000; // 1h30
    const entry = await makeOptaLivePlanEntry({
      matchId:    match.id,
      optaUid:    'M-T2',
      eventStart: FIXED_NOW,
      eventEnd:   new Date(FIXED_NOW.getTime() + customDuration),
    });

    const newDate = new Date('2026-06-02T20:00:00Z');
    await cascadeOptaUpdates(app, [{
      matchId:        match.id,
      matchUid:       'M-T2',
      newMatchDate:   newDate,
      homeTeamName:   'A', // diff yok
      awayTeamName:   'B',
      hasFieldChange: true,
    }]);

    const prisma  = getRawPrisma();
    const updated = await prisma.livePlanEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(updated.eventStartTime.getTime()).toBe(newDate.getTime());
    expect(updated.eventEndTime.getTime() - updated.eventStartTime.getTime()).toBe(customDuration);
    expect(updated.version).toBe(entry.version + 1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // T3 — KO4: homeTeam/awayTeam diff → team1/2Name cascade
  // ─────────────────────────────────────────────────────────────────────
  test('T3: homeTeam/awayTeam diff → live-plan team1/2Name cascade (KO4)', async () => {
    const league = await makeLeague();
    const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T3' });

    const entry = await makeOptaLivePlanEntry({
      matchId: match.id, optaUid: 'M-T3', team1Name: 'A', team2Name: 'B',
    });

    await cascadeOptaUpdates(app, [{
      matchId:        match.id,
      matchUid:       'M-T3',
      newMatchDate:   null, // tarih diff yok
      homeTeamName:   'NewHome',
      awayTeamName:   'NewAway',
      hasFieldChange: true,
    }]);

    const prisma  = getRawPrisma();
    const updated = await prisma.livePlanEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(updated.team1Name).toBe('NewHome');
    expect(updated.team2Name).toBe('NewAway');
    expect(updated.version).toBe(entry.version + 1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // T4 — KO3: Schedule canonical update + legacy dual-write placeholder
  // ─────────────────────────────────────────────────────────────────────
  test('T4: schedule canonical alanlar + legacy start/end placeholder (KO3)', async () => {
    const league = await makeLeague();
    const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T4' });
    const sch    = await makeOptaSchedule({ optaUid: 'M-T4', team1Name: 'A', team2Name: 'B', title: 'A vs B' });

    const newDate = new Date('2026-06-15T20:30:00Z');
    await cascadeOptaUpdates(app, [{
      matchId:        match.id,
      matchUid:       'M-T4',
      newMatchDate:   newDate,
      homeTeamName:   'NewHome',
      awayTeamName:   'NewAway',
      hasFieldChange: true,
    }]);

    const prisma = getRawPrisma();
    const updated = await prisma.schedule.findUniqueOrThrow({ where: { id: sch.id } });
    expect(updated.title).toBe('NewHome vs NewAway');
    expect(updated.team1Name).toBe('NewHome');
    expect(updated.team2Name).toBe('NewAway');
    // schedule_date UTC midnight of newDate
    expect(updated.scheduleDate?.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    // schedule_time 20:30:00 UTC
    expect(updated.scheduleTime?.toISOString()).toBe('1970-01-01T20:30:00.000Z');
    // Legacy placeholder dual-write
    expect(updated.startTime.getTime()).toBe(newDate.getTime());
    expect(updated.endTime.getTime()).toBe(newDate.getTime() + TWO_HOURS_MS);
    expect(updated.version).toBe(sch.version + 1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // T5 — KO7: Aynı eventKey duplicate live-plan satırlar — hepsi update
  // ─────────────────────────────────────────────────────────────────────
  test('T5: aynı eventKey duplicate live-plan satırların hepsi update (KO7 multi-target; KO1 skip yok)', async () => {
    const league = await makeLeague();
    const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T5' });

    const e1 = await makeOptaLivePlanEntry({ matchId: match.id, optaUid: 'M-T5', team1Name: 'A' });
    const e2 = await makeOptaLivePlanEntry({ matchId: match.id, optaUid: 'M-T5', team1Name: 'A' });
    const e3 = await makeOptaLivePlanEntry({ matchId: match.id, optaUid: 'M-T5', team1Name: 'A' });

    const r = await cascadeOptaUpdates(app, [{
      matchId:        match.id,
      matchUid:       'M-T5',
      newMatchDate:   null,
      homeTeamName:   'NewHome',
      awayTeamName:   'B',
      hasFieldChange: true,
    }]);

    expect(r.livePlanEntriesUpdated).toBe(3);

    const prisma = getRawPrisma();
    for (const id of [e1.id, e2.id, e3.id]) {
      const u = await prisma.livePlanEntry.findUniqueOrThrow({ where: { id } });
      expect(u.team1Name).toBe('NewHome');
      expect(u.version).toBe(2); // entry version 1 → 2
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // T6 / T7 / T8 — KO14: status filter
  // ─────────────────────────────────────────────────────────────────────
  test('T6: live-plan COMPLETED → SKIP (KO14)', async () => {
    const league = await makeLeague();
    const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T6' });
    const entry  = await makeOptaLivePlanEntry({
      matchId: match.id, optaUid: 'M-T6', status: 'COMPLETED', team1Name: 'A',
    });

    const r = await cascadeOptaUpdates(app, [{
      matchId: match.id, matchUid: 'M-T6', newMatchDate: null,
      homeTeamName: 'X', awayTeamName: 'Y', hasFieldChange: true,
    }]);

    expect(r.livePlanEntriesUpdated).toBe(0);
    const prisma  = getRawPrisma();
    const after   = await prisma.livePlanEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.team1Name).toBe('A');
    expect(after.version).toBe(entry.version);
  });

  test('T7: live-plan CANCELLED → SKIP (KO14)', async () => {
    const league = await makeLeague();
    const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T7' });
    const entry  = await makeOptaLivePlanEntry({
      matchId: match.id, optaUid: 'M-T7', status: 'CANCELLED',
    });

    const r = await cascadeOptaUpdates(app, [{
      matchId: match.id, matchUid: 'M-T7', newMatchDate: null,
      homeTeamName: 'X', awayTeamName: 'Y', hasFieldChange: true,
    }]);

    expect(r.livePlanEntriesUpdated).toBe(0);
    const prisma = getRawPrisma();
    const after  = await prisma.livePlanEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.version).toBe(entry.version);
  });

  test('T8: live-plan IN_PROGRESS → UPDATE OK (KO14)', async () => {
    const league = await makeLeague();
    const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T8' });
    const entry  = await makeOptaLivePlanEntry({
      matchId: match.id, optaUid: 'M-T8', status: 'IN_PROGRESS', team1Name: 'A',
    });

    const r = await cascadeOptaUpdates(app, [{
      matchId: match.id, matchUid: 'M-T8', newMatchDate: null,
      homeTeamName: 'NewHome', awayTeamName: 'B', hasFieldChange: true,
    }]);

    expect(r.livePlanEntriesUpdated).toBe(1);
    const prisma = getRawPrisma();
    const after  = await prisma.livePlanEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.team1Name).toBe('NewHome');
    expect(after.version).toBe(entry.version + 1);
  });

  test('T9: schedule ON_AIR → SKIP (KO14)', async () => {
    const league = await makeLeague();
    const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T9' });
    const sch    = await makeOptaSchedule({ optaUid: 'M-T9', status: 'ON_AIR', team1Name: 'A' });

    const r = await cascadeOptaUpdates(app, [{
      matchId: match.id, matchUid: 'M-T9', newMatchDate: null,
      homeTeamName: 'NewHome', awayTeamName: 'B', hasFieldChange: true,
    }]);

    expect(r.schedulesUpdated).toBe(0);
    const prisma = getRawPrisma();
    const after  = await prisma.schedule.findUniqueOrThrow({ where: { id: sch.id } });
    expect(after.team1Name).toBe('A');
    expect(after.version).toBe(sch.version);
  });

  // ─────────────────────────────────────────────────────────────────────
  // T10 — KO12: Only-changed-fields
  // ─────────────────────────────────────────────────────────────────────
  test('T10: diff yok → live-plan/schedule update YOK + outbox YOK (KO12)', async () => {
    const league = await makeLeague();
    const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T10' });
    const entry  = await makeOptaLivePlanEntry({
      matchId: match.id, optaUid: 'M-T10', team1Name: 'A', team2Name: 'B',
    });
    const sch = await makeOptaSchedule({
      optaUid: 'M-T10', team1Name: 'A', team2Name: 'B', title: 'A vs B',
    });

    // hasFieldChange=true ama gerçek diff yok (team adları aynı, matchDate null)
    const r = await cascadeOptaUpdates(app, [{
      matchId: match.id, matchUid: 'M-T10', newMatchDate: null,
      homeTeamName: 'A', awayTeamName: 'B', hasFieldChange: true,
    }]);

    expect(r.livePlanEntriesUpdated).toBe(0);
    expect(r.schedulesUpdated).toBe(0);

    const prisma = getRawPrisma();
    const entryAfter = await prisma.livePlanEntry.findUniqueOrThrow({ where: { id: entry.id } });
    const schAfter   = await prisma.schedule.findUniqueOrThrow({ where: { id: sch.id } });
    expect(entryAfter.version).toBe(entry.version);
    expect(schAfter.version).toBe(sch.version);

    // Outbox: live_plan.updated VEYA schedule.updated YOK
    const outboxRows = await prisma.outboxEvent.findMany({
      where: { eventType: { in: ['live_plan.updated', 'schedule.updated'] } },
    });
    expect(outboxRows).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // T11 — KO11: Outbox live_plan.updated payload
  // ─────────────────────────────────────────────────────────────────────
  test('T11: outbox `live_plan.updated` payload doğru (KO11)', async () => {
    const league = await makeLeague();
    const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T11' });
    const entry  = await makeOptaLivePlanEntry({ matchId: match.id, optaUid: 'M-T11' });

    await cascadeOptaUpdates(app, [{
      matchId: match.id, matchUid: 'M-T11', newMatchDate: null,
      homeTeamName: 'NewHome', awayTeamName: 'NewAway', hasFieldChange: true,
    }]);

    const prisma = getRawPrisma();
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'LivePlanEntry', aggregateId: String(entry.id) },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('live_plan.updated');
    expect(events[0].status).toBe('published');

    const payload = events[0].payload as {
      livePlanEntryId: number; matchId: number; matchUid: string;
      source: string; changedFields: string[];
    };
    expect(payload.livePlanEntryId).toBe(entry.id);
    expect(payload.matchId).toBe(match.id);
    expect(payload.matchUid).toBe('M-T11');
    expect(payload.source).toBe('opta-sync');
    expect(payload.changedFields).toContain('team1Name');
    expect(payload.changedFields).toContain('team2Name');
  });

  // ─────────────────────────────────────────────────────────────────────
  // T12 — KO11: Outbox schedule.updated payload
  // ─────────────────────────────────────────────────────────────────────
  test('T12: outbox `schedule.updated` payload doğru (KO11)', async () => {
    const league = await makeLeague();
    const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T12' });
    const sch    = await makeOptaSchedule({ optaUid: 'M-T12', title: 'A vs B' });

    await cascadeOptaUpdates(app, [{
      matchId: match.id, matchUid: 'M-T12',
      newMatchDate:   new Date('2026-06-15T21:00:00Z'),
      homeTeamName:   'A',
      awayTeamName:   'B',
      hasFieldChange: true,
    }]);

    const prisma = getRawPrisma();
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'Schedule', aggregateId: String(sch.id) },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('schedule.updated');
    expect(events[0].status).toBe('published');

    const payload = events[0].payload as {
      scheduleId: number; matchUid: string; source: string; changedFields: string[];
    };
    expect(payload.scheduleId).toBe(sch.id);
    expect(payload.matchUid).toBe('M-T12');
    expect(payload.source).toBe('opta-sync');
    expect(payload.changedFields).toContain('scheduleDate');
    expect(payload.changedFields).toContain('scheduleTime');
  });

  // ─────────────────────────────────────────────────────────────────────
  // T13 — KO10: Audit actor `system:opta-sync` (route-level)
  // Real Fastify app + auditPlugin + opta routes; POST /api/v1/opta/sync
  // → cascade audit log → user='system:opta-sync' assert.
  // ─────────────────────────────────────────────────────────────────────
  test('T13: route POST /api/v1/opta/sync → audit_logs.user="system:opta-sync" (KO10)', async () => {
    const app = await buildOptaTestApp();
    try {
      const league = await makeLeague();
      const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T13', homeTeamName: 'A' });
      const entry  = await makeOptaLivePlanEntry({
        matchId: match.id, optaUid: 'M-T13', team1Name: 'A',
      });

      const res = await app.inject({
        method: 'POST',
        url:    '/api/v1/opta/sync',
        headers: {
          authorization:  `Bearer ${TEST_OPTA_SECRET}`,
          'content-type': 'application/json',
        },
        payload: {
          matches: [{
            matchUid:  'M-T13',
            compId:    TEST_COMP_ID,
            compName:  TEST_COMP_NAME,
            homeTeam:  'NewHome',
            awayTeam:  'B',
            matchDate: match.matchDate.toISOString(),
          }],
        },
      });
      expect(res.statusCode).toBe(200);

      const baseClient = getRawPrisma();
      const logs = await baseClient.auditLog.findMany({
        where: { entityType: 'LivePlanEntry', entityId: entry.id },
      });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.every((l) => l.user === 'system:opta-sync')).toBe(true);
    } finally {
      await app.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // T17 — KO13 success path: route response manualReconcileRequired=false
  // (cascade error YOK senaryosu; route response shape doğrulama)
  // ─────────────────────────────────────────────────────────────────────
  test('T17: route success → manualReconcileRequired=false + cascadedLivePlanEntries (KO13 success)', async () => {
    const app = await buildOptaTestApp();
    try {
      const league = await makeLeague();
      const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T17' });
      await makeOptaLivePlanEntry({ matchId: match.id, optaUid: 'M-T17', team1Name: 'A' });

      const res = await app.inject({
        method: 'POST',
        url:    '/api/v1/opta/sync',
        headers: {
          authorization:  `Bearer ${TEST_OPTA_SECRET}`,
          'content-type': 'application/json',
        },
        payload: {
          matches: [{
            matchUid:  'M-T17',
            compId:    TEST_COMP_ID,
            compName:  TEST_COMP_NAME,
            homeTeam:  'NewHome', // diff → cascade tetiklenir
            awayTeam:  'B',
            matchDate: match.matchDate.toISOString(),
          }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        cascadedLivePlanEntries: number;
        manualReconcileRequired: boolean;
        livePlanCascadeConflicts: number;
        cascadeError: string | null;
      };
      expect(body.cascadedLivePlanEntries).toBe(1);
      expect(body.manualReconcileRequired).toBe(false);
      expect(body.livePlanCascadeConflicts).toBe(0);
      expect(body.cascadeError).toBeNull();
    } finally {
      await app.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // T16 — KO13: Cascade tx error → conflict counter + rollback (entry korunur)
  // matchId NON-EXISTING ile cascade çağrısı: tx içinde
  // tx.livePlanEntry.update({ data: { match: { connect: { id: 99999999 } } } })
  // → P2025 (record not found in connect) → tx rollback. Counter livePlanConflicts++.
  // ─────────────────────────────────────────────────────────────────────
  test('T16: cascade service conflict counter + rollback (cascade tx error → livePlanConflicts++ + entry rollback) (KO13)', async () => {
    // Beklenen P2025 → cascade per-match try/catch yakalar; Prisma stderr
    // "An operation failed..." log basar (cosmetic). Stub: assert akışı temiz.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const league = await makeLeague();
      const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T16' });
      const entry  = await makeOptaLivePlanEntry({
        matchId: match.id, optaUid: 'M-T16', team1Name: 'A',
      });

      const NON_EXISTING_MATCH_ID = 999_999_999;
      const r = await cascadeOptaUpdates(app, [{
        matchId:        NON_EXISTING_MATCH_ID, // matchId connect → P2025
        matchUid:       'M-T16',
        newMatchDate:   null,
        homeTeamName:   'NewHome',
        awayTeamName:   'NewAway',
        hasFieldChange: true,
      }]);

      expect(r.livePlanConflicts).toBe(1);
      expect(r.livePlanEntriesUpdated).toBe(0);

      // Entry rollback: original değerler korunur, version değişmez.
      const prisma = getRawPrisma();
      const after  = await prisma.livePlanEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(after.team1Name).toBe('A');
      expect(after.version).toBe(entry.version);

      // Outbox shadow event de yazılmamış olmalı (tx rollback).
      const events = await prisma.outboxEvent.findMany({
        where: { aggregateType: 'LivePlanEntry', aggregateId: String(entry.id), eventType: 'live_plan.updated' },
      });
      expect(events).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // T14 — KO5: metadata.transStart/transEnd shift edilmez
  // ─────────────────────────────────────────────────────────────────────
  test('T14: metadata.transStart/transEnd cascade tarafından dokunulmaz (KO5)', async () => {
    const league = await makeLeague();
    const match  = await makeMatch({ leagueId: league.id, optaUid: 'M-T14' });

    // Schedule legacy metadata ile yarat (transStart/transEnd JSON).
    const prisma = getRawPrisma();
    const sch = await prisma.schedule.create({
      data: {
        title:        'A vs B',
        startTime:    FIXED_NOW,
        endTime:      new Date(FIXED_NOW.getTime() + TWO_HOURS_MS),
        createdBy:    'test',
        usageScope:   'broadcast',
        eventKey:     'opta:M-T14',
        scheduleDate: new Date('2026-06-01T00:00:00Z'),
        scheduleTime: new Date('1970-01-01T19:00:00Z'),
        team1Name:    'A',
        team2Name:    'B',
        metadata:     { transStart: '19:30', transEnd: '21:30' },
      },
    });

    await cascadeOptaUpdates(app, [{
      matchId: match.id, matchUid: 'M-T14',
      newMatchDate:   new Date('2026-06-02T22:00:00Z'),
      homeTeamName:   'A',
      awayTeamName:   'B',
      hasFieldChange: true,
    }]);

    const after = await prisma.schedule.findUniqueOrThrow({ where: { id: sch.id } });
    const meta  = (after.metadata ?? {}) as { transStart?: string; transEnd?: string };
    expect(meta.transStart).toBe('19:30');
    expect(meta.transEnd).toBe('21:30');
  });
});
