import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// vi.mock hoist: kcFetch (Keycloak admin) gerçek HTTP yapmasın.
// BookingService update() içinde canAssign() → fetchUserType() çağırıyor.
vi.mock('../../core/keycloak-admin.client.js', () => ({
  kcFetch: vi.fn(async (url: string) => {
    if (url.startsWith('/users?username=')) {
      return [{ attributes: { bcmsUserType: ['supervisor'] } }];
    }
    if (url === '/groups') return [];
    if (url.startsWith('/groups/')) return [];
    if (url.startsWith('/users?max=')) return [];
    return [];
  }),
  getAdminToken: vi.fn(async () => 'test-token'),
  type: {},
}));

import type { FastifyInstance } from 'fastify';
import { BookingService } from './booking.service.js';
import {
  cleanupTransactional,
  createTestSchedule,
  getRawPrisma,
  makeAppHarness,
  makeRequest,
  makeUser,
  type TestAppHarness,
} from '../../../test/integration/helpers.js';

/**
 * Booking service integration spec — ilk PR.
 *
 * Kapsam (REQUIREMENTS-BACKEND-INTEGRATION-TESTS.md §3 Spec 3'ün dar alt-kümesi):
 *   ✓ create with scheduleId: schedule existence pre-check (404)
 *   ✓ update merge-aware date check (yalnız dueDate gelirse existing.startDate ile)
 *   ✓ update status transition validation (geçersiz geçiş 409)
 *   ✓ update optimistic locking (If-Match version mismatch 412)
 *   ✓ create requestedBy + scheduleId basit happy path + RabbitMQ publish kayıt
 *
 * Sonraki PR'lar: schedule.service spec + audit plugin spec.
 */

describe('BookingService — integration', () => {
  let harness: TestAppHarness;
  let svc: BookingService;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    // BookingService FastifyInstance bekliyor; harness uyumlu shape sağlıyor.
    svc = new BookingService(harness.app as unknown as FastifyInstance);
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  // ── create ────────────────────────────────────────────────────────────────

  test('create: scheduleId mevcutsa booking oluşur + RabbitMQ publish', async () => {
    const sch = await createTestSchedule({ channelId: 1 });
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      {
        scheduleId: sch.id,
        taskTitle: 'Test booking',
        taskDetails: 'Detay',
        userGroup: 'Booking',
      },
      req,
    );

    expect(created.id).toBeGreaterThan(0);
    expect(created.scheduleId).toBe(sch.id);
    expect(created.status).toBe('PENDING');
    expect(harness.publishedEvents).toHaveLength(1);
    expect(harness.publishedEvents[0].queue).toMatch(/booking/i);

    // Madde 2+7 PR-B2: Phase 2 shadow outbox row var (status='published')
    const prisma = getRawPrisma();
    const outboxRows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'Booking', aggregateId: String(created.id) },
    });
    expect(outboxRows).toHaveLength(1);
    const row = outboxRows[0];
    expect(row.eventType).toBe('booking.created');
    expect(row.status).toBe('published');
    expect(row.publishedAt).not.toBeNull();
    const payload = row.payload as Record<string, unknown>;
    expect(payload.bookingId).toBe(created.id);
    expect(payload.scheduleId).toBe(sch.id);
    expect(payload.userGroup).toBe('Booking');
  });

  test('create: scheduleId mevcut değilse 404', async () => {
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    await expect(
      svc.create(
        {
          scheduleId: 999_999,
          taskTitle: 'Geçersiz schedule referansı',
          userGroup: 'Booking',
        },
        req,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(harness.publishedEvents).toHaveLength(0);
  });

  // ── update: optimistic locking ────────────────────────────────────────────

  test('update: If-Match version uyumsuz → 412', async () => {
    const sch = await createTestSchedule({ channelId: 1 });
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const booking = await svc.create(
      { scheduleId: sch.id, taskTitle: 'Initial', userGroup: 'Booking' },
      req,
    );
    const staleVersion = booking.version - 1;

    await expect(
      svc.update(booking.id, { taskTitle: 'New title' }, staleVersion, req),
    ).rejects.toMatchObject({ statusCode: 412 });
  });

  // ── update: status transition validation ─────────────────────────────────

  test('update: geçersiz status geçişi → 409 (APPROVED → PENDING)', async () => {
    const sch = await createTestSchedule({ channelId: 1 });
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const booking = await svc.create(
      { scheduleId: sch.id, taskTitle: 'Initial', userGroup: 'Booking' },
      req,
    );
    // Önce PENDING → APPROVED (geçerli)
    const approved = await svc.update(booking.id, { status: 'APPROVED' }, undefined, req);
    expect(approved.status).toBe('APPROVED');

    // APPROVED → PENDING (geçersiz, sadece CANCELLED'e izin var)
    await expect(
      svc.update(approved.id, { status: 'PENDING' }, undefined, req),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // ── update: merge-aware date check (e66b4b5 regression) ─────────────────

  test('update: sadece dueDate gönderilirse existing.startDate ile çakışma → 400', async () => {
    const sch = await createTestSchedule({ channelId: 1 });
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    // Initial booking: startDate=2026-06-01, dueDate=2026-06-30
    const booking = await svc.create(
      {
        scheduleId: sch.id,
        taskTitle: 'Initial',
        userGroup: 'Booking',
        startDate: '2026-06-01',
        dueDate: '2026-06-30',
      },
      req,
    );

    // Update sadece dueDate: 2026-05-15 (existing startDate=2026-06-01'den önce)
    // Schema .refine() bunu yakalamaz (dto'da sadece dueDate var).
    // Service merge-aware check 400 dönmeli.
    await expect(
      svc.update(booking.id, { dueDate: '2026-05-15' }, undefined, req),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('update: sadece dueDate gönderilirse existing.startDate sonrasıysa OK', async () => {
    const sch = await createTestSchedule({ channelId: 1 });
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const booking = await svc.create(
      {
        scheduleId: sch.id,
        taskTitle: 'Initial',
        userGroup: 'Booking',
        startDate: '2026-06-01',
        dueDate: '2026-06-30',
      },
      req,
    );

    const updated = await svc.update(
      booking.id,
      { dueDate: '2026-07-15' },
      undefined,
      req,
    );

    expect(updated.dueDate?.toISOString().slice(0, 10)).toBe('2026-07-15');
  });

  // ── Madde 2+7 PR-B2: outbox shadow boundary guard ────────────────────────
  // PR-B2 sadece BOOKING_CREATED → outbox shadow yazar.
  // update()'teki NOTIFICATIONS_EMAIL publish notification domain (PR-B3 scope);
  // bu PR'da update() outbox row YAZMAZ. Aşağıdaki test bu boundary'i sabitler.
  test('update: outbox row YAZMAZ (notification domain PR-B3 scope)', async () => {
    const sch = await createTestSchedule({ channelId: 1 });
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const booking = await svc.create(
      { scheduleId: sch.id, taskTitle: 'Initial', userGroup: 'Booking' },
      req,
    );
    // create sonrası 1 outbox row var (booking.created)
    const prisma = getRawPrisma();
    const beforeUpdate = await prisma.outboxEvent.count({
      where: { aggregateType: 'Booking', aggregateId: String(booking.id) },
    });
    expect(beforeUpdate).toBe(1);

    // update status APPROVED — direct NOTIFICATIONS_EMAIL publish çalışır,
    // ama outbox row eklenmez (boundary).
    await svc.update(booking.id, { status: 'APPROVED' }, undefined, req);

    const afterUpdate = await prisma.outboxEvent.count({
      where: { aggregateType: 'Booking', aggregateId: String(booking.id) },
    });
    expect(afterUpdate).toBe(1); // hâlâ sadece create'in outbox row'u
  });
});

// Disconnect setup.ts afterAll'ında yapılıyor (helpers.disconnectPrisma).
