import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LivePlanService } from './live-plan.service.js';
import { LivePlanTechnicalDetailService } from './technical-details.service.js';
import {
  cleanupTransactional,
  getRawPrisma,
  makeAppHarness,
  makeRequest,
  makeUser,
  type TestAppHarness,
} from '../../../test/integration/helpers.js';

/**
 * Madde 5 M5-B9 spec — technical details service davranışı.
 *
 * Kapsam (U1-U12 lock):
 *   ✓ POST/GET/PATCH/DELETE singleton; If-Match own version (412 mismatch);
 *     1:1 enforce (409); explicit POST + PATCH (no upsert).
 *   ✓ U7 PATCH undefined=no change, null=clear.
 *   ✓ U9 lookup FK active/deleted validation (400) — active false + lookup
 *     soft-deleted (lookup pattern korur).
 *   ✓ U10 outbox shadow events live_plan.technical.{created|updated|deleted}.
 *   ✓ Entry not found 404 (parent live-plan hard-delete sonrası row gone).
 *
 * Auth scope: route preHandler kapsam dışı (live-plan service spec pattern).
 */

describe('LivePlanTechnicalDetailService — integration', () => {
  let harness: TestAppHarness;
  let svc: LivePlanTechnicalDetailService;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    svc = new LivePlanTechnicalDetailService(harness.app as unknown as FastifyInstance);
  });

  async function makeEntry(): Promise<number> {
    const liveSvc = new LivePlanService(harness.app as unknown as FastifyInstance);
    const user = makeUser({ username: 'ops', groups: ['Booking'] });
    const req = makeRequest(user);
    const e = await liveSvc.create(
      {
        title:          'Match',
        eventStartTime: '2026-06-01T19:00:00Z',
        eventEndTime:   '2026-06-01T21:00:00Z',
        status:         'PLANNED',
      },
      req,
    );
    return e.id;
  }

  // ── Create ─────────────────────────────────────────────────────────────
  test('POST: minimal body → 201 + outbox technical.created', async () => {
    const entryId = await makeEntry();
    const td = await svc.create(entryId, {});
    expect(td.id).toBeGreaterThan(0);
    expect(td.livePlanEntryId).toBe(entryId);
    expect(td.version).toBe(1);
    expect(td.deletedAt).toBeNull();

    const prisma = getRawPrisma();
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'LivePlanTechnicalDetail', aggregateId: String(td.id) },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('live_plan.technical.created');
    expect(events[0].status).toBe('published');
  });

  test('POST: 1:1 enforce — ikinci POST aynı entry için → 409', async () => {
    // Beklenen P2002 → service 409'a çevirir; Prisma stderr 'pretty' format
    // P2002'de log basar (cosmetic). Stub: assert akışını kirletme.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const entryId = await makeEntry();
      await svc.create(entryId, {});
      await expect(svc.create(entryId, {})).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      errSpy.mockRestore();
    }
  });

  test('POST: entry yoksa → 404', async () => {
    await expect(svc.create(999_999, {})).rejects.toMatchObject({ statusCode: 404 });
  });

  test('POST: lookup id geçersiz (yok) → DB FK violation', async () => {
    const entryId = await makeEntry();
    // Lookup tablosu boş → satellite_id 999 invalid; validateLookupFields önce
    // active satır bulamaz → 400 fırlatır.
    await expect(svc.create(entryId, { satelliteId: 999_999 } as never))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('POST: lookup active=false → 400', async () => {
    const entryId = await makeEntry();
    const prisma  = getRawPrisma();
    const sat = await prisma.transmissionSatellite.create({
      data: { label: 'TS-INACTIVE', active: false },
    });
    await expect(svc.create(entryId, { satelliteId: sat.id } as never))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('POST: lookup soft-deleted → 400', async () => {
    const entryId = await makeEntry();
    const prisma  = getRawPrisma();
    const sat = await prisma.transmissionSatellite.create({ data: { label: 'TS-DEL' } });
    await prisma.transmissionSatellite.update({
      where: { id: sat.id },
      data:  { deletedAt: new Date() },
    });
    await expect(svc.create(entryId, { satelliteId: sat.id } as never))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('POST: aktif lookup id → success', async () => {
    const entryId = await makeEntry();
    const prisma  = getRawPrisma();
    const sat = await prisma.transmissionSatellite.create({ data: { label: 'TS-OK' } });
    const td = await svc.create(entryId, { satelliteId: sat.id } as never);
    expect(td.satelliteId).toBe(sat.id);
  });

  // ── Get ────────────────────────────────────────────────────────────────
  test('GET: kayıt yokken null döner', async () => {
    const entryId = await makeEntry();
    const r = await svc.getByEntry(entryId);
    expect(r).toBeNull();
  });

  test('GET: kayıt varsa döner', async () => {
    const entryId = await makeEntry();
    await svc.create(entryId, {});
    const r = await svc.getByEntry(entryId);
    expect(r).not.toBeNull();
    expect(r!.livePlanEntryId).toBe(entryId);
  });

  // ── Update ─────────────────────────────────────────────────────────────
  test('PATCH: version match → version++ + outbox technical.updated', async () => {
    const entryId = await makeEntry();
    const td = await svc.create(entryId, {});
    const updated = await svc.update(entryId, { fixedPhone1: '+90 555 1' }, td.version);
    expect(updated.version).toBe(td.version + 1);
    expect(updated.fixedPhone1).toBe('+90 555 1');

    const prisma = getRawPrisma();
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'LivePlanTechnicalDetail', aggregateId: String(td.id) },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      'live_plan.technical.created',
      'live_plan.technical.updated',
    ]);
  });

  test('PATCH: version mismatch → 412', async () => {
    const entryId = await makeEntry();
    const td = await svc.create(entryId, {});
    await expect(
      svc.update(entryId, { fixedPhone1: 'X' }, td.version + 99),
    ).rejects.toMatchObject({ statusCode: 412 });
  });

  test('PATCH: undefined alanı dokunulmaz; null alanı temizler (U7)', async () => {
    const entryId = await makeEntry();
    const td = await svc.create(entryId, { fixedPhone1: '+1', fixedPhone2: '+2' } as never);
    // fixedPhone2 dokunulmaz; fixedPhone1 null ile temizlenir.
    const updated = await svc.update(entryId, { fixedPhone1: null }, td.version);
    expect(updated.fixedPhone1).toBeNull();
    expect(updated.fixedPhone2).toBe('+2');
  });

  test('PATCH: planned_end < planned_start (merge) → 400', async () => {
    const entryId = await makeEntry();
    const td = await svc.create(entryId, {
      plannedStartTime: '2026-06-01T20:00:00Z',
    } as never);
    // Mevcut start 20:00; sadece end gönder, end<start.
    await expect(
      svc.update(entryId, { plannedEndTime: '2026-06-01T19:00:00Z' }, td.version),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // ── Delete (HARD) ──────────────────────────────────────────────────────
  test('DELETE: version match → HARD delete (DB row yok) + outbox technical.deleted', async () => {
    const entryId = await makeEntry();
    const td = await svc.create(entryId, {});
    const removed = await svc.remove(entryId, td.version);
    expect(removed.id).toBe(td.id);

    // GET null + DB-level row YOK.
    const after = await svc.getByEntry(entryId);
    expect(after).toBeNull();

    const prisma = getRawPrisma();
    const dbRow = await prisma.livePlanTechnicalDetail.findUnique({ where: { id: td.id } });
    expect(dbRow).toBeNull();

    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'LivePlanTechnicalDetail', aggregateId: String(td.id) },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toContain('live_plan.technical.deleted');
  });

  test('DELETE: hard-delete sonrası aynı entry\'ye yeniden POST mümkün (1:1 unique boş)', async () => {
    const entryId = await makeEntry();
    const td = await svc.create(entryId, {});
    await svc.remove(entryId, td.version);
    // Yeniden create — P2002 unique conflict yok.
    const recreated = await svc.create(entryId, {});
    expect(recreated.id).not.toBe(td.id);
    expect(recreated.livePlanEntryId).toBe(entryId);
  });

  test('DELETE: version mismatch → 412 + tx rollback (row DB\'de var, shadow event YOK)', async () => {
    const entryId = await makeEntry();
    const td = await svc.create(entryId, {});
    await expect(
      svc.remove(entryId, td.version + 99),
    ).rejects.toMatchObject({ statusCode: 412 });

    // Tx rollback: shadow event önce yazılır; deleteMany count==0 → 412 →
    // rollback → outbox da geri alınır.
    const prisma = getRawPrisma();
    const stillThere = await prisma.livePlanTechnicalDetail.findUnique({ where: { id: td.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.deletedAt).toBeNull();

    const deletedEvents = await prisma.outboxEvent.findMany({
      where: {
        aggregateType: 'LivePlanTechnicalDetail',
        aggregateId:   String(td.id),
        eventType:     'live_plan.technical.deleted',
      },
    });
    expect(deletedEvents).toHaveLength(0);
  });
});
