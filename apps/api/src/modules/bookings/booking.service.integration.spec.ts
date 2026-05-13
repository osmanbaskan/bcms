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
    const sch = await createTestSchedule();
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
    const sch = await createTestSchedule();
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
    const sch = await createTestSchedule();
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
    const sch = await createTestSchedule();
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
    const sch = await createTestSchedule();
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

  // ── Madde 2+7 PR-B3a: Notification domain Phase 2 shadow ────────────────
  // PR-B2'deki "update outbox YAZMAZ" testi PR-B3a sonrası geçersiz oldu;
  // bu iki test aynı boundary'i daha doğru ifade eder: status change → outbox
  // var; status değişmediğinde → outbox yok.

  test('update + status APPROVED → notification.email_requested outbox + direct NOTIFICATIONS_EMAIL', async () => {
    const sch = await createTestSchedule();
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const booking = await svc.create(
      { scheduleId: sch.id, taskTitle: 'Initial', userGroup: 'Booking' },
      req,
    );

    // create sonrası: 1 outbox row (booking.created), 1 direct publish (BOOKING_CREATED)
    const prisma = getRawPrisma();
    expect(await prisma.outboxEvent.count({
      where: { aggregateType: 'Booking', aggregateId: String(booking.id) },
    })).toBe(1);

    // update APPROVED → +1 outbox (notification.email_requested) + 1 direct
    // (queue.notifications.email)
    await svc.update(booking.id, { status: 'APPROVED' }, undefined, req);

    // Direct publish: queue name match (kullanıcı guard 3 — sadece length yetmez,
    // booking create publish'i de var)
    const notificationPublishes = harness.publishedEvents.filter(
      (e) => e.queue === 'queue.notifications.email',
    );
    expect(notificationPublishes).toHaveLength(1);

    // Outbox: booking.created + notification.email_requested
    const allRows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'Booking', aggregateId: String(booking.id) },
      orderBy: { createdAt: 'asc' },
    });
    expect(allRows).toHaveLength(2);
    expect(allRows[0].eventType).toBe('booking.created');
    expect(allRows[1].eventType).toBe('notification.email_requested');
    expect(allRows[1].status).toBe('published');
    expect(allRows[1].publishedAt).not.toBeNull();

    // Strict payload: { to, subject, body } — aggregate fields outbox metadata'da
    const payload = allRows[1].payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['body', 'subject', 'to']);
    expect(payload.to).toBe('tester');
    expect(typeof payload.subject).toBe('string');
    expect(payload.subject).toMatch(/tamamlandı|reddedildi/);
    expect(typeof payload.body).toBe('string');
  });

  test('update without status change → no notification outbox (boundary)', async () => {
    const sch = await createTestSchedule();
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const booking = await svc.create(
      { scheduleId: sch.id, taskTitle: 'Initial', userGroup: 'Booking' },
      req,
    );

    // taskTitle update (status değişmiyor) — notification trigger yok
    await svc.update(booking.id, { taskTitle: 'Updated title' }, undefined, req);

    const prisma = getRawPrisma();
    const allRows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'Booking', aggregateId: String(booking.id) },
    });
    // Hâlâ sadece create'in outbox row'u; notification yok
    expect(allRows).toHaveLength(1);
    expect(allRows[0].eventType).toBe('booking.created');

    // Direct publish: notification queue'ya hiç publish yok
    const notificationPublishes = harness.publishedEvents.filter(
      (e) => e.queue === 'queue.notifications.email',
    );
    expect(notificationPublishes).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2026-05-14: İş Takip — filter + yorum + status history
// ────────────────────────────────────────────────────────────────────────────

describe('BookingService — list filter (qTitle + status)', () => {
  let harness: TestAppHarness;
  let svc: BookingService;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    svc = new BookingService(harness.app as unknown as FastifyInstance);
  });
  afterEach(async () => { vi.clearAllMocks(); });

  async function seed3() {
    const user = makeUser({ username: 'admin1', groups: ['Admin'] });
    const req  = makeRequest(user);
    // Case-insensitive testi PostgreSQL ILIKE ASCII fold davranisina dayanir;
    // Turkce I/i farki ILIKE tarafindan handle edilmez. Test verileri ASCII
    // karakterlerle olusur ki insensitive eslesme deterministik kalsin.
    await svc.create({ taskTitle: 'Report ALPHA',     userGroup: 'Booking', status: 'PENDING'  }, req);
    await svc.create({ taskTitle: 'Studio SETUP',     userGroup: 'Booking', status: 'APPROVED' }, req);
    await svc.create({ taskTitle: 'report Beta',      userGroup: 'Booking', status: 'PENDING'  }, req);
    return req;
  }

  test('qTitle case-insensitive contains; sadece title ustunde', async () => {
    const req = await seed3();
    const res = await svc.findAll(req, undefined, undefined, 1, 50, 'report');
    expect(res.data.map((d) => d.taskTitle).sort()).toEqual(
      ['Report ALPHA', 'report Beta'].sort(),
    );
  });

  test('status filter sadece secilen status donurur', async () => {
    const req = await seed3();
    const res = await svc.findAll(req, undefined, undefined, 1, 50, undefined, 'APPROVED');
    expect(res.data).toHaveLength(1);
    expect(res.data[0].taskTitle).toBe('Studio SETUP');
  });

  test('qTitle + status AND filter birlikte', async () => {
    const req = await seed3();
    const res = await svc.findAll(req, undefined, undefined, 1, 50, 'report', 'PENDING');
    expect(res.data).toHaveLength(2);
    expect(res.data.every((d) => d.status === 'PENDING')).toBe(true);
  });
});

describe('BookingService — yorum (BookingComment)', () => {
  let harness: TestAppHarness;
  let svc: BookingService;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    svc = new BookingService(harness.app as unknown as FastifyInstance);
  });
  afterEach(async () => { vi.clearAllMocks(); });

  async function seedBooking(group = 'Booking') {
    const adminReq = makeRequest(makeUser({ username: 'admin1', groups: ['Admin'] }));
    const b = await svc.create({ taskTitle: 'Yorum testi', userGroup: group, status: 'PENDING' }, adminReq);
    return b;
  }

  test('ayni grup kullanici yorum POST → 201 (service uzerinden persist)', async () => {
    const b = await seedBooking('Booking');
    const userReq = makeRequest(makeUser({ username: 'u1', groups: ['Booking'] }));
    const c = await svc.addComment(b.id, { body: 'merhaba' }, userReq);
    expect(c.id).toBeGreaterThan(0);
    expect(c.body).toBe('merhaba');
    expect(c.authorUserId).toBe('u1');
  });

  test('farklı grup kullanıcı yorum POST → 403', async () => {
    const b = await seedBooking('Booking');
    const userReq = makeRequest(makeUser({ username: 'outsider', groups: ['Ingest'] }));
    await expect(svc.addComment(b.id, { body: 'erişim yok' }, userReq))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  test('Admin kullanıcı yorum POST → 201 (universal)', async () => {
    const b = await seedBooking('Booking');
    const adminReq = makeRequest(makeUser({ username: 'admin1', groups: ['Admin'] }));
    const c = await svc.addComment(b.id, { body: 'admin yorumu' }, adminReq);
    expect(c.authorUserId).toBe('admin1');
  });

  test('SystemEng özel universal değil — grup dışı SystemEng → 403', async () => {
    const b = await seedBooking('Booking');
    const sysReq = makeRequest(makeUser({ username: 'sysuser', groups: ['SystemEng'] }));
    await expect(svc.addComment(b.id, { body: 'sys' }, sysReq))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  test('booking yok → 404', async () => {
    const adminReq = makeRequest(makeUser({ username: 'admin1', groups: ['Admin'] }));
    await expect(svc.addComment(999_999, { body: 'x' }, adminReq))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  test('listComments createdAt ASC sıralı', async () => {
    const b = await seedBooking('Booking');
    const adminReq = makeRequest(makeUser({ username: 'admin1', groups: ['Admin'] }));
    await svc.addComment(b.id, { body: '1' }, adminReq);
    await new Promise((r) => setTimeout(r, 10));
    await svc.addComment(b.id, { body: '2' }, adminReq);
    await new Promise((r) => setTimeout(r, 10));
    await svc.addComment(b.id, { body: '3' }, adminReq);
    const list = await svc.listComments(b.id, adminReq);
    expect(list.map((c) => c.body)).toEqual(['1', '2', '3']);
  });

  test('listComments farklı grup → 403', async () => {
    const b = await seedBooking('Booking');
    const outsiderReq = makeRequest(makeUser({ username: 'outsider', groups: ['Ingest'] }));
    await expect(svc.listComments(b.id, outsiderReq))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('BookingService — durum geçmişi (BookingStatusHistory)', () => {
  let harness: TestAppHarness;
  let svc: BookingService;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    svc = new BookingService(harness.app as unknown as FastifyInstance);
  });
  afterEach(async () => { vi.clearAllMocks(); });

  test('create sırasında initial status history yazılır (fromStatus=null)', async () => {
    const adminReq = makeRequest(makeUser({ username: 'admin1', groups: ['Admin'] }));
    const b = await svc.create({ taskTitle: 't1', userGroup: 'Booking', status: 'PENDING' }, adminReq);
    const hist = await svc.listStatusHistory(b.id, adminReq);
    expect(hist).toHaveLength(1);
    expect(hist[0].fromStatus).toBeNull();
    expect(hist[0].toStatus).toBe('PENDING');
    expect(hist[0].changedByUserId).toBe('admin1');
  });

  test('PATCH status PENDING → APPROVED → history 2 entry', async () => {
    const adminReq = makeRequest(makeUser({ username: 'admin1', groups: ['Admin'] }));
    const b = await svc.create({ taskTitle: 't2', userGroup: 'Booking', status: 'PENDING' }, adminReq);
    await svc.update(b.id, { status: 'APPROVED' }, undefined, adminReq);
    const hist = await svc.listStatusHistory(b.id, adminReq);
    expect(hist).toHaveLength(2);
    expect(hist[0].fromStatus).toBeNull();
    expect(hist[0].toStatus).toBe('PENDING');
    expect(hist[1].fromStatus).toBe('PENDING');
    expect(hist[1].toStatus).toBe('APPROVED');
  });

  test('PATCH status aynı kalırsa history yazılmaz (gürültü engeli)', async () => {
    const adminReq = makeRequest(makeUser({ username: 'admin1', groups: ['Admin'] }));
    const b = await svc.create({ taskTitle: 't3', userGroup: 'Booking', status: 'PENDING' }, adminReq);
    // status'a dokunmadan başka field update
    await svc.update(b.id, { taskTitle: 't3-updated' }, undefined, adminReq);
    const hist = await svc.listStatusHistory(b.id, adminReq);
    expect(hist).toHaveLength(1); // sadece initial
  });

  test('grup dışı kullanıcı GET status-history → 403; Admin → 200', async () => {
    const adminReq = makeRequest(makeUser({ username: 'admin1', groups: ['Admin'] }));
    const b = await svc.create({ taskTitle: 't4', userGroup: 'Booking', status: 'PENDING' }, adminReq);
    const outsiderReq = makeRequest(makeUser({ username: 'o', groups: ['Ingest'] }));
    await expect(svc.listStatusHistory(b.id, outsiderReq))
      .rejects.toMatchObject({ statusCode: 403 });
    const adminList = await svc.listStatusHistory(b.id, adminReq);
    expect(adminList.length).toBeGreaterThanOrEqual(1);
  });
});

// Disconnect setup.ts afterAll'ında yapılıyor (helpers.disconnectPrisma).
