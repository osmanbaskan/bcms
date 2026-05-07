import { beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LivePlanService } from './live-plan.service.js';
import { LivePlanTechnicalDetailService } from './technical-details.service.js';
import { LivePlanTransmissionSegmentService } from './segments.service.js';
import {
  cleanupTransactional,
  getRawPrisma,
  makeAppHarness,
  makeRequest,
  makeUser,
  type TestAppHarness,
} from '../../../test/integration/helpers.js';

/**
 * Madde 5 M5-B9 spec — segments service davranışı + entry hard-delete cascade
 * (U8: technical_details + segments FK `onDelete: Cascade` ile birlikte siler).
 *
 * Kapsam:
 *   ✓ POST/GET/PATCH/DELETE collection; version YOK V1 (last-write-wins).
 *   ✓ List filter (feedRole / kind); deleted hariç.
 *   ✓ U7 PATCH undefined=no change; description null=clear.
 *   ✓ U10 outbox shadow events live_plan.segment.{created|updated|deleted}.
 *   ✓ Cross-entry segment update/delete → 404.
 *   ✓ U8 entry hard-delete cascade → technical_details + segments DB'den siler
 *     (cleanup 2026-05-07).
 */

describe('LivePlanTransmissionSegmentService — integration', () => {
  let harness: TestAppHarness;
  let svc: LivePlanTransmissionSegmentService;
  let liveSvc: LivePlanService;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    svc = new LivePlanTransmissionSegmentService(harness.app as unknown as FastifyInstance);
    liveSvc = new LivePlanService(harness.app as unknown as FastifyInstance);
  });

  async function makeEntry(): Promise<number> {
    const user = makeUser({ username: 'ops', groups: ['Booking'] });
    const req = makeRequest(user);
    const e = await liveSvc.create(
      {
        title:          'Match',
        eventStartTime: '2026-06-01T19:00:00Z',
        eventEndTime:   '2026-06-01T22:00:00Z',
        status:         'PLANNED',
      },
      req,
    );
    return e.id;
  }

  function baseSegment(entryId: number) {
    return {
      feedRole:  'MAIN' as const,
      kind:      'PROGRAM' as const,
      startTime: '2026-06-01T19:30:00Z',
      endTime:   '2026-06-01T21:00:00Z',
    };
  }

  // ── Create ─────────────────────────────────────────────────────────────
  test('POST: → 201 + outbox segment.created', async () => {
    const entryId = await makeEntry();
    const seg = await svc.create(entryId, baseSegment(entryId));
    expect(seg.id).toBeGreaterThan(0);
    expect(seg.livePlanEntryId).toBe(entryId);
    expect(seg.feedRole).toBe('MAIN');

    const prisma = getRawPrisma();
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'LivePlanTransmissionSegment', aggregateId: String(seg.id) },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('live_plan.segment.created');
    expect(events[0].status).toBe('published');
  });

  test('POST: entry yoksa → 404', async () => {
    await expect(svc.create(999_999, baseSegment(0))).rejects.toMatchObject({ statusCode: 404 });
  });

  // ── List ───────────────────────────────────────────────────────────────
  test('list: feedRole filtre + deleted hariç', async () => {
    const entryId = await makeEntry();
    const a = await svc.create(entryId, { ...baseSegment(entryId), feedRole: 'MAIN' });
    await svc.create(entryId, { ...baseSegment(entryId), feedRole: 'BACKUP' });
    await svc.create(entryId, { ...baseSegment(entryId), feedRole: 'FIBER' });

    const main = await svc.list(entryId, { feedRole: 'MAIN' });
    expect(main).toHaveLength(1);
    expect(main[0].id).toBe(a.id);

    // Hard delete; row DB'den siler, listede gözükmeyecek.
    await svc.remove(entryId, a.id);
    const mainAfter = await svc.list(entryId, { feedRole: 'MAIN' });
    expect(mainAfter).toHaveLength(0);

    const all = await svc.list(entryId, {});
    expect(all).toHaveLength(2);
  });

  // ── Update ─────────────────────────────────────────────────────────────
  test('PATCH: kind ve description güncellenir (U7); description null=clear', async () => {
    const entryId = await makeEntry();
    const seg = await svc.create(entryId, { ...baseSegment(entryId), description: 'orig' });
    const updated = await svc.update(entryId, seg.id, { kind: 'TEST', description: null });
    expect(updated.kind).toBe('TEST');
    expect(updated.description).toBeNull();

    const prisma = getRawPrisma();
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'LivePlanTransmissionSegment', aggregateId: String(seg.id) },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      'live_plan.segment.created',
      'live_plan.segment.updated',
    ]);
  });

  test('PATCH: cross-entry segment → 404', async () => {
    const e1 = await makeEntry();
    const e2 = await makeEntry();
    const seg = await svc.create(e1, baseSegment(e1));
    await expect(
      svc.update(e2, seg.id, { kind: 'TEST' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('PATCH: merge end<start → 400', async () => {
    const entryId = await makeEntry();
    const seg = await svc.create(entryId, baseSegment(entryId));
    // Mevcut start 19:30; sadece end değiştir, 19:00 (start'tan önce).
    await expect(
      svc.update(entryId, seg.id, { endTime: '2026-06-01T19:00:00Z' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // ── Delete (HARD) ──────────────────────────────────────────────────────
  test('DELETE: HARD delete (DB row yok, listede yok) + outbox segment.deleted', async () => {
    const entryId = await makeEntry();
    const seg = await svc.create(entryId, baseSegment(entryId));
    const removed = await svc.remove(entryId, seg.id);
    expect(removed.id).toBe(seg.id);

    const prisma = getRawPrisma();
    const dbRow = await prisma.livePlanTransmissionSegment.findUnique({ where: { id: seg.id } });
    expect(dbRow).toBeNull();

    const list = await svc.list(entryId, {} as never);
    expect(list.find((s) => s.id === seg.id)).toBeUndefined();

    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'LivePlanTransmissionSegment', aggregateId: String(seg.id) },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toContain('live_plan.segment.deleted');
  });

  test('DELETE: hard-delete sonrası aynı entry\'ye yeni segment eklenebilir', async () => {
    const entryId = await makeEntry();
    const seg = await svc.create(entryId, baseSegment(entryId));
    await svc.remove(entryId, seg.id);
    const fresh = await svc.create(entryId, baseSegment(entryId));
    expect(fresh.id).not.toBe(seg.id);
  });

  // ── Cascade hard-delete (parent live-plan delete → child satırlar gone) ─
  test('cascade HARD delete: entry hard-delete → technical_details + segments DB\'den siler', async () => {
    const entryId = await makeEntry();
    const tdSvc = new LivePlanTechnicalDetailService(harness.app as unknown as FastifyInstance);
    const td = await tdSvc.create(entryId, {});
    const seg1 = await svc.create(entryId, baseSegment(entryId));
    const seg2 = await svc.create(entryId, { ...baseSegment(entryId), feedRole: 'BACKUP' });

    // Parent hard-delete (LivePlanService.remove) — FK Cascade child satırları siler.
    const user = makeUser({ username: 'ops', groups: ['Booking'] });
    const req = makeRequest(user);
    const entry = await getRawPrisma().livePlanEntry.findUniqueOrThrow({ where: { id: entryId } });
    await liveSvc.remove(entryId, entry.version, req);

    const prisma = getRawPrisma();
    expect(await prisma.livePlanEntry.findUnique({ where: { id: entryId } })).toBeNull();
    expect(await prisma.livePlanTechnicalDetail.findUnique({ where: { id: td.id } })).toBeNull();
    expect(await prisma.livePlanTransmissionSegment.findUnique({ where: { id: seg1.id } })).toBeNull();
    expect(await prisma.livePlanTransmissionSegment.findUnique({ where: { id: seg2.id } })).toBeNull();
  });
});
