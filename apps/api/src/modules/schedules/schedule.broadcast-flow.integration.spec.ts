import { beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ScheduleService } from './schedule.service.js';
import {
  cleanupTransactional, getRawPrisma, makeAppHarness, makeRequest, makeUser,
  type TestAppHarness,
} from '../../../test/integration/helpers.js';

/**
 * SCHED-B3a service spec — broadcast flow canonical create/update/remove
 * + channel propagation + event_key UNIQUE conflict + schedule delete →
 * live-plan channel NULL + live-plan time sync.
 *
 * K-B3 lock 2026-05-07 davranışı.
 *
 * Auth scope: route preHandler kapsam dışı (mevcut Schedule integration
 * spec pattern paritesi).
 */

describe('ScheduleService — broadcast flow (SCHED-B3a)', () => {
  let harness: TestAppHarness;
  let svc: ScheduleService;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    svc = new ScheduleService(harness.app as unknown as FastifyInstance);
  });

  async function makeEntry(overrides: Record<string, unknown> = {}) {
    const prisma = getRawPrisma();
    return prisma.livePlanEntry.create({
      data: {
        title:          'Test vs Match',
        eventStartTime: new Date('2026-06-01T19:00:00Z'),
        eventEndTime:   new Date('2026-06-01T21:00:00Z'),
        eventKey:       'opta:test-' + Date.now() + Math.floor(Math.random() * 1000),
        sourceType:     'OPTA',
        ...overrides,
      },
    });
  }

  function dto(entryId: number, eventKey: string, extra: Record<string, unknown> = {}) {
    return {
      eventKey,
      selectedLivePlanEntryId: entryId,
      scheduleDate:            '2026-06-01',
      scheduleTime:            '19:00',
      ...extra,
    };
  }

  // ── §A. Create canonical ─────────────────────────────────────────────────
  test('createBroadcastFlow: minimal → 201, canonical alanlar yazılı, legacy derived', async () => {
    const user = makeUser({ username: 'sched-1', groups: ['Admin'] });
    const req  = makeRequest(user);
    const entry = await makeEntry();

    const created = await svc.createBroadcastFlow(dto(entry.id, entry.eventKey!), req);

    expect(created.eventKey).toBe(entry.eventKey);
    expect(created.selectedLivePlanEntryId).toBe(entry.id);
    expect(created.scheduleDate).toBeInstanceOf(Date);
    expect(created.scheduleTime).toBeInstanceOf(Date);
    // Legacy dual-write
    expect(created.startTime).toBeInstanceOf(Date);
    expect(created.endTime).toBeInstanceOf(Date);
    expect(created.endTime.getTime() - created.startTime.getTime()).toBe(2 * 3600 * 1000);
    expect(created.title).toBe(entry.title);
    expect(created.usageScope).toBe('broadcast');
    expect(created.createdBy).toBe('sched-1');
  });

  test('createBroadcastFlow: kanal slotları + 3 lookup option set edilebilir', async () => {
    const prisma = getRawPrisma();
    const c = await prisma.scheduleCommercialOption.create({ data: { label: 'COMM-1' } });
    const l = await prisma.scheduleLogoOption.create({ data: { label: 'LOGO-1' } });
    const f = await prisma.scheduleFormatOption.create({ data: { label: 'FMT-1' } });
    const entry = await makeEntry();
    const req = makeRequest(makeUser({ username: 'sched-2', groups: ['Admin'] }));

    const created = await svc.createBroadcastFlow(dto(entry.id, entry.eventKey!, {
      channel1Id: 1, channel2Id: 2,
      commercialOptionId: c.id, logoOptionId: l.id, formatOptionId: f.id,
    }), req);
    expect(created.channel1Id).toBe(1);
    expect(created.channel2Id).toBe(2);
    expect(created.commercialOptionId).toBe(c.id);
    expect(created.logoOptionId).toBe(l.id);
    expect(created.formatOptionId).toBe(f.id);
  });

  test('createBroadcastFlow: aynı event_key 2x → 409 Bu event Yayın Planlama\'da zaten var', async () => {
    const entry = await makeEntry();
    const req = makeRequest(makeUser({ username: 's3', groups: ['Admin'] }));
    await svc.createBroadcastFlow(dto(entry.id, entry.eventKey!), req);
    await expect(svc.createBroadcastFlow(dto(entry.id, entry.eventKey!), req))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test('createBroadcastFlow: selected_live_plan_entry_id geçersiz → 404', async () => {
    const req = makeRequest(makeUser({ username: 's4', groups: ['Admin'] }));
    await expect(svc.createBroadcastFlow(dto(999_999, 'opta:bogus'), req))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  test('createBroadcastFlow: silinmiş entry → 404', async () => {
    const prisma = getRawPrisma();
    const entry = await makeEntry();
    await prisma.livePlanEntry.update({ where: { id: entry.id }, data: { deletedAt: new Date() } });
    const req = makeRequest(makeUser({ username: 's5', groups: ['Admin'] }));
    await expect(svc.createBroadcastFlow(dto(entry.id, entry.eventKey!), req))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  // ── §B. Channel propagation (create) ─────────────────────────────────────
  test('createBroadcastFlow: channel slotları aynı event_key\'li tüm live-plan entry\'lere kopyalanır', async () => {
    const ek = 'opta:propagation-test';
    const e1 = await makeEntry({ eventKey: ek });
    const e2 = await makeEntry({ eventKey: ek }); // duplicate live-plan kayıt
    const req = makeRequest(makeUser({ username: 'p1', groups: ['Admin'] }));

    await svc.createBroadcastFlow(dto(e1.id, ek, { channel1Id: 1, channel2Id: 2 }), req);

    const prisma = getRawPrisma();
    const refreshed = await prisma.livePlanEntry.findMany({
      where: { eventKey: ek },
      select: { id: true, channel1Id: true, channel2Id: true, channel3Id: true },
      orderBy: { id: 'asc' },
    });
    expect(refreshed).toHaveLength(2);
    expect(refreshed[0].channel1Id).toBe(1);
    expect(refreshed[1].channel1Id).toBe(1);
    expect(refreshed[0].channel2Id).toBe(2);
    expect(refreshed[1].channel2Id).toBe(2);
  });

  // ── §C. Update + channel propagation + time sync ─────────────────────────
  test('updateBroadcastFlow: kanal değişimi → tüm event_key live-plan slot UPDATE', async () => {
    const ek = 'opta:upd-1';
    const e1 = await makeEntry({ eventKey: ek });
    const e2 = await makeEntry({ eventKey: ek });
    const req = makeRequest(makeUser({ username: 'u1', groups: ['Admin'] }));
    const sched = await svc.createBroadcastFlow(dto(e1.id, ek, { channel1Id: 1 }), req);

    await svc.updateBroadcastFlow(sched.id, { channel1Id: 2, channel2Id: 1 }, undefined, req);

    const prisma = getRawPrisma();
    const refreshed = await prisma.livePlanEntry.findMany({
      where: { eventKey: ek },
      select: { channel1Id: true, channel2Id: true },
    });
    expect(refreshed.every((r) => r.channel1Id === 2 && r.channel2Id === 1)).toBe(true);
  });

  test('updateBroadcastFlow: scheduleDate/Time değişimi → live-plan eventStart/EndTime sync (duration korunur)', async () => {
    const ek = 'opta:upd-time';
    const entry = await makeEntry({
      eventKey: ek,
      eventStartTime: new Date('2026-06-01T19:00:00Z'),
      eventEndTime:   new Date('2026-06-01T21:00:00Z'), // 2h duration
    });
    const req = makeRequest(makeUser({ username: 'u2', groups: ['Admin'] }));
    const sched = await svc.createBroadcastFlow(dto(entry.id, ek), req);

    await svc.updateBroadcastFlow(sched.id, {
      scheduleDate: '2026-06-02',
      scheduleTime: '20:30',
    }, undefined, req);

    const prisma = getRawPrisma();
    const refreshed = await prisma.livePlanEntry.findUnique({ where: { id: entry.id } });
    expect(refreshed?.eventStartTime.toISOString()).toBe('2026-06-02T20:30:00.000Z');
    // Duration korunur — eski 2 saat
    const dur = refreshed!.eventEndTime.getTime() - refreshed!.eventStartTime.getTime();
    expect(dur).toBe(2 * 3600 * 1000);
  });

  test('updateBroadcastFlow: If-Match version mismatch → 412', async () => {
    const ek = 'opta:if-match';
    const entry = await makeEntry({ eventKey: ek });
    const req = makeRequest(makeUser({ username: 'u3', groups: ['Admin'] }));
    const sched = await svc.createBroadcastFlow(dto(entry.id, ek), req);

    await expect(svc.updateBroadcastFlow(sched.id, { channel1Id: 1 }, sched.version + 99, req))
      .rejects.toMatchObject({ statusCode: 412 });
  });

  test('updateBroadcastFlow: id yoksa → 404', async () => {
    const req = makeRequest(makeUser({ username: 'u4', groups: ['Admin'] }));
    await expect(svc.updateBroadcastFlow(999_999, { channel1Id: 1 }, undefined, req))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  // ── §D. Remove + live-plan channel NULL ──────────────────────────────────
  test('removeBroadcastFlow: schedule sil → aynı event_key live-plan kanal slotları NULL', async () => {
    const ek = 'opta:del-1';
    const e1 = await makeEntry({ eventKey: ek });
    const e2 = await makeEntry({ eventKey: ek });
    const req = makeRequest(makeUser({ username: 'd1', groups: ['Admin'] }));
    const sched = await svc.createBroadcastFlow(dto(e1.id, ek, { channel1Id: 1, channel2Id: 2 }), req);

    // Pre-check: kanal slotları kopya
    const prisma = getRawPrisma();
    let lp = await prisma.livePlanEntry.findMany({ where: { eventKey: ek } });
    expect(lp.every((e) => e.channel1Id === 1)).toBe(true);

    await svc.removeBroadcastFlow(sched.id);

    // Post: schedule yok; live-plan satırları KALIR ama kanal slotları NULL
    const sAfter = await prisma.schedule.findUnique({ where: { id: sched.id } });
    expect(sAfter).toBeNull();
    lp = await prisma.livePlanEntry.findMany({ where: { eventKey: ek } });
    expect(lp).toHaveLength(2); // K-B3.15: live-plan silinmez
    expect(lp.every((e) => e.channel1Id === null && e.channel2Id === null && e.channel3Id === null)).toBe(true);
  });

  test('removeBroadcastFlow: id yoksa → 404', async () => {
    await expect(svc.removeBroadcastFlow(999_999))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
