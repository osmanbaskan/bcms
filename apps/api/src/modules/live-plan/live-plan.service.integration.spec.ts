import { beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LivePlanService } from './live-plan.service.js';
import { isOutboxPollerAuthoritative } from '../outbox/outbox.helpers.js';
import {
  cleanupTransactional,
  getRawPrisma,
  makeAppHarness,
  makeRequest,
  makeUser,
  type TestAppHarness,
} from '../../../test/integration/helpers.js';

/** PR-C2 env-aware: authoritative=true → 'pending'; aksi (Phase 2 shadow) → 'published'. */
const EXPECTED_OUTBOX_STATUS = isOutboxPollerAuthoritative() ? 'pending' : 'published';

/**
 * Madde 5 M5-B2 spec — live-plan service/API davranış doğrulamaları.
 *
 * Tasarım: ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md §3.3 (M5-B2 Scope Lock)
 * K7-K14 kararları test edilir.
 *
 * Test stratejisi: M5-B1 schema spec'i ile paralel; bu spec service-layer
 * davranışına odaklanır (route handler If-Match parse + 428/400 mappings
 * route-layer testi gereksinimi olduğundan ileri integration; service-level
 * unit-of-behavior smoke yeterli).
 *
 * Auth scope: testler service'i doğrudan çağırır; route preHandler
 * `requireGroup(...PERMISSIONS.livePlan.X)` katmanı bu testten kapsam dışı
 * (booking spec pattern'i ile aynı).
 */

describe('LivePlanService — integration', () => {
  let harness: TestAppHarness;
  let svc: LivePlanService;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    svc = new LivePlanService(harness.app as unknown as FastifyInstance);
  });

  // ── Create ─────────────────────────────────────────────────────────────────

  test('create: minimal fields → IngestPlanEntry + outbox shadow (live_plan.created)', async () => {
    const user = makeUser({ username: 'ops-1', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      {
        title:          'Operasyon planı',
        eventStartTime: '2026-06-01T19:00:00Z',
        eventEndTime:   '2026-06-01T21:00:00Z',
        status:         'PLANNED',
      },
      req,
    );

    expect(created.id).toBeGreaterThan(0);
    expect(created.title).toBe('Operasyon planı');
    expect(created.status).toBe('PLANNED');
    expect(created.version).toBe(1);
    expect(created.createdBy).toBe('ops-1');
    expect(created.deletedAt).toBeNull();

    // Outbox shadow (K12; routing dışı — direct publish yok)
    const prisma = getRawPrisma();
    const outboxRows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'LivePlanEntry', aggregateId: String(created.id) },
    });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].eventType).toBe('live_plan.created');
    expect(outboxRows[0].status).toBe(EXPECTED_OUTBOX_STATUS);
    const payload = outboxRows[0].payload as Record<string, unknown>;
    expect(payload.livePlanEntryId).toBe(created.id);
  });

  // ── Update ─────────────────────────────────────────────────────────────────

  test('update: If-Match version match → 200 + version++ + outbox shadow', async () => {
    const user = makeUser({ username: 'ops-2', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      {
        title:          'Initial',
        eventStartTime: '2026-06-01T19:00:00Z',
        eventEndTime:   '2026-06-01T21:00:00Z',
        status:         'PLANNED',
      },
      req,
    );

    const updated = await svc.update(
      created.id,
      { status: 'READY' },
      created.version, // doğru version
      req,
    );

    expect(updated.status).toBe('READY');
    expect(updated.version).toBe(2); // increment

    const prisma = getRawPrisma();
    const outboxRows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'LivePlanEntry', aggregateId: String(created.id) },
      orderBy: { createdAt: 'asc' },
    });
    expect(outboxRows).toHaveLength(2);
    expect(outboxRows[1].eventType).toBe('live_plan.updated');
  });

  test('update: version mismatch → 412', async () => {
    const user = makeUser({ username: 'ops-3', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      {
        title:          'Conflict test',
        eventStartTime: '2026-06-01T19:00:00Z',
        eventEndTime:   '2026-06-01T21:00:00Z',
        status:         'PLANNED',
      },
      req,
    );

    await expect(
      svc.update(created.id, { status: 'READY' }, created.version - 1, req),
    ).rejects.toMatchObject({ statusCode: 412 });
  });

  test('update: not-found → 404', async () => {
    const req = makeRequest(makeUser({ username: 'ops-4', groups: ['Booking'] }));
    await expect(
      svc.update(999_999, { status: 'READY' }, 1, req),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('update: deleted entry → 404 (K11 hard-delete sonrası row gone)', async () => {
    const user = makeUser({ username: 'ops-5', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      {
        title:          'Will be deleted',
        eventStartTime: '2026-06-01T19:00:00Z',
        eventEndTime:   '2026-06-01T21:00:00Z',
        status:         'PLANNED',
      },
      req,
    );
    await svc.remove(created.id, created.version, req);

    // Soft-deleted satıra update → 404 (deletedAt != null gizli)
    await expect(
      svc.update(created.id, { status: 'READY' }, created.version + 1, req),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('update: merge-aware date check (sadece eventStartTime gönderilirse) — invalid → 400', async () => {
    const user = makeUser({ username: 'ops-6', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      {
        title:          'Date test',
        eventStartTime: '2026-06-01T19:00:00Z',
        eventEndTime:   '2026-06-01T21:00:00Z',
        status:         'PLANNED',
      },
      req,
    );

    // existing.eventEndTime = 21:00; new eventStartTime = 22:00 → invalid
    await expect(
      svc.update(
        created.id,
        { eventStartTime: '2026-06-01T22:00:00Z' },
        created.version,
        req,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // ── Hard delete ────────────────────────────────────────────────────────────

  test('remove: HARD delete (row DB\'den silinir) + outbox shadow (live_plan.deleted)', async () => {
    const user = makeUser({ username: 'ops-7', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      {
        title:          'To delete',
        eventStartTime: '2026-06-01T19:00:00Z',
        eventEndTime:   '2026-06-01T21:00:00Z',
        status:         'PLANNED',
      },
      req,
    );

    const snapshot = await svc.remove(created.id, created.version, req);
    // Service silmeden önceki snapshot'ı döner (deletedAt null, version 1).
    expect(snapshot.id).toBe(created.id);
    expect(snapshot.title).toBe('To delete');

    // Hard-delete: row DB'de yok.
    const prisma = getRawPrisma();
    const after = await prisma.livePlanEntry.findUnique({ where: { id: created.id } });
    expect(after).toBeNull();

    // Shadow event payload silmeden önce yazılmış (eventKey + title taşır).
    const outboxRows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'LivePlanEntry', aggregateId: String(created.id) },
      orderBy: { createdAt: 'asc' },
    });
    expect(outboxRows).toHaveLength(2);
    expect(outboxRows[1].eventType).toBe('live_plan.deleted');
    const payload = outboxRows[1].payload as { livePlanEntryId: number; title: string };
    expect(payload.livePlanEntryId).toBe(created.id);
    expect(payload.title).toBe('To delete');
  });

  test('remove: version mismatch → 412 + tx rollback (row DB\'de var, shadow event YOK)', async () => {
    const user = makeUser({ username: 'ops-8', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      {
        title:          'Conflict delete',
        eventStartTime: '2026-06-01T19:00:00Z',
        eventEndTime:   '2026-06-01T21:00:00Z',
        status:         'PLANNED',
      },
      req,
    );

    await expect(
      svc.remove(created.id, created.version - 1, req),
    ).rejects.toMatchObject({ statusCode: 412 });

    // Tx rollback assertion: shadow event silmeden önce yazılır; deleteMany
    // count==0 → 412 throw → tx rollback → outbox da geri alınır.
    const prisma = getRawPrisma();
    const stillThere = await prisma.livePlanEntry.findUnique({ where: { id: created.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.deletedAt).toBeNull();

    const deletedEvents = await prisma.outboxEvent.findMany({
      where: {
        aggregateType: 'LivePlanEntry',
        aggregateId:   String(created.id),
        eventType:     'live_plan.deleted',
      },
    });
    expect(deletedEvents).toHaveLength(0);
  });

  // ── Audit coverage (K10 ek not — delete audit log doğrulaması) ──────────
  // NOT: makeAppHarness raw Prisma (audit extension'sız) kullanıyor; audit
  // plugin davranışı bu test scope'unda doğrulanamaz. Audit pattern teyidi
  // PR-A pattern (entityType=model adı otomatik) audit.ts:107-136 kod-okuma
  // ile yapıldı (decision §3.3 K10 pre-impl bulgu); harness.app audit
  // extension olmadan çalıştığı için bu test ileri PR'a (audit plugin spec'i)
  // ertelenir.

  // ── List ───────────────────────────────────────────────────────────────────

  test('list: default exclude deleted + sort eventStartTime ASC', async () => {
    const user = makeUser({ username: 'ops-9', groups: ['Booking'] });
    const req = makeRequest(user);

    const a = await svc.create(
      { title: 'A', eventStartTime: '2026-06-03T19:00:00Z', eventEndTime: '2026-06-03T21:00:00Z' },
      req,
    );
    const b = await svc.create(
      { title: 'B', eventStartTime: '2026-06-01T19:00:00Z', eventEndTime: '2026-06-01T21:00:00Z' },
      req,
    );
    const c = await svc.create(
      { title: 'C-deleted', eventStartTime: '2026-06-02T19:00:00Z', eventEndTime: '2026-06-02T21:00:00Z' },
      req,
    );
    await svc.remove(c.id, c.version, req);

    const result = await svc.list({
      page:     1,
      pageSize: 50,
    });

    expect(result.total).toBe(2);   // C-deleted exclude
    expect(result.items.map((r) => r.title)).toEqual(['B', 'A']); // sort ASC
    expect(result.items.find((r) => r.id === c.id)).toBeUndefined();
  });

  test('list: status multi-value filter (comma-separated parse Zod tarafında; service array kabul eder)', async () => {
    const user = makeUser({ username: 'ops-10', groups: ['Booking'] });
    const req = makeRequest(user);

    await svc.create(
      { title: 'P', eventStartTime: '2026-06-01T19:00:00Z', eventEndTime: '2026-06-01T21:00:00Z', status: 'PLANNED' },
      req,
    );
    await svc.create(
      { title: 'R', eventStartTime: '2026-06-02T19:00:00Z', eventEndTime: '2026-06-02T21:00:00Z', status: 'READY' },
      req,
    );
    await svc.create(
      { title: 'C', eventStartTime: '2026-06-03T19:00:00Z', eventEndTime: '2026-06-03T21:00:00Z', status: 'COMPLETED' },
      req,
    );

    const result = await svc.list({
      status:   ['PLANNED', 'READY'],
      page:     1,
      pageSize: 50,
    });

    expect(result.total).toBe(2);
    expect(result.items.map((r) => r.title).sort()).toEqual(['P', 'R']);
  });

  test('list: half-open date range (>= from AND < to)', async () => {
    const user = makeUser({ username: 'ops-11', groups: ['Booking'] });
    const req = makeRequest(user);

    await svc.create(
      { title: 'June1', eventStartTime: '2026-06-01T00:00:00Z', eventEndTime: '2026-06-01T01:00:00Z' },
      req,
    );
    await svc.create(
      { title: 'June2', eventStartTime: '2026-06-02T00:00:00Z', eventEndTime: '2026-06-02T01:00:00Z' },
      req,
    );
    await svc.create(
      { title: 'June3', eventStartTime: '2026-06-03T00:00:00Z', eventEndTime: '2026-06-03T01:00:00Z' },
      req,
    );

    const result = await svc.list({
      from:     '2026-06-01T00:00:00Z',
      to:       '2026-06-03T00:00:00Z',
      page:     1,
      pageSize: 50,
    });

    // Half-open: June1 (>= from) ✓, June2 ✓, June3 (< to false) ✗
    expect(result.total).toBe(2);
    expect(result.items.map((r) => r.title).sort()).toEqual(['June1', 'June2']);
  });

  // ── getById ────────────────────────────────────────────────────────────────

  test('getById: not-found → 404', async () => {
    await expect(svc.getById(999_999)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('getById: deleted → 404 (K11 hard-delete sonrası row gone)', async () => {
    const user = makeUser({ username: 'ops-12', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      { title: 'Hidden', eventStartTime: '2026-06-01T19:00:00Z', eventEndTime: '2026-06-01T21:00:00Z' },
      req,
    );
    await svc.remove(created.id, created.version, req);

    await expect(svc.getById(created.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  // ── K-B3.20 follow-up: team_1/team_2 canonical alanlar ──────────────────
  test('create: team1Name + team2Name body\'den yazılır', async () => {
    const user = makeUser({ username: 'team-test', groups: ['Booking'] });
    const req  = makeRequest(user);

    const created = await svc.create(
      {
        title:          'Galatasaray vs Fenerbahçe',
        eventStartTime: '2026-06-01T19:00:00Z',
        eventEndTime:   '2026-06-01T21:00:00Z',
        status:         'PLANNED',
        team1Name:      'Galatasaray',
        team2Name:      'Fenerbahçe',
      },
      req,
    );

    expect(created.team1Name).toBe('Galatasaray');
    expect(created.team2Name).toBe('Fenerbahçe');
  });

  test('create: team_1/2 verilmediyse NULL kalır (M5-B2 zorunlu değil; manuel content)', async () => {
    const req = makeRequest(makeUser({ username: 'team-null', groups: ['Booking'] }));
    const created = await svc.create(
      {
        title:          'Manuel İçerik',
        eventStartTime: '2026-06-01T19:00:00Z',
        eventEndTime:   '2026-06-01T21:00:00Z',
        status:         'PLANNED',
      },
      req,
    );
    expect(created.team1Name).toBeNull();
    expect(created.team2Name).toBeNull();
  });

  test('update: team_1/2 set + null=clear (PATCH semantik)', async () => {
    const req = makeRequest(makeUser({ username: 'team-upd', groups: ['Booking'] }));
    const created = await svc.create(
      {
        title:          'Match',
        eventStartTime: '2026-06-01T19:00:00Z',
        eventEndTime:   '2026-06-01T21:00:00Z',
        status:         'PLANNED',
        team1Name:      'Eski Takım 1',
      },
      req,
    );

    // Set team_2
    const r1 = await svc.update(created.id, { team2Name: 'Yeni Takım 2' }, created.version, req);
    expect(r1.team1Name).toBe('Eski Takım 1');
    expect(r1.team2Name).toBe('Yeni Takım 2');

    // Clear team_1
    const r2 = await svc.update(created.id, { team1Name: null }, r1.version, req);
    expect(r2.team1Name).toBeNull();
    expect(r2.team2Name).toBe('Yeni Takım 2');
  });
});
