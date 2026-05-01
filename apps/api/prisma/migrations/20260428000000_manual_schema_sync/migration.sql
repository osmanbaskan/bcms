-- ============================================================
-- ✅  REPLAY-SAFE NO-OP (intentional)
-- ============================================================
-- DB'de applied_steps_count=0 — orijinal niyet zaten no-op idi.
-- Bu placeholder güvenli: yeni env'e replay'de hiçbir şey değişmez,
-- davranış orijinaliyle eşit (her ikisi de no-op).
-- ============================================================

-- Migration: manual schema sync (2026-04-28)
--
-- ⚠️ FS RECOVERY (2026-05-01 audit):
-- Bu migration DB'de uygulanmış ama `applied_steps_count = 0` — yani
-- yer-tutucu, hiç DDL adımı çalışmadı. Muhtemel senaryo: `prisma migrate
-- resolve --applied <name>` ile manuel olarak işaretlenmiş, gerçek bir
-- DDL hiç yoktu (Prisma'nın schema check'lerini geçici hizalamak için).
-- Checksum: 08e4ea2e...
--
-- Bu placeholder güvenli bir no-op. Yeni env'e replay yapılırsa hiçbir
-- şey değişmez — orijinal niyet zaten no-op idi.
-- Audit raporu: `BCMS_AUDIT_REPORT_2026-05-01.md` HIGH-001.

-- No-op (intentional)
SELECT 1;
