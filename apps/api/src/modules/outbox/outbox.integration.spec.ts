import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createEnvelope, isValidEventId } from './outbox.types.js';
import { writeShadowEvent } from './outbox.helpers.js';
import { cleanupTransactional, getRawPrisma } from '../../../test/integration/helpers.js';

/**
 * Madde 2+7 PR-A spec — outbox_events foundation.
 *
 * Sadece schema/CRUD/CHECK constraint mekanik doğrulamaları. Status transition
 * **policy** (pending→published gibi) PR-C application layer'ında gelir;
 * burada sadece DB-level update doğrulanır (kullanıcı guard 1).
 */

describe('createEnvelope helper', () => {
  test('UUID v4 + ISO 8601 + defaults', () => {
    const env = createEnvelope({
      eventType: 'schedule.created',
      aggregateType: 'Schedule',
      aggregateId: 42,
      payload: { scheduleId: 42, channelId: 1 },
    });
    expect(isValidEventId(env.eventId)).toBe(true);
    expect(env.aggregateId).toBe('42'); // number → string
    expect(env.schemaVersion).toBe(1);
    expect(new Date(env.occurredAt).toISOString()).toBe(env.occurredAt); // round-trip ISO
    expect(env.payload).toEqual({ scheduleId: 42, channelId: 1 });
    expect(env.eventType).toBe('schedule.created');
  });

  test('schemaVersion override + string aggregateId', () => {
    const env = createEnvelope({
      eventType: 'booking.status_changed',
      aggregateType: 'Booking',
      aggregateId: 'b-789',
      payload: { status: 'APPROVED' },
      schemaVersion: 2,
    });
    expect(env.aggregateId).toBe('b-789');
    expect(env.schemaVersion).toBe(2);
  });

  test('her çağrı yeni eventId üretir (idempotency anchor)', () => {
    const a = createEnvelope({ eventType: 't', aggregateType: 'T', aggregateId: 1, payload: {} });
    const b = createEnvelope({ eventType: 't', aggregateType: 'T', aggregateId: 1, payload: {} });
    expect(a.eventId).not.toBe(b.eventId);
  });

  test('isValidEventId: invalid format → false', () => {
    expect(isValidEventId('not-a-uuid')).toBe(false);
    expect(isValidEventId('00000000-0000-0000-0000-000000000000')).toBe(false); // not v4
  });
});

describe('OutboxEvent — DB integration', () => {
  beforeEach(async () => {
    await cleanupTransactional();
  });

  afterEach(() => { /* per-test cleanup beforeEach'te */ });

  test('create: defaults (status=pending, attempts=0, next_attempt_at≈now)', async () => {
    const prisma = getRawPrisma();
    const env = createEnvelope({
      eventType: 'schedule.created',
      aggregateType: 'Schedule',
      aggregateId: 1,
      payload: { scheduleId: 1 },
    });
    const created = await prisma.outboxEvent.create({
      data: {
        eventId: env.eventId,
        eventType: env.eventType,
        aggregateType: env.aggregateType,
        aggregateId: env.aggregateId,
        schemaVersion: env.schemaVersion,
        payload: env.payload,
        occurredAt: new Date(env.occurredAt),
      },
    });
    expect(created.status).toBe('pending');
    expect(created.attempts).toBe(0);
    expect(created.publishedAt).toBeNull();
    expect(created.lastError).toBeNull();
    expect(created.eventId).toBe(env.eventId);
    expect(Math.abs(created.nextAttemptAt.getTime() - Date.now())).toBeLessThan(5000);
  });

  test('create: eventId unique constraint → P2002 on duplicate', async () => {
    const prisma = getRawPrisma();
    const env = createEnvelope({
      eventType: 't', aggregateType: 'T', aggregateId: 1, payload: {},
    });
    const baseData = {
      eventId: env.eventId,
      eventType: env.eventType,
      aggregateType: env.aggregateType,
      aggregateId: env.aggregateId,
      payload: env.payload,
      occurredAt: new Date(env.occurredAt),
    };
    await prisma.outboxEvent.create({ data: baseData });
    await expect(
      prisma.outboxEvent.create({ data: baseData }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  test('CHECK constraint: invalid status → 23514 violation', async () => {
    const prisma = getRawPrisma();
    const env = createEnvelope({
      eventType: 't', aggregateType: 'T', aggregateId: 1, payload: {},
    });
    // Raw insert ile CHECK bypass denemesi (Prisma client status enum kabul etse de
    // application bir typo geçirebilir; CHECK son savunma).
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "outbox_events"
          ("event_id", "event_type", "aggregate_type", "aggregate_id",
           "payload", "status", "occurred_at")
        VALUES
          ('${env.eventId}', 't', 'T', '1', '{}', 'invalid_status', NOW())
      `),
    ).rejects.toThrow();
    // Hata mesajı CHECK'i işaret eder (PG code 23514).
  });

  test('can update status field mechanically (no policy enforcement)', async () => {
    // Not: PR-A scope sadece DB-level mekanik. Valid transition policy
    // (pending→published OK, published→pending NO, vb.) PR-C application
    // layer'ında gelir; bu test sadece UPDATE çalışıyor mu doğrulamak içindir.
    const prisma = getRawPrisma();
    const env = createEnvelope({
      eventType: 't', aggregateType: 'T', aggregateId: 1, payload: {},
    });
    const created = await prisma.outboxEvent.create({
      data: {
        eventId: env.eventId,
        eventType: env.eventType,
        aggregateType: env.aggregateType,
        aggregateId: env.aggregateId,
        payload: env.payload,
        occurredAt: new Date(env.occurredAt),
      },
    });

    // pending → published mechanically (DB allows; policy değil)
    const published = await prisma.outboxEvent.update({
      where: { id: created.id },
      data: { status: 'published', publishedAt: new Date(), attempts: 1 },
    });
    expect(published.status).toBe('published');
    expect(published.publishedAt).not.toBeNull();

    // failed mechanical update + lastError + nextAttemptAt push
    const failed = await prisma.outboxEvent.update({
      where: { id: created.id },
      data: {
        status: 'failed',
        attempts: 2,
        lastError: 'connection refused',
        nextAttemptAt: new Date(Date.now() + 10_000),
      },
    });
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toBe('connection refused');

    // dead mechanical
    const dead = await prisma.outboxEvent.update({
      where: { id: created.id },
      data: { status: 'dead' },
    });
    expect(dead.status).toBe('dead');

    // Policy (örn. dead → pending revert) burada test edilmez; PR-C/D scope.
  });

  test('index existence sanity: status_next_attempt + aggregate + event_type + idempotency_key', async () => {
    const prisma = getRawPrisma();
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'outbox_events'
      ORDER BY indexname
    `;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('outbox_events_status_next_attempt_idx');
    expect(names).toContain('outbox_events_aggregate_idx');
    expect(names).toContain('outbox_events_event_type_idx');
    // Madde 2+7 PR-B3b-2 schema PR: partial unique index.
    expect(names).toContain('outbox_events_idempotency_key_uniq');
    // Plus PK and unique on event_id.
    const hasPk = names.some((n) => n.endsWith('_pkey'));
    expect(hasPk).toBe(true);
  });
});

/**
 * Madde 2+7 PR-B3b-2 schema PR: writeShadowEvent idempotency_key davranışı.
 *
 * Cross-producer dedup contract — aynı idempotency key ile iki call DB UNIQUE
 * üzerinden tek satıra düşer; helper inserted=false sinyali verir.
 */
describe('writeShadowEvent — idempotency_key', () => {
  beforeEach(async () => {
    await cleanupTransactional();
  });

  test('aynı key ile iki call → tek satır, ikincisi inserted=false', async () => {
    const prisma = getRawPrisma();
    const key = 'ingest.job_completed:IngestJob:1:COMPLETED';

    const first = await prisma.$transaction(async (tx) =>
      writeShadowEvent(tx, {
        eventType: 'ingest.job_completed',
        aggregateType: 'IngestJob',
        aggregateId: 1,
        payload: { jobId: 1, status: 'COMPLETED' },
        idempotencyKey: key,
      }),
    );
    const second = await prisma.$transaction(async (tx) =>
      writeShadowEvent(tx, {
        eventType: 'ingest.job_completed',
        aggregateType: 'IngestJob',
        aggregateId: 1,
        payload: { jobId: 1, status: 'COMPLETED' },
        idempotencyKey: key,
      }),
    );

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    // Skip durumunda mevcut satırın eventId'si döner (caller telemetri için).
    expect(second.eventId).toBe(first.eventId);

    const rows = await prisma.outboxEvent.findMany({
      where: { idempotencyKey: key },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe(first.eventId);
    expect(rows[0].status).toBe('published');
    expect(rows[0].publishedAt).not.toBeNull();
  });

  test('farklı key → iki satır (terminal status farklılığı senaryosu)', async () => {
    const prisma = getRawPrisma();
    const completedKey = 'ingest.job_completed:IngestJob:7:COMPLETED';
    const failedKey    = 'ingest.job_completed:IngestJob:7:FAILED';

    const a = await prisma.$transaction(async (tx) =>
      writeShadowEvent(tx, {
        eventType: 'ingest.job_completed',
        aggregateType: 'IngestJob',
        aggregateId: 7,
        payload: { jobId: 7, status: 'COMPLETED' },
        idempotencyKey: completedKey,
      }),
    );
    const b = await prisma.$transaction(async (tx) =>
      writeShadowEvent(tx, {
        eventType: 'ingest.job_completed',
        aggregateType: 'IngestJob',
        aggregateId: 7,
        payload: { jobId: 7, status: 'FAILED' },
        idempotencyKey: failedKey,
      }),
    );

    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(true);
    expect(a.eventId).not.toBe(b.eventId);

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'IngestJob', aggregateId: '7' },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotencyKey).sort()).toEqual([completedKey, failedKey]);
  });

  test('idempotencyKey undefined → her call yeni satır (mevcut domain davranışı)', async () => {
    const prisma = getRawPrisma();

    const a = await prisma.$transaction(async (tx) =>
      writeShadowEvent(tx, {
        eventType: 'booking.created',
        aggregateType: 'Booking',
        aggregateId: 100,
        payload: { bookingId: 100 },
      }),
    );
    const b = await prisma.$transaction(async (tx) =>
      writeShadowEvent(tx, {
        eventType: 'booking.created',
        aggregateType: 'Booking',
        aggregateId: 100,
        payload: { bookingId: 100 },
      }),
    );

    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(true);
    expect(a.eventId).not.toBe(b.eventId);

    const rows = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'Booking', aggregateId: '100' },
    });
    expect(rows).toHaveLength(2);
    // Partial unique index NULL'lara dokunmaz.
    expect(rows.every((r) => r.idempotencyKey === null)).toBe(true);
  });

  test('idempotencyKey="" → undefined-equivalent, normal insert', async () => {
    const prisma = getRawPrisma();

    const result = await prisma.$transaction(async (tx) =>
      writeShadowEvent(tx, {
        eventType: 'schedule.created',
        aggregateType: 'Schedule',
        aggregateId: 5,
        payload: { scheduleId: 5 },
        idempotencyKey: '',
      }),
    );
    expect(result.inserted).toBe(true);

    const row = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventId: result.eventId },
    });
    expect(row.idempotencyKey).toBeNull();
  });

  test('idempotencyKey > 160 char → throw before insert', async () => {
    const prisma = getRawPrisma();
    const tooLong = 'x'.repeat(161);

    await expect(
      prisma.$transaction(async (tx) =>
        writeShadowEvent(tx, {
          eventType: 't',
          aggregateType: 'T',
          aggregateId: 1,
          payload: {},
          idempotencyKey: tooLong,
        }),
      ),
    ).rejects.toThrow(/160 karakter/);

    // Insert atılmadığından satır yok.
    const count = await prisma.outboxEvent.count();
    expect(count).toBe(0);
  });
});
