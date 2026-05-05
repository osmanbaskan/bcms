import { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JwtPayload } from '@bcms/shared';

/**
 * Test helpers for integration suite.
 * Bkz: ops/REQUIREMENTS-BACKEND-INTEGRATION-TESTS.md §5
 */

/**
 * Transactional tablolar — afterEach cleanup ile sıfırlanır.
 * SEED tabloları (channels, leagues, broadcast_types, recording_ports,
 * studio_plan_programs, studio_plan_colors) bu listede YOK; kalıcı fixture.
 */
const TRANSACTIONAL_TABLES = [
  'audit_logs',
  'timeline_events',
  'incidents',
  'bookings',
  'schedules',
  'ingest_plan_item_ports',
  'ingest_plan_items',
  'ingest_jobs',
  'qc_reports',
  'signal_telemetry',
  'shift_assignments',
  'studio_plan_slots',
  'studio_plans',
  'matches',
  'teams',
];

let prismaSingleton: PrismaClient | null = null;

/** Test prisma client (audit extension'sız raw — fixture seed/cleanup için). */
export function getRawPrisma(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ['warn', 'error'],
    });
  }
  return prismaSingleton;
}

/** Suite teardown'da çağrılır — connection pool drain. */
export async function disconnectPrisma(): Promise<void> {
  if (prismaSingleton) {
    await prismaSingleton.$disconnect();
    prismaSingleton = null;
  }
}

/**
 * afterEach cleanup — transactional tabloları truncate eder.
 * Seed tabloları (channels, leagues, vb.) korunur.
 */
export async function cleanupTransactional(): Promise<void> {
  const prisma = getRawPrisma();
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TRANSACTIONAL_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

/**
 * Minimal seed — channels, broadcast_types, leagues. Booking spec için yeterli.
 * Idempotent: zaten varsa skip eder (CI'da migrate reset sonrası çalışır).
 */
export async function seedTestFixtures(): Promise<void> {
  const prisma = getRawPrisma();

  // Channels (HD/SD)
  await prisma.channel.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, name: 'beIN Sports 1 HD', type: 'HD', active: true },
  });
  await prisma.channel.upsert({
    where: { id: 2 },
    update: {},
    create: { id: 2, name: 'beIN Sports 2 HD', type: 'HD', active: true },
  });

  // Broadcast types
  await prisma.broadcastType.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, code: 'MATCH', description: 'Maç' },
  });

  // League
  await prisma.league.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, code: 'opta-115', name: 'Süper Lig', country: 'Türkiye' },
  });
}

/**
 * Booking spec için ek fixture: schedule oluşturur (test'in ihtiyacına göre çağrılır).
 */
export async function createTestSchedule(opts?: {
  channelId?: number;
  startTime?: Date;
  endTime?: Date;
  title?: string;
  status?: 'DRAFT' | 'CONFIRMED' | 'ON_AIR' | 'COMPLETED' | 'CANCELLED';
}): Promise<{ id: number }> {
  const prisma = getRawPrisma();
  const now = new Date();
  const start = opts?.startTime ?? new Date(now.getTime() + 60 * 60 * 1000); // +1h
  const end = opts?.endTime ?? new Date(start.getTime() + 90 * 60 * 1000);    // +1.5h
  const created = await prisma.schedule.create({
    data: {
      channelId: opts?.channelId ?? 1,
      startTime: start,
      endTime: end,
      title: opts?.title ?? 'Integration test schedule',
      status: opts?.status ?? 'CONFIRMED',
      usageScope: 'broadcast',
      createdBy: 'integration-test',
    },
  });
  return { id: created.id };
}

/**
 * Mock FastifyRequest — service'in ihtiyacı `request.user`, `request.ip`, `request.headers`.
 * BookingService doğrudan request objesini kullanıyor.
 */
export function makeRequest(user: JwtPayload): FastifyRequest {
  return {
    user,
    ip: '127.0.0.1',
    headers: {},
  } as unknown as FastifyRequest;
}

/**
 * Minimal app harness — BookingService'in ihtiyaç duyduğu app shape.
 * Real prisma + audit extension; rabbitmq publish in-memory recorder.
 */
export interface PublishedEvent {
  queue: string;
  payload: unknown;
}

export interface TestAppHarness {
  app: Pick<FastifyInstance, 'prisma' | 'log' | 'rabbitmq'>;
  publishedEvents: PublishedEvent[];
}

export function makeAppHarness(): TestAppHarness {
  const publishedEvents: PublishedEvent[] = [];
  const prisma = getRawPrisma();
  // Note: audit extension test scope'u dışında; booking.service direct DB davranışı test edilir.
  // Audit plugin spec'i ayrı PR'da $extends'li client kullanacak.
  const harness: TestAppHarness = {
    app: {
      prisma,
      log: {
        info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {}, trace: () => {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      rabbitmq: {
        isConnected: () => true,
        publish: async (queue: string, payload: unknown) => {
          publishedEvents.push({ queue, payload });
        },
        consume: async () => {},
        close: async () => {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    },
    publishedEvents,
  };
  return harness;
}

/** JwtPayload factory. */
export function makeUser(opts: {
  username: string;
  groups: string[];
  email?: string;
}): JwtPayload {
  return {
    sub: opts.username,
    preferred_username: opts.username,
    email: opts.email ?? `${opts.username}@bcms.test`,
    groups: opts.groups,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}
