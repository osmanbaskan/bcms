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
 * Madde 5 M5-B9 spec — segments service davranışı + entry soft-delete cascade
 * (U8: technical_details + segments birlikte cascade edilir).
 *
 * Kapsam:
 *   ✓ POST/GET/PATCH/DELETE collection; version YOK V1 (last-write-wins).
 *   ✓ List filter (feedRole / kind); soft-deleted hariç.
 *   ✓ U7 PATCH undefined=no change; description null=clear.
 *   ✓ U10 outbox shadow events live_plan.segment.{created|updated|deleted}.
 *   ✓ Cross-entry segment update/delete → 404.
 *   ✓ U8 entry soft-delete cascade → technical_details + active segments
 *     deletedAt set edilir aynı tx'te.
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
  test('list: feedRole filtre + soft-deleted hariç', async () => {
    const entryId = await makeEntry();
    const a = await svc.create(entryId, { ...baseSegment(entryId), feedRole: 'MAIN' });
    await svc.create(entryId, { ...baseSegment(entryId), feedRole: 'BACKUP' });
    await svc.create(entryId, { ...baseSegment(entryId), feedRole: 'FIBER' });

    const main = await svc.list(entryId, { feedRole: 'MAIN' });
    expect(main).toHaveLength(1);
    expect(main[0].id).toBe(a.id);

    // Soft delete; listede gözükmeyecek.
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

  // ── Delete ─────────────────────────────────────────────────────────────
  test('DELETE: soft + outbox segment.deleted', async () => {
    const entryId = await makeEntry();
    const seg = await svc.create(entryId, baseSegment(entryId));
    const removed = await svc.remove(entryId, seg.id);
    expect(removed.deletedAt).toBeInstanceOf(Date);

    const prisma = getRawPrisma();
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'LivePlanTransmissionSegment', aggregateId: String(seg.id) },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toContain('live_plan.segment.deleted');
  });

  // ── U8 cascade ─────────────────────────────────────────────────────────
  test('U8 cascade: entry soft-delete → technical_details + active segments soft-delete edilir', async () => {
    const entryId = await makeEntry();
    const tdSvc = new LivePlanTechnicalDetailService(harness.app as unknown as FastifyInstance);
    const td = await tdSvc.create(entryId, {});
    const seg1 = await svc.create(entryId, baseSegment(entryId));
    const seg2 = await svc.create(entryId, { ...baseSegment(entryId), feedRole: 'BACKUP' });
    // Önceden soft-delete edilmiş bir segment (cascade ile dokunmamalı — zaten silinmiş).
    const seg3 = await svc.create(entryId, { ...baseSegment(entryId), feedRole: 'FIBER' });
    await svc.remove(entryId, seg3.id);
    const seg3Snapshot = await getRawPrisma().livePlanTransmissionSegment.findUniqueOrThrow({
      where: { id: seg3.id },
    });

    // Entry soft-delete (LivePlanService.remove)
    const user = makeUser({ username: 'ops', groups: ['Booking'] });
    const req = makeRequest(user);
    const entry = await getRawPrisma().livePlanEntry.findUniqueOrThrow({ where: { id: entryId } });
    await liveSvc.remove(entryId, entry.version, req);

    const prisma = getRawPrisma();
    const tdAfter   = await prisma.livePlanTechnicalDetail.findUniqueOrThrow({ where: { id: td.id } });
    const seg1After = await prisma.livePlanTransmissionSegment.findUniqueOrThrow({ where: { id: seg1.id } });
    const seg2After = await prisma.livePlanTransmissionSegment.findUniqueOrThrow({ where: { id: seg2.id } });
    const seg3After = await prisma.livePlanTransmissionSegment.findUniqueOrThrow({ where: { id: seg3.id } });

    expect(tdAfter.deletedAt).toBeInstanceOf(Date);
    expect(seg1After.deletedAt).toBeInstanceOf(Date);
    expect(seg2After.deletedAt).toBeInstanceOf(Date);
    // Pre-existing soft-delete: cascade dokunmamalı; deletedAt aynı kalmalı.
    expect(seg3After.deletedAt!.getTime()).toBe(seg3Snapshot.deletedAt!.getTime());
  });
});
