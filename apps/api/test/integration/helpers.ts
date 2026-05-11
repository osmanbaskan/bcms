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
  // Madde 5 M5-B7: technical details (1:1 with live_plan_entries; CASCADE
  // truncate ile temizlenir ama explicit listeleyerek RESTART IDENTITY
  // sırası korunsun).
  'live_plan_technical_details',
  // Madde 5 M5-B8: transmission segments (1:N with live_plan_entries;
  // CASCADE).
  'live_plan_transmission_segments',
  // SCHED-B2: schedule lookup tabloları (3 yeni; M5-B4 paritesi).
  'schedule_commercial_options',
  'schedule_logo_options',
  'schedule_format_options',
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
  // SCHED-B5a (Y5-2a, 2026-05-08): legacy `schedules_usage_scope_check`
  // CHECK reapply kaldırıldı (kolon Prisma schema'dan silindi; B5a Block 2
  // migration'ında DB DROP CONSTRAINT). Helper boş bırakıldı (idempotent
  // no-op); diğer test setup'lar bu helper'ı çağırmaya devam edebilir.
  void getRawPrisma;
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
 * Madde 5 M5-B7 interim helper (2026-05-07):
 * `live_plan_technical_details` üzerindeki 25 lookup FK (RESTRICT) + parent
 * CASCADE FK + CHECK (planned_end > planned_start) constraints'lerini test
 * DB'sinde reapply eder.
 *
 * Niçin gerekli: Prisma schema'da scalar-only FK kolon (relation tanımlanmadı,
 * 47 reverse field patlamasını önlemek için). `prisma db push --force-reset`
 * yalnızca `@relation` ile işaretli FK'leri ve CHECK'i oluşturmaz; bu helper
 * migration SQL'deki constraint setini test ortamına idempotent uygular.
 *
 * Idempotent: DROP IF EXISTS + ADD.
 *
 * Madde 1 (migration baseline) sonrası kaldırılır.
 */
export async function applyLivePlanTechnicalDetailsConstraints(): Promise<void> {
  const prisma = getRawPrisma();

  /** [constraintName, columnName, refTable] */
  const lookupFks: Array<[string, string, string]> = [
    ['lpt_broadcast_location_fkey',         'broadcast_location_id',         'live_plan_locations'],
    ['lpt_ob_van_company_fkey',             'ob_van_company_id',             'technical_companies'],
    ['lpt_generator_company_fkey',          'generator_company_id',          'technical_companies'],
    ['lpt_jimmy_jib_fkey',                  'jimmy_jib_id',                  'live_plan_equipment_options'],
    ['lpt_steadicam_fkey',                  'steadicam_id',                  'live_plan_equipment_options'],
    ['lpt_sng_company_fkey',                'sng_company_id',                'technical_companies'],
    ['lpt_carrier_company_fkey',            'carrier_company_id',            'technical_companies'],
    ['lpt_ibm_fkey',                        'ibm_id',                        'live_plan_equipment_options'],
    ['lpt_usage_location_fkey',             'usage_location_id',             'live_plan_usage_locations'],
    ['lpt_second_ob_van_fkey',              'second_ob_van_id',              'technical_companies'],
    ['lpt_region_fkey',                     'region_id',                     'live_plan_regions'],
    ['lpt_hdvg_resource_fkey',              'hdvg_resource_id',              'transmission_int_resources'],
    ['lpt_int1_resource_fkey',              'int1_resource_id',              'transmission_int_resources'],
    ['lpt_int2_resource_fkey',              'int2_resource_id',              'transmission_int_resources'],
    ['lpt_off_tube_fkey',                   'off_tube_id',                   'live_plan_off_tube_options'],
    ['lpt_language_fkey',                   'language_id',                   'live_plan_languages'],
    ['lpt_demod_fkey',                      'demod_id',                      'transmission_demod_options'],
    ['lpt_tie_fkey',                        'tie_id',                        'transmission_tie_options'],
    ['lpt_virtual_resource_fkey',           'virtual_resource_id',           'transmission_virtual_resources'],
    ['lpt_ird1_fkey',                       'ird1_id',                       'transmission_irds'],
    ['lpt_ird2_fkey',                       'ird2_id',                       'transmission_irds'],
    ['lpt_ird3_fkey',                       'ird3_id',                       'transmission_irds'],
    ['lpt_fiber1_fkey',                     'fiber1_id',                     'transmission_fibers'],
    ['lpt_fiber2_fkey',                     'fiber2_id',                     'transmission_fibers'],
    ['lpt_feed_type_fkey',                  'feed_type_id',                  'transmission_feed_types'],
    ['lpt_satellite_fkey',                  'satellite_id',                  'transmission_satellites'],
    ['lpt_uplink_polarization_fkey',        'uplink_polarization_id',        'transmission_polarizations'],
    ['lpt_downlink_polarization_fkey',      'downlink_polarization_id',      'transmission_polarizations'],
    ['lpt_modulation_type_fkey',            'modulation_type_id',            'transmission_modulation_types'],
    ['lpt_roll_off_fkey',                   'roll_off_id',                   'transmission_roll_offs'],
    ['lpt_video_coding_fkey',               'video_coding_id',               'transmission_video_codings'],
    ['lpt_audio_config_fkey',               'audio_config_id',               'transmission_audio_configs'],
    ['lpt_iso_feed_fkey',                   'iso_feed_id',                   'transmission_iso_feed_options'],
    ['lpt_key_type_fkey',                   'key_type_id',                   'transmission_key_types'],
    ['lpt_fec_rate_fkey',                   'fec_rate_id',                   'transmission_fec_rates'],
    ['lpt_backup_feed_type_fkey',           'backup_feed_type_id',           'transmission_feed_types'],
    ['lpt_backup_satellite_fkey',           'backup_satellite_id',           'transmission_satellites'],
    ['lpt_backup_uplink_polarization_fkey', 'backup_uplink_polarization_id', 'transmission_polarizations'],
    ['lpt_backup_downlink_polarization_fkey','backup_downlink_polarization_id','transmission_polarizations'],
    ['lpt_backup_modulation_type_fkey',     'backup_modulation_type_id',     'transmission_modulation_types'],
    ['lpt_backup_roll_off_fkey',            'backup_roll_off_id',            'transmission_roll_offs'],
    ['lpt_backup_video_coding_fkey',        'backup_video_coding_id',        'transmission_video_codings'],
    ['lpt_backup_audio_config_fkey',        'backup_audio_config_id',        'transmission_audio_configs'],
    ['lpt_backup_key_type_fkey',            'backup_key_type_id',            'transmission_key_types'],
    ['lpt_backup_fec_rate_fkey',            'backup_fec_rate_id',            'transmission_fec_rates'],
    ['lpt_fiber_company_fkey',              'fiber_company_id',              'technical_companies'],
    ['lpt_fiber_audio_format_fkey',         'fiber_audio_format_id',         'fiber_audio_formats'],
    ['lpt_fiber_video_format_fkey',         'fiber_video_format_id',         'fiber_video_formats'],
  ];

  for (const [name, col, ref] of lookupFks) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "live_plan_technical_details"
      DROP CONSTRAINT IF EXISTS "${name}"
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "live_plan_technical_details"
      ADD CONSTRAINT "${name}"
      FOREIGN KEY ("${col}") REFERENCES "${ref}"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
    `);
  }

  // Parent FK CASCADE — db push @relation tarafından oluşturulur (Prisma model'inde
  // tanımlı), bu nedenle reapply etmiyoruz. CHECK constraint ise db push'ta yok.
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "live_plan_technical_details"
    DROP CONSTRAINT IF EXISTS "live_plan_technical_details_planned_window_check"
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "live_plan_technical_details"
    ADD CONSTRAINT "live_plan_technical_details_planned_window_check"
    CHECK (
      "planned_start_time" IS NULL
      OR "planned_end_time" IS NULL
      OR "planned_end_time" > "planned_start_time"
    )
  `);
}

/**
 * Madde 5 M5-B8 interim helper (2026-05-07):
 * `live_plan_transmission_segments` üzerindeki 3 CHECK constraint'i (feed_role IN,
 * kind IN, end_time > start_time) test DB'sinde reapply eder. Parent FK ve
 * @@index Prisma `@relation` + `@@index` ile schema'da tanımlı; db push üretir.
 *
 * Idempotent: DROP IF EXISTS + ADD.
 *
 * Madde 1 (migration baseline) sonrası kaldırılır.
 */
export async function applyLivePlanTransmissionSegmentsConstraints(): Promise<void> {
  const prisma = getRawPrisma();

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "live_plan_transmission_segments"
    DROP CONSTRAINT IF EXISTS "live_plan_transmission_segments_feed_role_check"
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "live_plan_transmission_segments"
    ADD CONSTRAINT "live_plan_transmission_segments_feed_role_check"
    CHECK ("feed_role" IN ('MAIN','BACKUP','FIBER','OTHER'))
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "live_plan_transmission_segments"
    DROP CONSTRAINT IF EXISTS "live_plan_transmission_segments_kind_check"
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "live_plan_transmission_segments"
    ADD CONSTRAINT "live_plan_transmission_segments_kind_check"
    CHECK ("kind" IN ('TEST','PROGRAM','HIGHLIGHTS','INTERVIEW','OTHER'))
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "live_plan_transmission_segments"
    DROP CONSTRAINT IF EXISTS "live_plan_transmission_segments_window_check"
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "live_plan_transmission_segments"
    ADD CONSTRAINT "live_plan_transmission_segments_window_check"
    CHECK ("end_time" > "start_time")
  `);
}

/**
 * SCHED-B2 interim helper (2026-05-07): Schedule/Yayın Planlama broadcast
 * flow + live_plan_entries event_key/source_type/channel slot CHECK + 3
 * schedule lookup tablosunun CHECK + partial unique reapply.
 *
 * `prisma db push --force-reset` partial unique + CHECK + functional index
 * desteği sınırlı; migration SQL'deki constraint setini test ortamına
 * idempotent uygular.
 *
 * Idempotent: DROP IF EXISTS + ADD.
 */
export async function applyScheduleBroadcastFlowConstraints(): Promise<void> {
  const prisma = getRawPrisma();

  // schedules: 3 channel slot duplicate yasak
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "schedules"
    DROP CONSTRAINT IF EXISTS "schedules_channel_slots_distinct"
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "schedules"
    ADD CONSTRAINT "schedules_channel_slots_distinct" CHECK (
      (channel_1_id IS NULL OR channel_2_id IS NULL OR channel_1_id <> channel_2_id) AND
      (channel_1_id IS NULL OR channel_3_id IS NULL OR channel_1_id <> channel_3_id) AND
      (channel_2_id IS NULL OR channel_3_id IS NULL OR channel_2_id <> channel_3_id)
    )
  `);

  // live_plan_entries: source_type CHECK + 3 channel slot duplicate yasak
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "live_plan_entries"
    DROP CONSTRAINT IF EXISTS "live_plan_entries_source_type_check"
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "live_plan_entries"
    ADD CONSTRAINT "live_plan_entries_source_type_check"
    CHECK ("source_type" IN ('OPTA','MANUAL'))
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "live_plan_entries"
    DROP CONSTRAINT IF EXISTS "live_plan_entries_channel_slots_distinct"
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "live_plan_entries"
    ADD CONSTRAINT "live_plan_entries_channel_slots_distinct" CHECK (
      (channel_1_id IS NULL OR channel_2_id IS NULL OR channel_1_id <> channel_2_id) AND
      (channel_1_id IS NULL OR channel_3_id IS NULL OR channel_1_id <> channel_3_id) AND
      (channel_2_id IS NULL OR channel_3_id IS NULL OR channel_2_id <> channel_3_id)
    )
  `);

  // 3 schedule lookup tablo: label CHECK + partial unique LOWER(label)
  for (const tbl of [
    'schedule_commercial_options',
    'schedule_logo_options',
    'schedule_format_options',
  ]) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${tbl}"
      DROP CONSTRAINT IF EXISTS "${tbl}_label_not_blank"
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${tbl}"
      ADD CONSTRAINT "${tbl}_label_not_blank"
      CHECK (length(trim("label")) > 0)
    `);
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${tbl}_label_uniq"`);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX "${tbl}_label_uniq"
      ON "${tbl}"(LOWER("label"))
      WHERE "deleted_at" IS NULL
    `);
  }

  // 10 yeni FK: Prisma schema'da scalar-only kolonlar; @relation
  // tanımlanmadığı için db push bu FK'leri oluşturmaz. Migration SQL'deki
  // constraint setini reapply (idempotent DROP IF EXISTS + ADD).
  type FkSpec = readonly [name: string, table: string, column: string, refTable: string, refCol: string, onDelete: 'SET NULL' | 'RESTRICT' | 'CASCADE'];
  const fks: readonly FkSpec[] = [
    // schedules → channels (3 slot)
    ['schedules_channel_1_id_fkey', 'schedules', 'channel_1_id', 'channels', 'id', 'SET NULL'],
    ['schedules_channel_2_id_fkey', 'schedules', 'channel_2_id', 'channels', 'id', 'SET NULL'],
    ['schedules_channel_3_id_fkey', 'schedules', 'channel_3_id', 'channels', 'id', 'SET NULL'],
    // schedules → live_plan_entries
    ['schedules_selected_live_plan_entry_id_fkey', 'schedules', 'selected_live_plan_entry_id', 'live_plan_entries', 'id', 'SET NULL'],
    // schedules → 3 schedule lookup (RESTRICT)
    ['schedules_commercial_option_id_fkey', 'schedules', 'commercial_option_id', 'schedule_commercial_options', 'id', 'RESTRICT'],
    ['schedules_logo_option_id_fkey',       'schedules', 'logo_option_id',       'schedule_logo_options',       'id', 'RESTRICT'],
    ['schedules_format_option_id_fkey',     'schedules', 'format_option_id',     'schedule_format_options',     'id', 'RESTRICT'],
    // live_plan_entries → channels (3 slot)
    ['live_plan_entries_channel_1_id_fkey', 'live_plan_entries', 'channel_1_id', 'channels', 'id', 'SET NULL'],
    ['live_plan_entries_channel_2_id_fkey', 'live_plan_entries', 'channel_2_id', 'channels', 'id', 'SET NULL'],
    ['live_plan_entries_channel_3_id_fkey', 'live_plan_entries', 'channel_3_id', 'channels', 'id', 'SET NULL'],
  ];

  for (const [name, tbl, col, refTbl, refCol, onDel] of fks) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${tbl}" DROP CONSTRAINT IF EXISTS "${name}"
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${tbl}"
      ADD CONSTRAINT "${name}"
      FOREIGN KEY ("${col}") REFERENCES "${refTbl}"("${refCol}")
      ON DELETE ${onDel} ON UPDATE CASCADE
    `);
  }

  // schedules.event_key UNIQUE — Prisma @unique attribute db push ile gelir
  // ama defensive olarak reapply (test isolation için garanti).
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "schedules_event_key_uniq"`);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX "schedules_event_key_uniq" ON "schedules"("event_key")
  `);

  // live_plan_entries.event_key partial index
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "live_plan_entries_event_key_idx"`);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX "live_plan_entries_event_key_idx"
    ON "live_plan_entries"("event_key")
    WHERE "event_key" IS NOT NULL
  `);
}

/**
 * Phase A5 interim helper (2026-05-10):
 * `ingest_plan_items.source_type` CHECK constraint manuel reapply. Migration
 * `20260510000001_ingest_plan_item_source_type_check` production'da uygulanır;
 * test DB `prisma db push --force-reset` ile sync edildiği için CHECK
 * constraint tüketilmez.
 *
 * Idempotent: DROP IF EXISTS + ADD.
 *
 * Madde 1 (migration baseline) sonrası kaldırılır.
 */
export async function applyIngestPlanItemSourceTypeConstraint(): Promise<void> {
  const prisma = getRawPrisma();
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "ingest_plan_items"
    DROP CONSTRAINT IF EXISTS "ingest_plan_items_source_type_check"
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "ingest_plan_items"
    ADD CONSTRAINT "ingest_plan_items_source_type_check"
    CHECK ("source_type" IN ('live-plan', 'studio-plan', 'ingest-plan', 'manual'))
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
  startTime?: Date;
  endTime?: Date;
  title?: string;
  status?: 'DRAFT' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
}): Promise<{ id: number }> {
  const prisma = getRawPrisma();
  const now = new Date();
  const start = opts?.startTime ?? new Date(now.getTime() + 60 * 60 * 1000); // +1h
  const end = opts?.endTime ?? new Date(start.getTime() + 90 * 60 * 1000);    // +1.5h
  const created = await prisma.schedule.create({
    data: {
      // SCHED-B5a (Y5-2a): usageScope kaldırıldı (DB default 'broadcast').
      // Y5-8 (2026-05-11): legacy channelId field kaldırıldı (FK + relation DROP).
      startTime: start,
      endTime: end,
      title: opts?.title ?? 'Integration test schedule',
      status: opts?.status ?? 'CONFIRMED',
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
