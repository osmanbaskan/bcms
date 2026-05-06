-- Madde 5 M5-B7 (decision §5 + scope lock S1-S12, 2026-05-07):
-- live_plan_technical_details — 1:1 ile live_plan_entries; ~73 domain alanı
-- (14 ana operasyon + 10 ortak + 5 IRD/Fiber + 21 ana feed + 19 backup + 4 fiber)
-- + 5 sistem kolonu + deleted_at = ~79 kolon.
--
-- FK politikası (S4/S5):
--   - live_plan_entry_id: UNIQUE NOT NULL FK → live_plan_entries(id), ON DELETE CASCADE
--   - 25 lookup FK: ON DELETE RESTRICT (lookup soft-delete kullanır; defensive)
--
-- CHECK (S9): planned_end_time > planned_start_time (ikisi de NOT NULL olduğunda).
--
-- Lookup active/deleted validation S10 (M5-B9 service-level) — bu schema'da
-- enforce edilmez; FK sadece referential integrity sağlar.

CREATE TABLE "live_plan_technical_details" (
  "id"                            SERIAL PRIMARY KEY,
  "live_plan_entry_id"            INTEGER     NOT NULL,
  "version"                       INTEGER     NOT NULL DEFAULT 1,
  "created_at"                    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"                    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "deleted_at"                    TIMESTAMPTZ(6),

  -- §5.1 Yayın/OB grubu (14)
  "broadcast_location_id"         INTEGER,
  "ob_van_company_id"             INTEGER,
  "generator_company_id"          INTEGER,
  "jimmy_jib_id"                  INTEGER,
  "steadicam_id"                  INTEGER,
  "sng_company_id"                INTEGER,
  "carrier_company_id"            INTEGER,
  "ibm_id"                        INTEGER,
  "usage_location_id"             INTEGER,
  "fixed_phone_1"                 VARCHAR(80),
  "second_ob_van_id"              INTEGER,
  "region_id"                     INTEGER,
  "camera_count"                  INTEGER,
  "fixed_phone_2"                 VARCHAR(80),

  -- §5.2 Ortak (10)
  "planned_start_time"            TIMESTAMPTZ(6),
  "planned_end_time"              TIMESTAMPTZ(6),
  "hdvg_resource_id"              INTEGER,
  "int1_resource_id"              INTEGER,
  "int2_resource_id"              INTEGER,
  "off_tube_id"                   INTEGER,
  "language_id"                   INTEGER,
  "demod_id"                      INTEGER,
  "tie_id"                        INTEGER,
  "virtual_resource_id"           INTEGER,

  -- §5.3 IRD/Fiber (5)
  "ird1_id"                       INTEGER,
  "ird2_id"                       INTEGER,
  "ird3_id"                       INTEGER,
  "fiber1_id"                     INTEGER,
  "fiber2_id"                     INTEGER,

  -- §5.4 Ana Feed (21)
  "feed_type_id"                  INTEGER,
  "satellite_id"                  INTEGER,
  "txp"                           VARCHAR(120),
  "sat_channel"                   VARCHAR(120),
  "uplink_frequency"              VARCHAR(120),
  "uplink_polarization_id"        INTEGER,
  "downlink_frequency"            VARCHAR(120),
  "downlink_polarization_id"      INTEGER,
  "modulation_type_id"            INTEGER,
  "roll_off_id"                   INTEGER,
  "video_coding_id"               INTEGER,
  "audio_config_id"               INTEGER,
  "pre_match_key"                 VARCHAR(200),
  "match_key"                     VARCHAR(200),
  "post_match_key"                VARCHAR(200),
  "iso_feed_id"                   INTEGER,
  "key_type_id"                   INTEGER,
  "symbol_rate"                   VARCHAR(80),
  "fec_rate_id"                   INTEGER,
  "bandwidth"                     VARCHAR(80),
  "uplink_fixed_phone"            VARCHAR(80),

  -- §5.5 Yedek Feed (19, backup_* prefix)
  "backup_feed_type_id"           INTEGER,
  "backup_satellite_id"           INTEGER,
  "backup_txp"                    VARCHAR(120),
  "backup_sat_channel"            VARCHAR(120),
  "backup_uplink_frequency"       VARCHAR(120),
  "backup_uplink_polarization_id" INTEGER,
  "backup_downlink_frequency"     VARCHAR(120),
  "backup_downlink_polarization_id" INTEGER,
  "backup_modulation_type_id"     INTEGER,
  "backup_roll_off_id"            INTEGER,
  "backup_video_coding_id"        INTEGER,
  "backup_audio_config_id"        INTEGER,
  "backup_pre_match_key"          VARCHAR(200),
  "backup_match_key"              VARCHAR(200),
  "backup_post_match_key"         VARCHAR(200),
  "backup_key_type_id"            INTEGER,
  "backup_symbol_rate"            VARCHAR(80),
  "backup_fec_rate_id"            INTEGER,
  "backup_bandwidth"              VARCHAR(80),

  -- §5.6 Fiber (4, fiber_* prefix)
  "fiber_company_id"              INTEGER,
  "fiber_audio_format_id"         INTEGER,
  "fiber_video_format_id"         INTEGER,
  "fiber_bandwidth"               VARCHAR(80)
);

-- 1:1 enforce (S2): live_plan_entry_id UNIQUE.
CREATE UNIQUE INDEX "live_plan_technical_details_entry_unique"
  ON "live_plan_technical_details" ("live_plan_entry_id");

-- Parent FK CASCADE (S4)
ALTER TABLE "live_plan_technical_details"
  ADD CONSTRAINT "live_plan_technical_details_entry_fkey"
  FOREIGN KEY ("live_plan_entry_id") REFERENCES "live_plan_entries"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 25 lookup FK RESTRICT (S5)
ALTER TABLE "live_plan_technical_details"
  ADD CONSTRAINT "lpt_broadcast_location_fkey"
    FOREIGN KEY ("broadcast_location_id") REFERENCES "live_plan_locations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_ob_van_company_fkey"
    FOREIGN KEY ("ob_van_company_id") REFERENCES "technical_companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_generator_company_fkey"
    FOREIGN KEY ("generator_company_id") REFERENCES "technical_companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_jimmy_jib_fkey"
    FOREIGN KEY ("jimmy_jib_id") REFERENCES "live_plan_equipment_options"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_steadicam_fkey"
    FOREIGN KEY ("steadicam_id") REFERENCES "live_plan_equipment_options"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_sng_company_fkey"
    FOREIGN KEY ("sng_company_id") REFERENCES "technical_companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_carrier_company_fkey"
    FOREIGN KEY ("carrier_company_id") REFERENCES "technical_companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_ibm_fkey"
    FOREIGN KEY ("ibm_id") REFERENCES "live_plan_equipment_options"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_usage_location_fkey"
    FOREIGN KEY ("usage_location_id") REFERENCES "live_plan_usage_locations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_second_ob_van_fkey"
    FOREIGN KEY ("second_ob_van_id") REFERENCES "technical_companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_region_fkey"
    FOREIGN KEY ("region_id") REFERENCES "live_plan_regions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_hdvg_resource_fkey"
    FOREIGN KEY ("hdvg_resource_id") REFERENCES "transmission_int_resources"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_int1_resource_fkey"
    FOREIGN KEY ("int1_resource_id") REFERENCES "transmission_int_resources"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_int2_resource_fkey"
    FOREIGN KEY ("int2_resource_id") REFERENCES "transmission_int_resources"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_off_tube_fkey"
    FOREIGN KEY ("off_tube_id") REFERENCES "live_plan_off_tube_options"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_language_fkey"
    FOREIGN KEY ("language_id") REFERENCES "live_plan_languages"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_demod_fkey"
    FOREIGN KEY ("demod_id") REFERENCES "transmission_demod_options"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_tie_fkey"
    FOREIGN KEY ("tie_id") REFERENCES "transmission_tie_options"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_virtual_resource_fkey"
    FOREIGN KEY ("virtual_resource_id") REFERENCES "transmission_virtual_resources"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_ird1_fkey"
    FOREIGN KEY ("ird1_id") REFERENCES "transmission_irds"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_ird2_fkey"
    FOREIGN KEY ("ird2_id") REFERENCES "transmission_irds"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_ird3_fkey"
    FOREIGN KEY ("ird3_id") REFERENCES "transmission_irds"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_fiber1_fkey"
    FOREIGN KEY ("fiber1_id") REFERENCES "transmission_fibers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_fiber2_fkey"
    FOREIGN KEY ("fiber2_id") REFERENCES "transmission_fibers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_feed_type_fkey"
    FOREIGN KEY ("feed_type_id") REFERENCES "transmission_feed_types"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_satellite_fkey"
    FOREIGN KEY ("satellite_id") REFERENCES "transmission_satellites"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_uplink_polarization_fkey"
    FOREIGN KEY ("uplink_polarization_id") REFERENCES "transmission_polarizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_downlink_polarization_fkey"
    FOREIGN KEY ("downlink_polarization_id") REFERENCES "transmission_polarizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_modulation_type_fkey"
    FOREIGN KEY ("modulation_type_id") REFERENCES "transmission_modulation_types"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_roll_off_fkey"
    FOREIGN KEY ("roll_off_id") REFERENCES "transmission_roll_offs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_video_coding_fkey"
    FOREIGN KEY ("video_coding_id") REFERENCES "transmission_video_codings"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_audio_config_fkey"
    FOREIGN KEY ("audio_config_id") REFERENCES "transmission_audio_configs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_iso_feed_fkey"
    FOREIGN KEY ("iso_feed_id") REFERENCES "transmission_iso_feed_options"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_key_type_fkey"
    FOREIGN KEY ("key_type_id") REFERENCES "transmission_key_types"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_fec_rate_fkey"
    FOREIGN KEY ("fec_rate_id") REFERENCES "transmission_fec_rates"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_backup_feed_type_fkey"
    FOREIGN KEY ("backup_feed_type_id") REFERENCES "transmission_feed_types"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_backup_satellite_fkey"
    FOREIGN KEY ("backup_satellite_id") REFERENCES "transmission_satellites"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_backup_uplink_polarization_fkey"
    FOREIGN KEY ("backup_uplink_polarization_id") REFERENCES "transmission_polarizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_backup_downlink_polarization_fkey"
    FOREIGN KEY ("backup_downlink_polarization_id") REFERENCES "transmission_polarizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_backup_modulation_type_fkey"
    FOREIGN KEY ("backup_modulation_type_id") REFERENCES "transmission_modulation_types"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_backup_roll_off_fkey"
    FOREIGN KEY ("backup_roll_off_id") REFERENCES "transmission_roll_offs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_backup_video_coding_fkey"
    FOREIGN KEY ("backup_video_coding_id") REFERENCES "transmission_video_codings"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_backup_audio_config_fkey"
    FOREIGN KEY ("backup_audio_config_id") REFERENCES "transmission_audio_configs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_backup_key_type_fkey"
    FOREIGN KEY ("backup_key_type_id") REFERENCES "transmission_key_types"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_backup_fec_rate_fkey"
    FOREIGN KEY ("backup_fec_rate_id") REFERENCES "transmission_fec_rates"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_fiber_company_fkey"
    FOREIGN KEY ("fiber_company_id") REFERENCES "technical_companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_fiber_audio_format_fkey"
    FOREIGN KEY ("fiber_audio_format_id") REFERENCES "fiber_audio_formats"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lpt_fiber_video_format_fkey"
    FOREIGN KEY ("fiber_video_format_id") REFERENCES "fiber_video_formats"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK end > start (S9): NULL kombinasyonları geçerli; ikisi de doluysa
-- end > start zorunlu.
ALTER TABLE "live_plan_technical_details"
  ADD CONSTRAINT "live_plan_technical_details_planned_window_check"
  CHECK (
    "planned_start_time" IS NULL
    OR "planned_end_time" IS NULL
    OR "planned_end_time" > "planned_start_time"
  );
