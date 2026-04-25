-- btree_gist: varchar/date alanlarını gist exclusion constraint'inde kullanabilmek için gerekli
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Aynı port + gün + kesişen zaman aralığına ikinci kayıt girilmesini veritabanı seviyesinde engelle.
-- WHERE ile sadece port ve dakikalar dolu olan satırlar kapsama alınır (NULL'lar çakışma oluşturmaz).
ALTER TABLE ingest_plan_items
  ADD CONSTRAINT no_port_time_overlap
  EXCLUDE USING gist (
    recording_port  WITH =,
    day_date        WITH =,
    int4range(planned_start_minute, planned_end_minute, '[)') WITH &&
  )
  WHERE (recording_port IS NOT NULL
     AND planned_start_minute IS NOT NULL
     AND planned_end_minute   IS NOT NULL);
