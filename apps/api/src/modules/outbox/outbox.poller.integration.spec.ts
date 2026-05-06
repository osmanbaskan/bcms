import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { pollOnce } from './outbox.poller.js';
import { resolveOutboxQueue } from './outbox.routing.js';
import {
  cleanupTransactional,
  getRawPrisma,
  makeAppHarness,
  type TestAppHarness,
} from '../../../test/integration/helpers.js';

/**
 * Madde 2+7 PR-C1: Outbox poller state machine integration.
 *
 * Test izolasyonu — Phase 2 davranışı:
 *   Mevcut writeShadowEvent helper status='published' yazıyor → poller pick
 *   etmez. Bu spec poller'ı doğrulamak için test setup'ında manuel olarak
 *   `status='pending'` row insert eder; helper davranışı dokunulmaz (PR-C2
 *   shadow→pending davranış değişikliği).
 *
 * Kapsam:
 *   ✓ pick + publish + status='published' (happy path)
 *   ✓ multiple events: batch processing
 *   ✓ publish failure → status='failed' + backoff next_attempt_at
 *   ✓ MAX_ATTEMPTS reached → status='dead'
 *   ✓ unknown event_type → failed (routing eksik), poller crash etmez
 *   ✓ DRY_RUN: pick + skip; satır pending kalır
 *   ✓ next_attempt_at gelecekte: pick edilmez
 *   ✓ status='published' satır: pick edilmez
 */

interface InsertPendingArgs {
  eventType:     string;
  aggregateType: string;
  aggregateId:   string | number;
  payload:       Record<string, unknown>;
  attempts?:     number;
  nextAttemptAt?: Date;
  status?:       'pending' | 'failed' | 'published' | 'dead';
}

async function insertOutboxRow(args: InsertPendingArgs): Promise<{ id: number; eventId: string }> {
  const prisma = getRawPrisma();
  const { randomUUID } = await import('node:crypto');
  const eventId = randomUUID();
  const row = await prisma.outboxEvent.create({
    data: {
      eventId,
      eventType:     args.eventType,
      aggregateType: args.aggregateType,
      aggregateId:   String(args.aggregateId),
      schemaVersion: 1,
      payload:       args.payload as Prisma.InputJsonValue,
      status:        args.status ?? 'pending',
      attempts:      args.attempts ?? 0,
      occurredAt:    new Date(),
      nextAttemptAt: args.nextAttemptAt ?? new Date(),
    },
  });
  return { id: row.id, eventId };
}

describe('outbox poller — integration', () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    delete process.env.OUTBOX_POLLER_DRY_RUN;
  });

  afterEach(() => {
    delete process.env.OUTBOX_POLLER_DRY_RUN;
  });

  test('happy path: pending → publish → published', async () => {
    const inserted = await insertOutboxRow({
      eventType:     'booking.created',
      aggregateType: 'Booking',
      aggregateId:   42,
      payload:       { bookingId: 42, scheduleId: 7 },
    });

    const result = await pollOnce(harness.app as unknown as FastifyInstance);
    expect(result).toMatchObject({ picked: 1, published: 1, failed: 0, dead: 0, skipped: 0 });

    const prisma = getRawPrisma();
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: inserted.id } });
    expect(row.status).toBe('published');
    expect(row.publishedAt).not.toBeNull();
    expect(row.attempts).toBe(0);

    expect(harness.publishedEvents).toHaveLength(1);
    expect(harness.publishedEvents[0].queue).toBe(resolveOutboxQueue('booking.created'));
    expect(harness.publishedEvents[0].payload).toEqual({ bookingId: 42, scheduleId: 7 });
  });

  test('batch: multiple pending → hepsi published', async () => {
    await insertOutboxRow({
      eventType: 'schedule.created', aggregateType: 'Schedule', aggregateId: 1, payload: { scheduleId: 1 },
    });
    await insertOutboxRow({
      eventType: 'booking.created', aggregateType: 'Booking', aggregateId: 2, payload: { bookingId: 2 },
    });
    await insertOutboxRow({
      eventType: 'ingest.job_started', aggregateType: 'IngestJob', aggregateId: 3, payload: { jobId: 3 },
    });

    const result = await pollOnce(harness.app as unknown as FastifyInstance);
    expect(result.picked).toBe(3);
    expect(result.published).toBe(3);
    expect(harness.publishedEvents).toHaveLength(3);

    const prisma = getRawPrisma();
    const remaining = await prisma.outboxEvent.count({ where: { status: 'pending' } });
    expect(remaining).toBe(0);
  });

  test('publish failure → status=failed, attempts=1, backoff schedule', async () => {
    // Failing publish: harness publish'i fırlatacak şekilde override.
    let publishCalls = 0;
    harness.app.rabbitmq.publish = (async () => {
      publishCalls += 1;
      throw new Error('rmq down');
    }) as typeof harness.app.rabbitmq.publish;

    const inserted = await insertOutboxRow({
      eventType: 'booking.created', aggregateType: 'Booking', aggregateId: 99, payload: { bookingId: 99 },
    });

    const beforeMs = Date.now();
    const result = await pollOnce(harness.app as unknown as FastifyInstance);
    expect(result).toMatchObject({ picked: 1, published: 0, failed: 1, dead: 0 });
    expect(publishCalls).toBe(1);

    const prisma = getRawPrisma();
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: inserted.id } });
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('rmq down');
    // BACKOFF_BASE_MS = 5000, attempts=0 → 5s offset.
    const offsetMs = row.nextAttemptAt.getTime() - beforeMs;
    expect(offsetMs).toBeGreaterThanOrEqual(4_500);
    expect(offsetMs).toBeLessThanOrEqual(6_500);
  });

  test('MAX_ATTEMPTS reached → status=dead', async () => {
    harness.app.rabbitmq.publish = (async () => {
      throw new Error('persistent failure');
    }) as typeof harness.app.rabbitmq.publish;

    // attempts=4 + bu poll → 5 (MAX); dead'e geçmeli.
    const inserted = await insertOutboxRow({
      eventType: 'booking.created', aggregateType: 'Booking', aggregateId: 5, payload: { bookingId: 5 },
      attempts: 4,
    });

    const result = await pollOnce(harness.app as unknown as FastifyInstance);
    expect(result).toMatchObject({ picked: 1, failed: 0, dead: 1 });

    const prisma = getRawPrisma();
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: inserted.id } });
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(5);
  });

  test('unknown event_type → failed, poller crash etmez', async () => {
    const inserted = await insertOutboxRow({
      eventType: 'unknown.event',
      aggregateType: 'X',
      aggregateId: 1,
      payload: {},
    });

    const result = await pollOnce(harness.app as unknown as FastifyInstance);
    expect(result.picked).toBe(1);
    expect(result.failed).toBe(1);
    expect(harness.publishedEvents).toHaveLength(0);

    const prisma = getRawPrisma();
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: inserted.id } });
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/queue routing tanımlı değil/);
  });

  test('DRY_RUN: pick + skip; status pending kalır', async () => {
    process.env.OUTBOX_POLLER_DRY_RUN = 'true';
    const inserted = await insertOutboxRow({
      eventType: 'booking.created', aggregateType: 'Booking', aggregateId: 10, payload: { bookingId: 10 },
    });

    const result = await pollOnce(harness.app as unknown as FastifyInstance);
    expect(result).toMatchObject({ picked: 1, published: 0, failed: 0, skipped: 1 });
    expect(harness.publishedEvents).toHaveLength(0);

    const prisma = getRawPrisma();
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: inserted.id } });
    expect(row.status).toBe('pending');
    expect(row.publishedAt).toBeNull();
  });

  test('next_attempt_at gelecekte → pick edilmez', async () => {
    await insertOutboxRow({
      eventType: 'booking.created', aggregateType: 'Booking', aggregateId: 11, payload: { bookingId: 11 },
      nextAttemptAt: new Date(Date.now() + 60_000),
    });

    const result = await pollOnce(harness.app as unknown as FastifyInstance);
    expect(result.picked).toBe(0);
    expect(harness.publishedEvents).toHaveLength(0);
  });

  test('status=published satır pick edilmez (Phase 2 invariant)', async () => {
    // PR-C1 invariant: writeShadowEvent default status='published' → poller bunu
    // pick etmez. Bu test o invariant'ı doğrular.
    await insertOutboxRow({
      eventType: 'booking.created', aggregateType: 'Booking', aggregateId: 12, payload: { bookingId: 12 },
      status: 'published',
    });
    await insertOutboxRow({
      eventType: 'booking.created', aggregateType: 'Booking', aggregateId: 13, payload: { bookingId: 13 },
      status: 'failed',
    });
    await insertOutboxRow({
      eventType: 'booking.created', aggregateType: 'Booking', aggregateId: 14, payload: { bookingId: 14 },
      status: 'dead',
    });

    const result = await pollOnce(harness.app as unknown as FastifyInstance);
    expect(result.picked).toBe(0);
    expect(harness.publishedEvents).toHaveLength(0);
  });
});
