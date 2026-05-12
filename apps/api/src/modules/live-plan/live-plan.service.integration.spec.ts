import { beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LivePlanService } from './live-plan.service.js';
import type { ListLivePlanQuery } from './live-plan.schema.js';
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

  test('update: yalniz eventStartTime gonderilirse backend eventEndTime +2h placeholder atar (domain karari 2026-05-12)', async () => {
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

    // Yeni eventStartTime existing.eventEndTime'dan SONRA — eskiden 400 atilirdi
    // (merge-aware reject). Domain karari sonrasi: karsilasma bitis kullanilmiyor;
    // backend otomatik olarak eventEndTime'i yeni start + 2h ile birlikte yazar.
    const updated = await svc.update(
      created.id,
      { eventStartTime: '2026-06-01T22:00:00Z' },
      created.version,
      req,
    );

    expect(updated.eventStartTime.toISOString()).toBe('2026-06-01T22:00:00.000Z');
    expect(updated.eventEndTime.toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });

  // Not: eventStartTime+eventEndTime end<=start case'i Zod refine
  // (updateLivePlanSchema) ile route layer'da yakalanir; svc.update direkt
  // cagrildiginda Zod skip olur. Bu davranis ayri route-handler spec
  // kapsamindadir; service-direct test scope'unda degil.

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

  // ── 2026-05-11: list/getById response display zenginleştirme ─────────────
  test('list+getById: leagueName + technicalDetails display name çiftleri döner', async () => {
    const prisma = getRawPrisma();
    // Match + League (seed'de id=1 var; opta_uid ile yeni match yarat)
    const m = await prisma.match.create({
      data: {
        leagueId:    1, // 'Süper Lig'
        optaUid:     'b10-display',
        homeTeamName:'H', awayTeamName:'A',
        matchDate:   new Date('2026-06-01T19:00:00Z'),
        season:      '2025-2026',
      },
    });
    // Lookup'lar
    const mod   = await prisma.transmissionModulationType.create({ data: { label: 'MOD-X' } });
    const ird   = await prisma.transmissionIrd.create({ data: { label: 'IRD-Z' } });
    const lang1 = await prisma.livePlanLanguage.create({ data: { label: 'LANG-MAIN' } });
    const lang2 = await prisma.livePlanLanguage.create({ data: { label: 'LANG-SECOND' } });

    // OPTA path entry (matchId + optaMatchId Match'e bağlı; leagueName join'i gelir)
    const entry = await svc.createFromOpta(
      'b10-display',
      makeRequest(makeUser({ username: 'disp', groups: ['Booking'] })),
    );
    expect(entry.matchId).toBe(m.id);

    // Technical details: 4 alan dolu, geri kalan null
    await prisma.livePlanTechnicalDetail.create({
      data: {
        livePlanEntryId: entry.id,
        modulationTypeId: mod.id,
        ird1Id:           ird.id,
        languageId:       lang1.id,
        secondLanguageId: lang2.id,
      },
    });

    // List response
    const listed = await svc.list({ page: 1, pageSize: 50 } as ListLivePlanQuery);
    const row = listed.items.find((r) => r.id === entry.id);
    expect(row).toBeDefined();
    expect(row!.leagueName).toBe('Süper Lig');
    expect(row!.technicalDetails).not.toBeNull();
    expect(row!.technicalDetails!.modulationTypeId).toBe(mod.id);
    expect(row!.technicalDetails!.modulationTypeName).toBe('MOD-X');
    expect(row!.technicalDetails!.ird1Id).toBe(ird.id);
    expect(row!.technicalDetails!.ird1Name).toBe('IRD-Z');
    expect(row!.technicalDetails!.ird2Id).toBeNull();
    expect(row!.technicalDetails!.ird2Name).toBeNull();
    expect(row!.technicalDetails!.languageId).toBe(lang1.id);
    expect(row!.technicalDetails!.languageName).toBe('LANG-MAIN');
    expect(row!.technicalDetails!.secondLanguageId).toBe(lang2.id);
    expect(row!.technicalDetails!.secondLanguageName).toBe('LANG-SECOND');

    // Detail response (getById) aynı shape
    const detail = await svc.getById(entry.id);
    expect(detail.leagueName).toBe('Süper Lig');
    expect(detail.technicalDetails?.modulationTypeName).toBe('MOD-X');
    expect(detail.technicalDetails?.secondLanguageName).toBe('LANG-SECOND');
  });

  test('list: technicalDetails satırı yoksa display = null', async () => {
    const req = makeRequest(makeUser({ username: 'no-tech', groups: ['Booking'] }));
    const e = await svc.create(
      { title: 'NoTech', eventStartTime: '2026-06-01T19:00:00Z', eventEndTime: '2026-06-01T21:00:00Z' },
      req,
    );
    const listed = await svc.list({ page: 1, pageSize: 50 } as ListLivePlanQuery);
    const row = listed.items.find((r) => r.id === e.id);
    expect(row?.technicalDetails).toBeNull();
    expect(row?.leagueName).toBeNull();
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

  // ── 2026-05-13: Yayın Planlama Lig/Hafta filter + filter dropdown ──────
  describe('list lig/hafta filter + filters/leagues + filters/weeks', () => {
    async function seedFixture(): Promise<{
      entryLigA1Wk1: number;
      entryLigA2Wk2: number;
      entryLigB1Wk5: number;
      entryManual:   number;
    }> {
      const prisma = getRawPrisma();
      // 2 lig: seed id=1 'Süper Lig'; ek olarak upsert (leagues seed tablosu —
      // cleanupTransactional truncate etmez; tekrar create P2002 verir).
      // Explicit id ile auto-increment sequence çakışmasını önle (seed id=1
      // explicit set ediliyor; sequence nextval=1 → collision; safe yüksek id).
      const ligB = await prisma.league.upsert({
        where:  { code: 'opta-lig-b' },
        update: {},
        create: { id: 9999, code: 'opta-lig-b', name: 'TFF 1. Lig', country: 'Türkiye' },
      });

      // 3 OPTA match: ligA(week=1, week=2), ligB(week=5)
      const m1 = await prisma.match.create({
        data: { leagueId: 1, optaUid: 'flt-a1', homeTeamName: 'H1', awayTeamName: 'A1',
                matchDate: new Date('2026-06-01T19:00:00Z'), season: '2025-2026', weekNumber: 1 },
      });
      const m2 = await prisma.match.create({
        data: { leagueId: 1, optaUid: 'flt-a2', homeTeamName: 'H2', awayTeamName: 'A2',
                matchDate: new Date('2026-06-08T19:00:00Z'), season: '2025-2026', weekNumber: 2 },
      });
      const m3 = await prisma.match.create({
        data: { leagueId: ligB.id, optaUid: 'flt-b5', homeTeamName: 'H3', awayTeamName: 'A3',
                matchDate: new Date('2026-06-15T19:00:00Z'), season: '2025-2026', weekNumber: 5 },
      });

      const reqA = makeRequest(makeUser({ username: 'flt-tester', groups: ['Booking'] }));
      const eA1 = await svc.createFromOpta('flt-a1', reqA);
      const eA2 = await svc.createFromOpta('flt-a2', reqA);
      const eB5 = await svc.createFromOpta('flt-b5', reqA);
      void m1; void m2; void m3;

      // Manuel entry: matchId null
      const eManual = await svc.create(
        { title: 'Manuel kayıt', eventStartTime: '2026-06-20T19:00:00Z',
          eventEndTime: '2026-06-20T21:00:00Z' },
        reqA,
      );

      return {
        entryLigA1Wk1: eA1.id, entryLigA2Wk2: eA2.id,
        entryLigB1Wk5: eB5.id, entryManual: eManual.id,
      };
    }

    test('leagueId filter → sadece o lige ait entry\'ler döner', async () => {
      const ids = await seedFixture();
      const filtered = await svc.list({
        page: 1, pageSize: 50, leagueId: 1,
      } as ListLivePlanQuery);
      const filteredIds = filtered.items.map((r) => r.id);
      expect(filteredIds).toContain(ids.entryLigA1Wk1);
      expect(filteredIds).toContain(ids.entryLigA2Wk2);
      expect(filteredIds).not.toContain(ids.entryLigB1Wk5);
      expect(filteredIds).not.toContain(ids.entryManual);
    });

    test('weekNumber filter → sadece o haftaya ait entry\'ler döner', async () => {
      const ids = await seedFixture();
      const filtered = await svc.list({
        page: 1, pageSize: 50, weekNumber: 2,
      } as ListLivePlanQuery);
      const filteredIds = filtered.items.map((r) => r.id);
      expect(filteredIds).toContain(ids.entryLigA2Wk2);
      expect(filteredIds).not.toContain(ids.entryLigA1Wk1);
      expect(filteredIds).not.toContain(ids.entryLigB1Wk5);
      expect(filteredIds).not.toContain(ids.entryManual);
    });

    test('leagueId + weekNumber → AND filter', async () => {
      const ids = await seedFixture();
      const filtered = await svc.list({
        page: 1, pageSize: 50, leagueId: 1, weekNumber: 1,
      } as ListLivePlanQuery);
      const filteredIds = filtered.items.map((r) => r.id);
      expect(filteredIds).toEqual([ids.entryLigA1Wk1]);
    });

    test('manuel entry (matchId null): filter yoksa görünür, leagueId/weekNumber filtre aktifken gizlenir', async () => {
      const ids = await seedFixture();

      // Filter YOK → manual görünür
      const all = await svc.list({ page: 1, pageSize: 50 } as ListLivePlanQuery);
      expect(all.items.map((r) => r.id)).toContain(ids.entryManual);

      // leagueId filter → manual gizlenir
      const byLeague = await svc.list({
        page: 1, pageSize: 50, leagueId: 1,
      } as ListLivePlanQuery);
      expect(byLeague.items.map((r) => r.id)).not.toContain(ids.entryManual);

      // weekNumber filter → manual gizlenir
      const byWeek = await svc.list({
        page: 1, pageSize: 50, weekNumber: 1,
      } as ListLivePlanQuery);
      expect(byWeek.items.map((r) => r.id)).not.toContain(ids.entryManual);
    });

    test('response: leagueId / leagueName / weekNumber / season alanları döner', async () => {
      const ids = await seedFixture();
      const all = await svc.list({ page: 1, pageSize: 50 } as ListLivePlanQuery);
      const eA1 = all.items.find((r) => r.id === ids.entryLigA1Wk1);
      expect(eA1).toBeDefined();
      expect(eA1!.leagueId).toBe(1);
      expect(eA1!.leagueName).toBe('Süper Lig');
      expect(eA1!.weekNumber).toBe(1);
      expect(eA1!.season).toBe('2025-2026');

      // Manuel entry: tüm match join alanları null
      const eM = all.items.find((r) => r.id === ids.entryManual);
      expect(eM).toBeDefined();
      expect(eM!.leagueId).toBeNull();
      expect(eM!.leagueName).toBeNull();
      expect(eM!.weekNumber).toBeNull();
      expect(eM!.season).toBeNull();
    });

    test('deletedAt entry: list/filter ve filter dropdownlarda asla görünmez', async () => {
      const ids = await seedFixture();
      const prisma = getRawPrisma();
      await prisma.livePlanEntry.update({
        where: { id: ids.entryLigA1Wk1 },
        data:  { deletedAt: new Date() },
      });

      const all = await svc.list({ page: 1, pageSize: 50 } as ListLivePlanQuery);
      expect(all.items.map((r) => r.id)).not.toContain(ids.entryLigA1Wk1);

      // Filter dropdown'lar deleted entry'lerin liglerini/haftalarını saymaz
      // (test seed'inde ligA için 2 entry var — biri silindi, biri sağlam;
      //  ligA hâlâ dropdown'da olmalı çünkü eA2 sağlam)
      const leagues = await svc.listLeagueFilterOptions();
      expect(leagues.find((l) => l.id === 1)).toBeDefined();
    });

    test('filters/leagues: aktif live-plan entry\'lerde kullanılan distinct ligler (sıralı)', async () => {
      await seedFixture();
      const leagues = await svc.listLeagueFilterOptions();
      // Tam 2 lig: Süper Lig (id=1) + TFF 1. Lig (yeni)
      expect(leagues.length).toBe(2);
      // Sıralama lig adına göre tr-TR
      const names = leagues.map((l) => l.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'tr-TR')));
      // Süper Lig dahil
      expect(leagues.some((l) => l.name === 'Süper Lig')).toBe(true);
    });

    test('filters/weeks: leagueId scope + null weekNumber hariç + artan sıralı', async () => {
      const ids = await seedFixture();
      void ids;

      // Lig A (id=1): weekNumber {1, 2}
      const weeksA = await svc.listWeekFilterOptions(1);
      expect(weeksA).toEqual([1, 2]);

      // Lig B (yeni id): weekNumber {5}
      const leagues = await svc.listLeagueFilterOptions();
      const ligB = leagues.find((l) => l.name === 'TFF 1. Lig')!;
      const weeksB = await svc.listWeekFilterOptions(ligB.id);
      expect(weeksB).toEqual([5]);

      // leagueId yok → tüm liglerin distinct hafta {1,2,5}
      const weeksAll = await svc.listWeekFilterOptions();
      expect(weeksAll).toEqual([1, 2, 5]);
    });

    test('filters/weeks: null weekNumber entry dropdown\'da YOK', async () => {
      const prisma = getRawPrisma();
      // Entry ile bağlı Match.weekNumber null
      await prisma.match.create({
        data: { leagueId: 1, optaUid: 'flt-no-week', homeTeamName: 'X', awayTeamName: 'Y',
                matchDate: new Date('2026-06-25T19:00:00Z'), season: '2025-2026',
                weekNumber: null },
      });
      const req = makeRequest(makeUser({ username: 'flt-nw', groups: ['Booking'] }));
      await svc.createFromOpta('flt-no-week', req);

      const weeks = await svc.listWeekFilterOptions(1);
      // Yalnız null weekNumber entry vardı, dropdown boş
      expect(weeks).toEqual([]);
    });
  });
});
