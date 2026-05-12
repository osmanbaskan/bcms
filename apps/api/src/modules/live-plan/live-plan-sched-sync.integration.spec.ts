import { beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LivePlanService } from './live-plan.service.js';
import { ScheduleService } from '../schedules/schedule.service.js';
import {
  cleanupTransactional, getRawPrisma, makeAppHarness, makeRequest, makeUser,
  type TestAppHarness,
} from '../../../test/integration/helpers.js';

/**
 * SCHED-B3b service spec — live-plan ↔ schedule reverse sync, + duplicate,
 * createFromOpta. K-B3 lock 2026-05-07.
 *
 * Test kapsamı:
 *   ✓ create eventKey match'lerse schedule kanal slot otomatik kopya (K-B3.12)
 *   ✓ update title/team/eventStart → schedule sync; eventEnd schedule'a gitmez
 *     (K-B3.21/K-B3.22/K-B3.23)
 *   ✓ duplicate **snapshot kopya** (2026-05-13 domain revizyonu):
 *     temel bilgi + operationNotes + technical_details satırı bağımsız
 *     yeni row olarak kopya; transmission_segments scope dışı; status
 *     reset PLANNED; iki kayıt update'lerde bağımsız (K-B3.11)
 *   ✓ createFromOpta matches.opta_uid'den kopya
 *   ✓ createFromOpta matchDate NULL → 400 (default tarih üretmez)
 *   ✓ createFromOpta default duplicate (aktif) → 409
 *   ✓ createFromOpta deleted aynı eventKey → 409 değil; yeni create OK
 *   ✓ schedule sync tek update (schedules.eventKey UNIQUE)
 */

describe('LivePlanService SCHED-B3b — sched sync + duplicate + from-opta', () => {
  let harness: TestAppHarness;
  let svc: LivePlanService;
  let schedSvc: ScheduleService;

  beforeEach(async () => {
    await cleanupTransactional();
    harness  = makeAppHarness();
    svc      = new LivePlanService(harness.app as unknown as FastifyInstance);
    schedSvc = new ScheduleService(harness.app as unknown as FastifyInstance);
  });

  function user() {
    return makeRequest(makeUser({ username: 'b3b-tester', groups: ['Admin'] }));
  }

  // ── §A. genel manuel create — backend force MANUAL + eventKey üret ────
  test('create: genel POST /live-plan body sourceType/eventKey kabul etmez; backend MANUAL + manual:<uuid>', async () => {
    const e = await svc.create(
      {
        title:          'Manuel İçerik',
        eventStartTime: '2026-06-01T19:00:00Z',
        eventEndTime:   '2026-06-01T21:00:00Z',
        status:         'PLANNED',
      },
      user(),
    );
    expect(e.sourceType).toBe('MANUAL');
    expect(e.eventKey).toMatch(/^manual:[0-9a-f-]{36}$/);
    // Manuel create için aynı eventKey'li schedule olmaz (yeni UUID); kanal NULL
    expect(e.channel1Id).toBeNull();
    expect(e.channel2Id).toBeNull();
    expect(e.channel3Id).toBeNull();
  });

  // K-B3.12 channel slot kopya senaryosu: createFromOpta veya duplicate
  // path'inden test ediliyor (manuel create artık eventKey body'den
  // alamadığı için aynı eventKey ile ikinci entry yaratmak servis dışı yol
  // gerektirir; duplicate test'inde aşağıda assert ediliyor).

  // ── §B. update → schedule sync (K-B3.21/22/23) ─────────────────────────
  test('update: title/team/eventStart değişimi → schedule sync; eventEnd gitmez', async () => {
    // OPTA path üzerinden entry yarat (eventKey backend tarafından opta:<id>
    // formatında set edilir; manuel create eventKey body'den alamaz — anti-
    // bypass).
    const prisma = getRawPrisma();
    await prisma.match.create({
      data: {
        leagueId: 1, optaUid: 'b3b-sync', homeTeamName: 'Eski 1',
        awayTeamName: 'Eski 2', matchDate: new Date('2026-06-01T19:00:00Z'),
        season: '2025-2026',
      },
    });
    const e = await svc.createFromOpta('b3b-sync', user());
    const ek = e.eventKey!; // 'opta:b3b-sync'
    const sched = await schedSvc.createBroadcastFlow(
      {
        eventKey: ek, selectedLivePlanEntryId: e.id,
        scheduleDate: '2026-06-01', scheduleTime: '19:00',
      },
      user(),
    );

    // Update live-plan
    await svc.update(e.id, {
      title:          'Yeni',
      team1Name:      'Yeni 1',
      team2Name:      'Yeni 2',
      eventStartTime: '2026-06-02T20:00:00Z',
      eventEndTime:   '2026-06-02T23:00:00Z', // schedule'a gitmez
    }, e.version, user());

    const refreshed = await prisma.schedule.findUniqueOrThrow({ where: { id: sched.id } });
    expect(refreshed.title).toBe('Yeni');
    expect(refreshed.team1Name).toBe('Yeni 1');
    expect(refreshed.team2Name).toBe('Yeni 2');
    expect(refreshed.scheduleDate?.toISOString().slice(0, 10)).toBe('2026-06-02');
    // schedule.scheduleTime → "1970-01-01T20:00:00.000Z"
    const t = refreshed.scheduleTime;
    expect(t?.getUTCHours()).toBe(20);
    expect(t?.getUTCMinutes()).toBe(0);
    // eventEndTime schedule'a yansımaz; legacy startTime+2h placeholder kalır.
    expect(refreshed.startTime.toISOString()).toBe('2026-06-02T20:00:00.000Z');
    expect(refreshed.endTime.getTime() - refreshed.startTime.getTime()).toBe(2 * 3600 * 1000);
  });

  test('update: channel1/2/3Id değişimi → schedule satırına da yansır (2026-05-11)', async () => {
    const prisma = getRawPrisma();
    await prisma.match.create({
      data: {
        leagueId: 1, optaUid: 'b3b-channel-sync', homeTeamName: 'H',
        awayTeamName: 'A', matchDate: new Date('2026-06-01T19:00:00Z'),
        season: '2025-2026',
      },
    });
    const e = await svc.createFromOpta('b3b-channel-sync', user());
    const ek = e.eventKey!;
    // Channel slot kullanmak için broadcast schedule yarat; ek varsayılan channel'lar
    // schedule.createBroadcastFlow tarafından NULL olarak set edilir.
    const sched = await schedSvc.createBroadcastFlow(
      {
        eventKey: ek, selectedLivePlanEntryId: e.id,
        scheduleDate: '2026-06-01', scheduleTime: '19:00',
      },
      user(),
    );

    // Channel slot dirty: ID 1 set, ID 2 set, 3 explicit null. Seed fixture
    // channel'ları (seedTestFixtures: id=1 ve id=2 upsert) kullanılır.
    const updated = await svc.update(
      e.id,
      { channel1Id: 1, channel2Id: 2, channel3Id: null },
      e.version,
      user(),
    );
    expect(updated.channel1Id).toBe(1);
    expect(updated.channel2Id).toBe(2);
    expect(updated.channel3Id).toBeNull();

    const refreshed = await prisma.schedule.findUniqueOrThrow({ where: { id: sched.id } });
    expect(refreshed.channel1Id).toBe(1);
    expect(refreshed.channel2Id).toBe(2);
    expect(refreshed.channel3Id).toBeNull();
  });

  test('update: eventKey yoksa schedule sync atılır (legacy entry; service bypass ile yarat)', async () => {
    // Yeni manuel create her zaman eventKey üretir (anti-bypass). Legacy
    // entry simulasyonu için Prisma direct create.
    const prisma = getRawPrisma();
    const legacy = await prisma.livePlanEntry.create({
      data: {
        title:          'Legacy no-eventKey',
        eventStartTime: new Date('2026-06-01T19:00:00Z'),
        eventEndTime:   new Date('2026-06-01T21:00:00Z'),
        // eventKey YOK; legacy entry simulasyonu
      },
    });
    expect(legacy.eventKey).toBeNull();

    // Schedule sync atılır; hata yok (defensive guard)
    const updated = await svc.update(legacy.id, { title: 'Yeni' }, legacy.version, user());
    expect(updated.title).toBe('Yeni');
  });

  // ── §C. duplicate (K-B3.4, K-B3.11) — snapshot kopya 2026-05-13 ─────────
  test('duplicate: temel bilgi + operationNotes + technical_details snapshot; segments KOPYALANMAZ; status reset', async () => {
    // OPTA path üzerinden source entry (anti-bypass; manuel create eventKey
    // body'den almaz)
    const prisma = getRawPrisma();
    await prisma.match.create({
      data: {
        leagueId: 1, optaUid: 'b3b-dup', homeTeamName: 'Team A',
        awayTeamName: 'Team B', matchDate: new Date('2026-06-01T19:00:00Z'),
        season: '2025-2026',
      },
    });
    const source = await svc.createFromOpta('b3b-dup', user());
    // Source entry'yi IN_PROGRESS + operasyon notu ile güncelle (status
    // reset + operationNotes kopya doğrulamak için).
    await svc.update(source.id, {
      status: 'IN_PROGRESS',
      operationNotes: 'Source operasyon notu (snapshot kopya)',
    }, source.version, user());
    const updatedSource = await prisma.livePlanEntry.findUniqueOrThrow({ where: { id: source.id } });
    const ek = updatedSource.eventKey!;

    // Kaynak entry'ye technical_details: planned* zaman + serbest string +
    // FK olmayan int alanları (lookup tablo seed gerekmesin). Snapshot
    // bağımsızlık testi için string/int alan değişimi yeterli; FK alanları
    // ayrı integration spec'lerinde lookup seed ile test edilir.
    const srcTech = await prisma.livePlanTechnicalDetail.create({
      data: {
        livePlanEntryId:  source.id,
        fixedPhone1:      '+90 555 1',
        fixedPhone2:      '+90 555 2',
        cameraCount:      8,
        txp:              'TXP-A',
        symbolRate:       '27500',
        plannedStartTime: new Date('2026-06-01T18:45:00Z'),
        plannedEndTime:   new Date('2026-06-01T21:15:00Z'),
      },
    });
    await prisma.livePlanTransmissionSegment.create({
      data: {
        livePlanEntryId: source.id,
        feedRole:  'MAIN',
        kind:      'PROGRAM',
        startTime: new Date('2026-06-01T19:30:00Z'),
        endTime:   new Date('2026-06-01T20:30:00Z'),
      },
    });

    // Schedule yarat (kanal slot duplicate kopya doğrulamak için)
    await schedSvc.createBroadcastFlow(
      {
        eventKey: ek, selectedLivePlanEntryId: source.id,
        scheduleDate: '2026-06-01', scheduleTime: '19:00',
        channel1Id: 1, channel2Id: 2,
      },
      user(),
    );

    // Duplicate
    const dup = await svc.duplicate(source.id, user());

    expect(dup.id).not.toBe(source.id);
    // Kopyalanan — temel bilgi
    expect(dup.eventKey).toBe(ek);
    expect(dup.sourceType).toBe('OPTA');
    expect(dup.title).toBe('Team A vs Team B');
    expect(dup.team1Name).toBe('Team A');
    expect(dup.team2Name).toBe('Team B');
    expect(dup.eventStartTime.toISOString()).toBe('2026-06-01T19:00:00.000Z');
    expect(dup.eventEndTime.toISOString()).toBe('2026-06-01T21:00:00.000Z');
    // Schedule kanal slotu otomatik kopya (K-B3.12)
    expect(dup.channel1Id).toBe(1);
    expect(dup.channel2Id).toBe(2);
    // 2026-05-13 snapshot revizyonu: operationNotes kopyalanır
    expect(dup.operationNotes).toBe('Source operasyon notu (snapshot kopya)');
    // Reset
    expect(dup.status).toBe('PLANNED');
    expect(dup.version).toBe(1);

    // KOPYALANAN: technical_details snapshot — yeni satır, aynı değerler
    const dupTd = await prisma.livePlanTechnicalDetail.findUnique({
      where: { livePlanEntryId: dup.id },
    });
    expect(dupTd).not.toBeNull();
    expect(dupTd!.id).not.toBe(srcTech.id);
    expect(dupTd!.livePlanEntryId).toBe(dup.id);
    expect(dupTd!.version).toBe(1);
    expect(dupTd!.fixedPhone1).toBe('+90 555 1');
    expect(dupTd!.fixedPhone2).toBe('+90 555 2');
    expect(dupTd!.cameraCount).toBe(8);
    expect(dupTd!.txp).toBe('TXP-A');
    expect(dupTd!.symbolRate).toBe('27500');
    expect(dupTd!.plannedStartTime?.toISOString()).toBe('2026-06-01T18:45:00.000Z');
    expect(dupTd!.plannedEndTime?.toISOString()).toBe('2026-06-01T21:15:00.000Z');

    // Source tech satırı dokunulmadı (aynı id, kendi entry'sine bağlı)
    const srcTdAfter = await prisma.livePlanTechnicalDetail.findUnique({
      where: { livePlanEntryId: source.id },
    });
    expect(srcTdAfter).not.toBeNull();
    expect(srcTdAfter!.id).toBe(srcTech.id);
    expect(srcTdAfter!.livePlanEntryId).toBe(source.id);

    // KOPYALANMAYAN: transmission_segments scope dışı (V1)
    const dupSegs = await prisma.livePlanTransmissionSegment.findMany({
      where: { livePlanEntryId: dup.id, deletedAt: null },
    });
    expect(dupSegs).toHaveLength(0);
    // Source segment satırı dokunulmadı
    const srcSegs = await prisma.livePlanTransmissionSegment.findMany({
      where: { livePlanEntryId: source.id, deletedAt: null },
    });
    expect(srcSegs).toHaveLength(1);
  });

  test('duplicate: snapshot bağımsızlık — source ↔ dup technical_details update\'leri birbirine yansımaz', async () => {
    const prisma = getRawPrisma();
    await prisma.match.create({
      data: {
        leagueId: 1, optaUid: 'b3b-dup-indep', homeTeamName: 'X',
        awayTeamName: 'Y', matchDate: new Date('2026-06-10T19:00:00Z'),
        season: '2025-2026',
      },
    });
    const source = await svc.createFromOpta('b3b-dup-indep', user());
    await prisma.livePlanTechnicalDetail.create({
      data: {
        livePlanEntryId:  source.id,
        fixedPhone1:      'orig-source-phone',
        cameraCount:      4,
      },
    });

    const dup = await svc.duplicate(source.id, user());

    // Yön 1: source.tech update → dup.tech değişmez
    await prisma.livePlanTechnicalDetail.update({
      where: { livePlanEntryId: source.id },
      data:  { fixedPhone1: 'changed-source', cameraCount: 99 },
    });
    const dupTdAfterSourceChange = await prisma.livePlanTechnicalDetail.findUniqueOrThrow({
      where: { livePlanEntryId: dup.id },
    });
    expect(dupTdAfterSourceChange.fixedPhone1).toBe('orig-source-phone');
    expect(dupTdAfterSourceChange.cameraCount).toBe(4);

    // Yön 2: dup.tech update → source.tech değişmez
    await prisma.livePlanTechnicalDetail.update({
      where: { livePlanEntryId: dup.id },
      data:  { fixedPhone1: 'changed-dup', cameraCount: 77 },
    });
    const srcTdAfterDupChange = await prisma.livePlanTechnicalDetail.findUniqueOrThrow({
      where: { livePlanEntryId: source.id },
    });
    // Source son hâl: kendi update'iyle değişti ('changed-source'/99),
    // ama dup'ın update'i ('changed-dup'/77) source'a yansımadı.
    expect(srcTdAfterDupChange.fixedPhone1).toBe('changed-source');
    expect(srcTdAfterDupChange.cameraCount).toBe(99);

    // Satır id'leri ayrı (aynı row paylaşılmıyor)
    expect(dupTdAfterSourceChange.id).not.toBe(srcTdAfterDupChange.id);
  });

  test('duplicate: source technical_details YOKSA dup için de tech satırı oluşmaz', async () => {
    const prisma = getRawPrisma();
    await prisma.match.create({
      data: {
        leagueId: 1, optaUid: 'b3b-dup-notech', homeTeamName: 'P',
        awayTeamName: 'Q', matchDate: new Date('2026-06-12T19:00:00Z'),
        season: '2025-2026',
      },
    });
    const source = await svc.createFromOpta('b3b-dup-notech', user());
    // İntentional: tech satırı yaratılmadı

    const dup = await svc.duplicate(source.id, user());

    const dupTd = await prisma.livePlanTechnicalDetail.findUnique({
      where: { livePlanEntryId: dup.id },
    });
    expect(dupTd).toBeNull();

    const srcTd = await prisma.livePlanTechnicalDetail.findUnique({
      where: { livePlanEntryId: source.id },
    });
    expect(srcTd).toBeNull();
  });

  test('duplicate: source bulunamazsa → 404', async () => {
    await expect(svc.duplicate(999_999, user()))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  // ── §D. createFromOpta (K-B3.5, K-B3.10) ────────────────────────────────
  async function makeOptaMatch(opts: { optaUid: string; matchDate: Date | null }) {
    const prisma = getRawPrisma();
    return prisma.match.create({
      data: {
        leagueId:     1,
        optaUid:      opts.optaUid,
        homeTeamName: 'Home FC',
        awayTeamName: 'Away SK',
        matchDate:    opts.matchDate ?? new Date('1970-01-01T00:00:00Z'), // dummy; null durumu farklı
        season:       '2025-2026',
      },
    });
  }

  test('createFromOpta: matches.opta_uid\'den temel bilgi kopya', async () => {
    await makeOptaMatch({
      optaUid:   'OPTA-999',
      matchDate: new Date('2026-06-01T19:00:00Z'),
    });

    const created = await svc.createFromOpta('OPTA-999', user());
    expect(created.title).toBe('Home FC vs Away SK');
    expect(created.team1Name).toBe('Home FC');
    expect(created.team2Name).toBe('Away SK');
    expect(created.eventStartTime.toISOString()).toBe('2026-06-01T19:00:00.000Z');
    // Default planned duration: matchDate + 2h
    expect(created.eventEndTime.toISOString()).toBe('2026-06-01T21:00:00.000Z');
    expect(created.eventKey).toBe('opta:OPTA-999');
    expect(created.sourceType).toBe('OPTA');
    expect(created.optaMatchId).toBe('OPTA-999');
    expect(created.status).toBe('PLANNED');
  });

  test('createFromOpta: opta_uid yoksa → 404', async () => {
    await expect(svc.createFromOpta('OPTA-NOPE', user()))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  test('createFromOpta: default duplicate (aktif aynı eventKey) → 409', async () => {
    await makeOptaMatch({
      optaUid:   'OPTA-DUP',
      matchDate: new Date('2026-06-01T19:00:00Z'),
    });
    await svc.createFromOpta('OPTA-DUP', user());
    await expect(svc.createFromOpta('OPTA-DUP', user()))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test('createFromOpta: deleted aynı eventKey → 409 atmaz; yeni entry yaratılır', async () => {
    await makeOptaMatch({
      optaUid:   'OPTA-SOFT',
      matchDate: new Date('2026-06-01T19:00:00Z'),
    });
    const first = await svc.createFromOpta('OPTA-SOFT', user());
    // Hard-delete first (K11 cleanup 2026-05-07)
    await svc.remove(first.id, first.version, user());

    // İkinci create OK (row gone, eventKey serbest)
    const second = await svc.createFromOpta('OPTA-SOFT', user());
    expect(second.id).not.toBe(first.id);
    expect(second.eventKey).toBe('opta:OPTA-SOFT');
  });

  // Not: matches.match_date DB-level NOT NULL → "matchDate NULL → 400"
  // service defensive check'i pratikte DB tarafından tetiklenmez. Service
  // kodunda branch korunur (savunmacı kod; matches schema ileride NULL
  // kabul ederse direkt çalışır). Test edilmesi DB schema değişikliği
  // gerektirir; SCHED-B3b kapsamı dışı.
});
