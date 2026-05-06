-- Madde 5 M5-B4 (audit doc): live-plan lookup tabloları foundation + seed.
--
-- Tasarım: ops/REQUIREMENTS-LIVE-PLAN-TECHNICAL-FIELDS-V1.md §3 (25 lookup tablo)
-- + ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md §3.4 K15.6-K15.9.
--
-- Locked decisions (K15.6-K15.9, 2026-05-06):
--   K15.6: Standart kolon set (id/label/active/sort_order/timestamps/deleted_at);
--          type sütunu sadece polymorphic ayrım gereken tablolarda.
--   K15.7: Case-insensitive partial unique index (WHERE deleted_at IS NULL);
--          type'lı tablolarda (type, LOWER(label)); type'sızlarda LOWER(label).
--   K15.8: Deterministic seed migration SQL içinde; ON CONFLICT DO NOTHING;
--          frontend label formatı birebir korunur (ör. "IRD - 1" değişmez).
--   K15.9: RBAC namespace livePlanLookups; read all-auth, write/delete SystemEng.
--
-- Ek kural 1: CHECK (length(trim(label)) > 0) — boş whitespace label engeli.
-- Ek kural 2: Seed label formatı mevcut frontend ile birebir.
-- Ek kural 3: RBAC empty array = all authenticated (mevcut convention; rbac.ts:67-77).
--
-- M5-B4 KAPSAM:
--   - 25 lookup tablo
--   - Partial unique indexler
--   - Seed (~217 satır; 12 tablo boş başlar — operatör M5-B6 admin UI'sından doldurur)
--   - live_plan_entries.metadata kolon DROP (K15.1 disiplin)
--
-- M5-B4 KAPSAM DIŞI: lookup management API/UI (M5-B5/B6), technical_details schema
-- (M5-B7), transmission_segments schema (M5-B8), service/route (M5-B9).

-- ═════════════════════════════════════════════════════════════════════════════
-- §1. Lookup tabloları (25 adet)
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1. transmission_satellites ────────────────────────────────────────────
CREATE TABLE "transmission_satellites" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_satellites_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_satellites_label_uniq"
    ON "transmission_satellites"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 2. transmission_irds ──────────────────────────────────────────────────
CREATE TABLE "transmission_irds" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_irds_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_irds_label_uniq"
    ON "transmission_irds"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 3. transmission_fibers ────────────────────────────────────────────────
CREATE TABLE "transmission_fibers" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_fibers_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_fibers_label_uniq"
    ON "transmission_fibers"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 4. transmission_int_resources ─────────────────────────────────────────
CREATE TABLE "transmission_int_resources" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_int_resources_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_int_resources_label_uniq"
    ON "transmission_int_resources"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 5. transmission_tie_options ───────────────────────────────────────────
CREATE TABLE "transmission_tie_options" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_tie_options_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_tie_options_label_uniq"
    ON "transmission_tie_options"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 6. transmission_demod_options ─────────────────────────────────────────
CREATE TABLE "transmission_demod_options" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_demod_options_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_demod_options_label_uniq"
    ON "transmission_demod_options"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 7. transmission_virtual_resources ─────────────────────────────────────
CREATE TABLE "transmission_virtual_resources" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_virtual_resources_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_virtual_resources_label_uniq"
    ON "transmission_virtual_resources"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 8. transmission_feed_types ────────────────────────────────────────────
CREATE TABLE "transmission_feed_types" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_feed_types_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_feed_types_label_uniq"
    ON "transmission_feed_types"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 9. transmission_modulation_types ──────────────────────────────────────
CREATE TABLE "transmission_modulation_types" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_modulation_types_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_modulation_types_label_uniq"
    ON "transmission_modulation_types"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 10. transmission_video_codings ────────────────────────────────────────
CREATE TABLE "transmission_video_codings" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_video_codings_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_video_codings_label_uniq"
    ON "transmission_video_codings"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 11. transmission_audio_configs (boş seed) ─────────────────────────────
CREATE TABLE "transmission_audio_configs" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_audio_configs_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_audio_configs_label_uniq"
    ON "transmission_audio_configs"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 12. transmission_key_types ────────────────────────────────────────────
CREATE TABLE "transmission_key_types" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_key_types_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_key_types_label_uniq"
    ON "transmission_key_types"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 13. transmission_polarizations ────────────────────────────────────────
CREATE TABLE "transmission_polarizations" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_polarizations_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_polarizations_label_uniq"
    ON "transmission_polarizations"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 14. transmission_fec_rates (boş seed) ─────────────────────────────────
CREATE TABLE "transmission_fec_rates" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_fec_rates_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_fec_rates_label_uniq"
    ON "transmission_fec_rates"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 15. transmission_roll_offs ────────────────────────────────────────────
CREATE TABLE "transmission_roll_offs" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_roll_offs_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_roll_offs_label_uniq"
    ON "transmission_roll_offs"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 16. transmission_iso_feed_options (boş seed) ──────────────────────────
CREATE TABLE "transmission_iso_feed_options" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "transmission_iso_feed_options_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "transmission_iso_feed_options_label_uniq"
    ON "transmission_iso_feed_options"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 17. technical_companies (type'lı; OB_VAN/GENERATOR/SNG/CARRIER/FIBER) ─
CREATE TABLE "technical_companies" (
    "id"         SERIAL PRIMARY KEY,
    "type"       VARCHAR(30) NOT NULL,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "technical_companies_label_not_blank" CHECK (length(trim("label")) > 0),
    CONSTRAINT "technical_companies_type_check"
      CHECK ("type" IN ('OB_VAN', 'GENERATOR', 'SNG', 'CARRIER', 'FIBER'))
);
CREATE UNIQUE INDEX "technical_companies_type_label_uniq"
    ON "technical_companies"("type", LOWER("label"))
    WHERE "deleted_at" IS NULL;
CREATE INDEX "technical_companies_type_idx"
    ON "technical_companies"("type") WHERE "deleted_at" IS NULL;

-- ── 18. live_plan_equipment_options (type'lı; JIMMY_JIB/STEADICAM/IBM) ────
CREATE TABLE "live_plan_equipment_options" (
    "id"         SERIAL PRIMARY KEY,
    "type"       VARCHAR(30) NOT NULL,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "live_plan_equipment_options_label_not_blank" CHECK (length(trim("label")) > 0),
    CONSTRAINT "live_plan_equipment_options_type_check"
      CHECK ("type" IN ('JIMMY_JIB', 'STEADICAM', 'IBM'))
);
CREATE UNIQUE INDEX "live_plan_equipment_options_type_label_uniq"
    ON "live_plan_equipment_options"("type", LOWER("label"))
    WHERE "deleted_at" IS NULL;
CREATE INDEX "live_plan_equipment_options_type_idx"
    ON "live_plan_equipment_options"("type") WHERE "deleted_at" IS NULL;

-- ── 19. live_plan_locations ───────────────────────────────────────────────
CREATE TABLE "live_plan_locations" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "live_plan_locations_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "live_plan_locations_label_uniq"
    ON "live_plan_locations"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 20. live_plan_usage_locations ─────────────────────────────────────────
CREATE TABLE "live_plan_usage_locations" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "live_plan_usage_locations_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "live_plan_usage_locations_label_uniq"
    ON "live_plan_usage_locations"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 21. live_plan_regions ─────────────────────────────────────────────────
CREATE TABLE "live_plan_regions" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "live_plan_regions_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "live_plan_regions_label_uniq"
    ON "live_plan_regions"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 22. live_plan_languages ───────────────────────────────────────────────
CREATE TABLE "live_plan_languages" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "live_plan_languages_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "live_plan_languages_label_uniq"
    ON "live_plan_languages"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 23. live_plan_off_tube_options (boş seed) ────────────────────────────
CREATE TABLE "live_plan_off_tube_options" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "live_plan_off_tube_options_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "live_plan_off_tube_options_label_uniq"
    ON "live_plan_off_tube_options"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 24. fiber_audio_formats (X1; boş seed) ────────────────────────────────
CREATE TABLE "fiber_audio_formats" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "fiber_audio_formats_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "fiber_audio_formats_label_uniq"
    ON "fiber_audio_formats"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ── 25. fiber_video_formats (X1; boş seed) ────────────────────────────────
CREATE TABLE "fiber_video_formats" (
    "id"         SERIAL PRIMARY KEY,
    "label"      VARCHAR(200) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "fiber_video_formats_label_not_blank" CHECK (length(trim("label")) > 0)
);
CREATE UNIQUE INDEX "fiber_video_formats_label_uniq"
    ON "fiber_video_formats"(LOWER("label"))
    WHERE "deleted_at" IS NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- §2. Seed (deterministic; ON CONFLICT DO NOTHING; frontend label formatı birebir)
-- ═════════════════════════════════════════════════════════════════════════════

-- ── transmission_irds: RESOURCE_OPTIONS IRD subset (56 değer; "IRD - 1" formatı) ─
INSERT INTO "transmission_irds" ("label", "sort_order")
SELECT 'IRD - ' || i::text, i
FROM generate_series(1, 56) AS i
ON CONFLICT DO NOTHING;

-- ── transmission_fibers: RESOURCE_OPTIONS FIBER subset + GBS/DOHA/4G/TVU/YILDIZ (30 değer) ─
INSERT INTO "transmission_fibers" ("label", "sort_order") VALUES
  ('FIBER - 1', 1), ('FIBER - 2', 2), ('FIBER - 3', 3), ('FIBER - 4', 4),
  ('FIBER - 5', 5), ('FIBER - 6', 6), ('FIBER - 7', 7), ('FIBER - 8', 8),
  ('FIBER - 9', 9), ('FIBER - 10', 10), ('FIBER - 11', 11), ('FIBER - 12', 12),
  ('FIBER - 13', 13), ('FIBER - 14', 14), ('FIBER - 15', 15), ('FIBER - 16', 16),
  ('GBS - 53', 17), ('GBS - 54', 18), ('GBS - 55', 19), ('GBS - 56', 20),
  ('DOHA - 1', 21), ('DOHA - 2', 22),
  ('4G - 1', 23), ('4G - 2', 24), ('4G - 3', 25), ('4G - 4', 26),
  ('TVU - 1', 27), ('TVU - 2', 28), ('TVU - 3', 29), ('TVU - 4', 30),
  ('YILDIZ - 1', 31), ('YILDIZ - 2', 32), ('YILDIZ - 3', 33), ('YILDIZ - 4', 34)
ON CONFLICT DO NOTHING;

-- ── transmission_int_resources: INT_OPTIONS (46 değer) ────────────────────
INSERT INTO "transmission_int_resources" ("label", "sort_order") VALUES
  ('1', 1), ('2', 2), ('3', 3), ('4', 4), ('5', 5), ('6', 6),
  ('7', 7), ('8', 8), ('9', 9), ('10', 10), ('11', 11), ('12', 12),
  ('AGENT - 1', 13), ('AGENT - 2', 14), ('AGENT - 3', 15), ('AGENT - 4', 16), ('AGENT - 5', 17),
  ('AGENT - 6', 18), ('AGENT - 7', 19), ('AGENT - 8', 20), ('AGENT - 9', 21), ('AGENT - 10', 22),
  ('HYRID - 1', 23), ('HYRID - 2', 24),
  ('IP - 1', 25), ('IP - 2', 26), ('IP - 3', 27), ('IP - 4', 28),
  ('IP - 5', 29), ('IP - 6', 30), ('IP - 7', 31), ('IP - 8', 32),
  ('IP - 9', 33), ('IP - 10', 34), ('IP - 11', 35), ('IP - 12', 36),
  ('IP - 13', 37), ('IP - 14', 38), ('IP - 15', 39), ('IP - 16', 40),
  ('ISDN - 1', 41), ('ISDN - 2', 42), ('ISDN - 3', 43), ('ISDN - 4', 44), ('ISDN - 5', 45),
  ('TEKYON - 3', 46)
ON CONFLICT DO NOTHING;

-- ── transmission_tie_options: TIE_OPTIONS (19 değer) ──────────────────────
INSERT INTO "transmission_tie_options" ("label", "sort_order") VALUES
  ('1', 1), ('2', 2), ('3', 3), ('4', 4), ('5', 5), ('6', 6),
  ('IRD 48', 7), ('IRD49 RBT1', 8), ('IRD50 RBT2', 9),
  ('PLT SPR5', 10), ('PLT SPR6', 11), ('PLT SPR7', 12), ('PLT SPR8', 13),
  ('STREAM1 PC', 14), ('STREAM2 PC', 15),
  ('TRX SPR14', 16), ('TRX SPR15', 17), ('TRX SPR16', 18), ('TRX SPR17', 19), ('TRX SPR18', 20)
ON CONFLICT DO NOTHING;

-- ── transmission_demod_options: DEMOD_OPTIONS (D1..D9) ───────────────────
INSERT INTO "transmission_demod_options" ("label", "sort_order") VALUES
  ('D1', 1), ('D2', 2), ('D3', 3), ('D4', 4), ('D5', 5),
  ('D6', 6), ('D7', 7), ('D8', 8), ('D9', 9)
ON CONFLICT DO NOTHING;

-- ── transmission_virtual_resources: SANAL_OPTIONS ('1', '2') ─────────────
INSERT INTO "transmission_virtual_resources" ("label", "sort_order") VALUES
  ('1', 1), ('2', 2)
ON CONFLICT DO NOTHING;

-- ── transmission_feed_types (18 değer; UI hardcoded) ─────────────────────
INSERT INTO "transmission_feed_types" ("label", "sort_order") VALUES
  ('4,5G', 1), ('DVB S', 2), ('DVB S2', 3), ('DVB S2 - 8PSK', 4),
  ('DVB S2 QPSK', 5), ('DVBS2 + NS3', 6), ('DVBS-2 + NS4', 7), ('DVB-S2X', 8),
  ('FTP', 9), ('IP Stream', 10), ('NS3', 11), ('NS3 + NS4', 12),
  ('NS4', 13), ('NS4 + NS4', 14), ('Quicklink', 15), ('Skype', 16),
  ('Youtube', 17), ('Zoom', 18)
ON CONFLICT DO NOTHING;

-- ── transmission_modulation_types (18 değer; feed_types ile aynı kümede ayrı tablo) ─
INSERT INTO "transmission_modulation_types" ("label", "sort_order") VALUES
  ('4,5G', 1), ('DVB S', 2), ('DVB S2', 3), ('DVB S2 - 8PSK', 4),
  ('DVB S2 QPSK', 5), ('DVBS2 + NS3', 6), ('DVBS-2 + NS4', 7), ('DVB-S2X', 8),
  ('FTP', 9), ('IP Stream', 10), ('NS3', 11), ('NS3 + NS4', 12),
  ('NS4', 13), ('NS4 + NS4', 14), ('Quicklink', 15), ('Skype', 16),
  ('Youtube', 17), ('Zoom', 18)
ON CONFLICT DO NOTHING;

-- ── transmission_video_codings (5 değer) ──────────────────────────────────
INSERT INTO "transmission_video_codings" ("label", "sort_order") VALUES
  ('H265 4:2:2', 1), ('Mpeg 4:2:0', 2), ('Mpeg 4:2:2', 3),
  ('Mpeg 4:2:2-10 bit', 4), ('Mpeg 4:2:2-8', 5)
ON CONFLICT DO NOTHING;

-- ── transmission_key_types (4 değer; BISS/Director/Unencrypted) ──────────
INSERT INTO "transmission_key_types" ("label", "sort_order") VALUES
  ('BISS Mode-1', 1), ('BISS Mode-E', 2), ('Director', 3), ('Unencrypted', 4)
ON CONFLICT DO NOTHING;

-- ── transmission_polarizations (H/V/R/L) ──────────────────────────────────
INSERT INTO "transmission_polarizations" ("label", "sort_order") VALUES
  ('H', 1), ('V', 2), ('R', 3), ('L', 4)
ON CONFLICT DO NOTHING;

-- ── transmission_roll_offs (% 20 / % 25 / % 35) ───────────────────────────
INSERT INTO "transmission_roll_offs" ("label", "sort_order") VALUES
  ('% 20', 1), ('% 25', 2), ('% 35', 3)
ON CONFLICT DO NOTHING;

-- ── live_plan_languages (default seed: Yok, Türkçe, İngilizce) ───────────
INSERT INTO "live_plan_languages" ("label", "sort_order") VALUES
  ('Yok', 1), ('Türkçe', 2), ('İngilizce', 3)
ON CONFLICT DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════════
-- Boş başlayan 12 tablo (M5-B6 lookup management UI'sından doldurulur):
-- transmission_satellites, transmission_audio_configs, transmission_fec_rates,
-- transmission_iso_feed_options, technical_companies, live_plan_equipment_options,
-- live_plan_locations, live_plan_usage_locations, live_plan_regions,
-- live_plan_off_tube_options, fiber_audio_formats, fiber_video_formats.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- §3. live_plan_entries.metadata kolon DROP (K15.1 disiplin)
-- ═════════════════════════════════════════════════════════════════════════════
-- M5-B1'de eklenmişti; K15.1 ile artık kullanılmaz. Yeni geliştirmelerde
-- yanlış kullanım engellenir. M5-B2 service/route/test'te metadata kullanımı
-- bu PR'da kod tarafında zaten temizleniyor (kod önce, migration sonra sırası).

ALTER TABLE "live_plan_entries" DROP COLUMN "metadata";
