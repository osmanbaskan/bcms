import { beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ScheduleService } from './schedule.service.js';
import {
  cleanupTransactional, getRawPrisma, makeAppHarness,
  type TestAppHarness,
} from '../../../test/integration/helpers.js';

/**
 * SCHED-B4-prep spec — broadcast schedule list endpoint server-side filter.
 *
 * Backend invariant: list yalnızca canonical broadcast flow row'larını döner.
 *   eventKey != null AND selectedLivePlanEntryId != null
 *   AND scheduleDate != null AND scheduleTime != null
 *
 * Test kapsamı:
 *   ✓ canonical broadcast row'ları döner (4 alan dolu)
 *   ✓ eventKey null legacy row dönmez
 *   ✓ selectedLivePlanEntryId null row dönmez
 *   ✓ scheduleDate/Time null row dönmez
 *   ✓ eventKey query filter (server-side)
 *   ✓ status filter
 *   ✓ pagination total + page sayımı
 *   ✓ ordering scheduleDate/scheduleTime ASC
 */

describe('ScheduleService.findBroadcastList — SCHED-B4-prep', () => {
  let harness: TestAppHarness;
  let svc: ScheduleService;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    svc = new ScheduleService(harness.app as unknown as FastifyInstance);
  });

  async function makeEntry(suffix: string) {
    const prisma = getRawPrisma();
    return prisma.livePlanEntry.create({
      data: {
        title:          `Match ${suffix}`,
        eventStartTime: new Date('2026-06-01T19:00:00Z'),
        eventEndTime:   new Date('2026-06-01T21:00:00Z'),
        eventKey:       `opta:${suffix}`,
        sourceType:     'OPTA',
      },
    });
  }

  async function makeBroadcastSchedule(
    entryId: number,
    eventKey: string,
    overrides: Partial<{
      scheduleDate: Date | null;
      scheduleTime: Date | null;
      status:       'DRAFT' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
      title:        string;
    }> = {},
  ) {
    const prisma = getRawPrisma();
    return prisma.schedule.create({
      data: {
        title:                   overrides.title ?? `Test ${eventKey}`,
        startTime:               new Date('2026-06-01T19:00:00Z'),
        endTime:                 new Date('2026-06-01T21:00:00Z'),
        createdBy:               'test',
        eventKey,
        selectedLivePlanEntryId: entryId,
        scheduleDate:            overrides.scheduleDate === undefined
          ? new Date('2026-06-01T00:00:00Z')
          : overrides.scheduleDate,
        scheduleTime:            overrides.scheduleTime === undefined
          ? new Date('1970-01-01T19:00:00Z')
          : overrides.scheduleTime,
        team1Name: 'A',
        team2Name: 'B',
        ...(overrides.status ? { status: overrides.status } : {}),
      },
    });
  }

  test('canonical broadcast row → list döner', async () => {
    const e = await makeEntry('A');
    const s = await makeBroadcastSchedule(e.id, e.eventKey!);
    const r = await svc.findBroadcastList({ page: 1, pageSize: 50 });
    expect(r.total).toBe(1);
    expect(r.data[0].id).toBe(s.id);
  });

  test('eventKey NULL legacy row → list dönmez', async () => {
    // Legacy schedule (B5 öncesi paralel): eventKey null + selectedLpe null.
    const prisma = getRawPrisma();
    await prisma.schedule.create({
      data: {
        title:      'Legacy',
        startTime:  new Date('2026-06-01T19:00:00Z'),
        endTime:    new Date('2026-06-01T21:00:00Z'),
        createdBy:  'test',
      },
    });
    const r = await svc.findBroadcastList({ page: 1, pageSize: 50 });
    expect(r.total).toBe(0);
    expect(r.data).toHaveLength(0);
  });

  test('selectedLivePlanEntryId NULL row → dönmez (eventKey dolu olsa bile)', async () => {
    // Kısmen doldurulmuş hayalî row — broadcast-complete değil.
    const prisma = getRawPrisma();
    await prisma.schedule.create({
      data: {
        title:        'Partial',
        startTime:    new Date('2026-06-01T19:00:00Z'),
        endTime:      new Date('2026-06-01T21:00:00Z'),
        createdBy:    'test',
        eventKey:     'opta:partial-1',
        scheduleDate: new Date('2026-06-01T00:00:00Z'),
        scheduleTime: new Date('1970-01-01T19:00:00Z'),
        // selectedLivePlanEntryId NULL
      },
    });
    const r = await svc.findBroadcastList({ page: 1, pageSize: 50 });
    expect(r.total).toBe(0);
  });

  test('scheduleDate / scheduleTime NULL row → dönmez', async () => {
    const e = await makeEntry('B');
    await makeBroadcastSchedule(e.id, e.eventKey!, { scheduleDate: null });
    const r = await svc.findBroadcastList({ page: 1, pageSize: 50 });
    expect(r.total).toBe(0);
  });

  test('eventKey query filter server-side', async () => {
    const e1 = await makeEntry('X1');
    const e2 = await makeEntry('X2');
    await makeBroadcastSchedule(e1.id, e1.eventKey!);
    await makeBroadcastSchedule(e2.id, e2.eventKey!);
    const r = await svc.findBroadcastList({ eventKey: e1.eventKey!, page: 1, pageSize: 50 });
    expect(r.total).toBe(1);
    expect(r.data[0].eventKey).toBe(e1.eventKey);
  });

  test('status filter', async () => {
    const e1 = await makeEntry('S1');
    const e2 = await makeEntry('S2');
    await makeBroadcastSchedule(e1.id, e1.eventKey!, { status: 'DRAFT' });
    await makeBroadcastSchedule(e2.id, e2.eventKey!, { status: 'CONFIRMED' });
    const r = await svc.findBroadcastList({ status: 'CONFIRMED', page: 1, pageSize: 50 });
    expect(r.total).toBe(1);
    expect(r.data[0].status).toBe('CONFIRMED');
  });

  test('pagination total + page', async () => {
    for (let i = 0; i < 5; i++) {
      const e = await makeEntry(`P${i}`);
      await makeBroadcastSchedule(e.id, e.eventKey!);
    }
    const page1 = await svc.findBroadcastList({ page: 1, pageSize: 2 });
    expect(page1.total).toBe(5);
    expect(page1.data).toHaveLength(2);
    expect(page1.totalPages).toBe(3);

    const page3 = await svc.findBroadcastList({ page: 3, pageSize: 2 });
    expect(page3.data).toHaveLength(1);
  });

  test('from/to canonical scheduleDate filter (legacy start/end_time bazlı DEĞİL)', async () => {
    const e1 = await makeEntry('D1');
    const e2 = await makeEntry('D2');
    const e3 = await makeEntry('D3');
    await makeBroadcastSchedule(e1.id, e1.eventKey!, {
      scheduleDate: new Date('2026-06-01T00:00:00Z'),
    });
    await makeBroadcastSchedule(e2.id, e2.eventKey!, {
      scheduleDate: new Date('2026-06-15T00:00:00Z'),
    });
    await makeBroadcastSchedule(e3.id, e3.eventKey!, {
      scheduleDate: new Date('2026-07-01T00:00:00Z'),
    });

    // 06-10 .. 06-20 aralığı → sadece e2
    const r = await svc.findBroadcastList({
      from: '2026-06-10', to: '2026-06-20', page: 1, pageSize: 50,
    });
    expect(r.total).toBe(1);
    expect(r.data[0].eventKey).toBe(e2.eventKey);

    // Sadece from
    const r2 = await svc.findBroadcastList({
      from: '2026-06-15', page: 1, pageSize: 50,
    });
    expect(r2.total).toBe(2);
    expect(r2.data.map((s) => s.eventKey)).toEqual([e2.eventKey, e3.eventKey]);
  });

  test('ordering: scheduleDate/scheduleTime ASC', async () => {
    const e1 = await makeEntry('O1');
    const e2 = await makeEntry('O2');
    const e3 = await makeEntry('O3');
    await makeBroadcastSchedule(e2.id, e2.eventKey!, {
      scheduleDate: new Date('2026-06-02T00:00:00Z'),
      scheduleTime: new Date('1970-01-01T15:00:00Z'),
    });
    await makeBroadcastSchedule(e3.id, e3.eventKey!, {
      scheduleDate: new Date('2026-06-01T00:00:00Z'),
      scheduleTime: new Date('1970-01-01T22:00:00Z'),
    });
    await makeBroadcastSchedule(e1.id, e1.eventKey!, {
      scheduleDate: new Date('2026-06-01T00:00:00Z'),
      scheduleTime: new Date('1970-01-01T18:00:00Z'),
    });
    const r = await svc.findBroadcastList({ page: 1, pageSize: 50 });
    expect(r.data.map((s) => s.eventKey)).toEqual([e1.eventKey, e3.eventKey, e2.eventKey]);
  });
});
