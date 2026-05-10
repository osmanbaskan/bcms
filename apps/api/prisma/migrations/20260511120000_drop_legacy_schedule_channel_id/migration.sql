-- Y5-8 legacy single-channel relation DROP (2026-05-11)
--
-- Scope:
--   - schedules.channel_id kolonu (legacy single-channel FK) DROP.
--   - schedules_channel_id_fkey FK constraint DROP.
--   - schedules_channel_id_start_time_end_time_idx index DROP.
--   - Prisma Schedule.channelId + Schedule.channel relation +
--     Channel.schedules back-relation +
--     @@index([channelId, startTime, endTime]) Prisma'dan kaldırıldı
--     (`apps/api/prisma/schema.prisma`).
--
-- Why:
--   - MCR/Playout sekmesi kaldırıldı (`0e10e62`, 2026-05-10). Schedule.channelId
--     üzerinde aktif business logic (go-live conflict, rundown ordering) yok.
--   - Canonical 3-channel slot modeli (`channel_1_id` / `channel_2_id` /
--     `channel_3_id`) yayın yapısını tek başına temsil eder.
--   - Reporting `schedule.channel?.name ?? '-'` graceful fallback ile çalışır;
--     UI freeze altında reporting B5b'ye kaldı (sözlü kanal gösterimi
--     pratikte zaten boştu, davranış değişmez).
--
-- Out of scope:
--   - schedules.metadata + start_time + end_time → B5b reporting canonical.
--   - channel_1/2/3 named relations → opsiyonel; ileride ihtiyaç olursa
--     ayrı migration ile eklenebilir.

-- ── 1. FK constraint DROP ───────────────────────────────────────────────
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_channel_id_fkey;

-- ── 2. Composite index DROP ─────────────────────────────────────────────
DROP INDEX IF EXISTS schedules_channel_id_start_time_end_time_idx;

-- ── 3. Kolon DROP ───────────────────────────────────────────────────────
ALTER TABLE schedules DROP COLUMN IF EXISTS channel_id;
