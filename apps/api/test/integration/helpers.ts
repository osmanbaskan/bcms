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
  'outbox_events',
  'live_plan_entries',
  // Madde 5 M5-B4: lookup tabloları (25 adet — testlerde isolated kalmalı;
  // seed migration tarafından doldurulduğu için truncate sonrası boş kalır;
  // testler kendi seed'ini yapar).
  'transmission_satellites',
  'transmission_irds',
  'transmission_fibers',
  'transmission_int_resources',
  'transmission_tie_options',
  'transmission_demod_options',
  'transmission_virtual_resources',
  'transmission_feed_types',
  'transmission_modulation_types',
  'transmission_video_codings',
  'transmission_audio_configs',
  'transmission_key_types',
  'transmission_polarizations',
  'transmission_fec_rates',
  'transmission_roll_offs',
  'transmission_iso_feed_options',
  'technical_companies',
  'live_plan_equipment_options',
  'live_plan_locations',
  'live_plan_usage_locations',
  'live_plan_regions',
  'live_plan_languages',
  'live_plan_off_tube_options',
  'fiber_audio_formats',
  'fiber_video_formats',
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
 * Madde 4 interim helper (2026-05-04):
 * Schema.prisma'da CHECK constraint yok (Prisma 5 native desteği yok); production
 * migration `20260422000002_schedule_usage_scope_constraint` ile uygulanır.
 *
 * Test DB'si `db push --force-reset` ile sync edildiği için migration'lar
 * tüketilmiyor — CHECK constraint manuel reapply edilir.
 *
 * Idempotent: DROP IF EXISTS + ADD; ikinci çalıştırmada hata vermez (CI re-run,
 * lokal watch mode, vb. senaryolar).
 *
 * Madde 1 (migration baseline) sonrası bu helper kaldırılır — migrate reset
 * production migration'ları doğal olarak uygular.
 */
export async function applyTestConstraints(): Promise<void> {
  const prisma = getRawPrisma();
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "schedules"
    DROP CONSTRAINT IF EXISTS "schedules_usage_scope_check"
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "schedules"
    ADD CONSTRAINT "schedules_usage_scope_check"
    CHECK ("usage_scope" IN ('broadcast', 'live-plan'))
  `);
}

/**
 * Madde 2+7 PR-A interim helper (2026-05-06):
 * outbox_events.status CHECK constraint manuel reapply (Madde 4 ile aynı pattern;
 * Prisma 5 native CHECK desteklemiyor + db push migration tüketmiyor).
 *
 * Idempotent: DROP IF EXISTS + ADD.
 *
 * Madde 1 (migration baseline) sonrası kaldırılır.
 */
export async function applyOutboxConstraints(): Promise<void> {
  const prisma = getRawPrisma();
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "outbox_events"
    DROP CONSTRAINT IF EXISTS "outbox_events_status_check"
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "outbox_events"
    ADD CONSTRAINT "outbox_events_status_check"
    CHECK ("status" IN ('pending','published','failed','dead'))
  `);
}

/**
 * Madde 5 M5-B4 interim helper (2026-05-06):
 * Live-plan lookup tabloları için partial unique index + CHECK constraint
 * manuel reapply. Prisma 5 partial unique + functional index + CHECK
 * desteği sınırlı; migration SQL'de uygulanan bu constraint'ler db push
 * ile yeniden oluşturulmaz.
 *
 * Idempotent: DROP IF EXISTS + CREATE/ADD.
 *
 * Madde 1 (migration baseline) sonrası kaldırılır.
 */
export async function applyLivePlanLookupConstraints(): Promise<void> {
  const prisma = getRawPrisma();
  const tables: { name: string; type?: string[] }[] = [
    { name: 'transmission_satellites' },
    { name: 'transmission_irds' },
    { name: 'transmission_fibers' },
    { name: 'transmission_int_resources' },
    { name: 'transmission_tie_options' },
    { name: 'transmission_demod_options' },
    { name: 'transmission_virtual_resources' },
    { name: 'transmission_feed_types' },
    { name: 'transmission_modulation_types' },
    { name: 'transmission_video_codings' },
    { name: 'transmission_audio_configs' },
    { name: 'transmission_key_types' },
    { name: 'transmission_polarizations' },
    { name: 'transmission_fec_rates' },
    { name: 'transmission_roll_offs' },
    { name: 'transmission_iso_feed_options' },
    { name: 'live_plan_locations' },
    { name: 'live_plan_usage_locations' },
    { name: 'live_plan_regions' },
    { name: 'live_plan_languages' },
    { name: 'live_plan_off_tube_options' },
    { name: 'fiber_audio_formats' },
    { name: 'fiber_video_formats' },
  ];
  // CHECK length(trim(label)) > 0 + partial unique LOWER(label)
  for (const t of tables) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${t.name}"
      DROP CONSTRAINT IF EXISTS "${t.name}_label_not_blank"
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${t.name}"
      ADD CONSTRAINT "${t.name}_label_not_blank"
      CHECK (length(trim("label")) > 0)
    `);
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${t.name}_label_uniq"`);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX "${t.name}_label_uniq"
      ON "${t.name}"(LOWER("label"))
      WHERE "deleted_at" IS NULL
    `);
  }
  // Type-polymorphic tablolar (technical_companies + live_plan_equipment_options):
  // partial unique (type, LOWER(label)) + type CHECK + label CHECK + type index.
  const polymorphic = [
    {
      name:    'technical_companies',
      types:   ['OB_VAN', 'GENERATOR', 'SNG', 'CARRIER', 'FIBER'],
    },
    {
      name:    'live_plan_equipment_options',
      types:   ['JIMMY_JIB', 'STEADICAM', 'IBM'],
    },
  ];
  for (const p of polymorphic) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${p.name}"
      DROP CONSTRAINT IF EXISTS "${p.name}_label_not_blank"
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${p.name}"
      ADD CONSTRAINT "${p.name}_label_not_blank"
      CHECK (length(trim("label")) > 0)
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${p.name}"
      DROP CONSTRAINT IF EXISTS "${p.name}_type_check"
    `);
    const typeList = p.types.map((t) => `'${t}'`).join(', ');
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${p.name}"
      ADD CONSTRAINT "${p.name}_type_check"
      CHECK ("type" IN (${typeList}))
    `);
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${p.name}_type_label_uniq"`);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX "${p.name}_type_label_uniq"
      ON "${p.name}"("type", LOWER("label"))
      WHERE "deleted_at" IS NULL
    `);
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${p.name}_type_idx"`);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX "${p.name}_type_idx" ON "${p.name}"("type") WHERE "deleted_at" IS NULL
    `);
  }
}

/**
 * Madde 2+7 PR-B3b-2 schema PR interim helper (2026-05-06):
 * outbox_events.idempotency_key partial unique index manuel reapply.
 *
 * Production migration: 20260506000001_outbox_idempotency_key. Test DB
 * `db push --force-reset` ile sync edildiği için partial UNIQUE index tüketilmez
 * (db push partial unique attribute'unu schema.prisma'dan üretemez; bilinçli
 * olarak sadece nullable field tutuluyor). Bu helper aynı index'i reapply eder.
 *
 * Idempotent: DROP IF EXISTS + CREATE UNIQUE.
 *
 * Madde 1 (migration baseline) sonrası kaldırılır.
 */
export async function applyOutboxIdempotencyIndex(): Promise<void> {
  const prisma = getRawPrisma();
  await prisma.$executeRawUnsafe(`
    DROP INDEX IF EXISTS "outbox_events_idempotency_key_uniq"
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX "outbox_events_idempotency_key_uniq"
    ON "outbox_events"("idempotency_key")
    WHERE "idempotency_key" IS NOT NULL
  `);
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
