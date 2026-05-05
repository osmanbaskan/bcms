import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createEnvelope, isValidEventId } from './outbox.types.js';
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

  test('index existence sanity: status_next_attempt + aggregate + event_type', async () => {
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
    // Plus PK and unique on event_id.
    const hasPk = names.some((n) => n.endsWith('_pkey'));
    expect(hasPk).toBe(true);
  });
});
