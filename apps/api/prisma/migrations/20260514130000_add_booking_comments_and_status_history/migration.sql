-- BookingComment + BookingStatusHistory (2026-05-14)
--
-- "İş Takip" sekmesi için iki yeni satellite tablo:
--   1. booking_comments — her iş için Jira-benzeri çoklu yorum (plain text).
--      V1 edit/delete yok; soft-delete kolonu V2 için ayrıldı.
--   2. booking_status_history — sınırsız durum geçmişi. Status PATCH ve
--      create sırasında otomatik yazılır; kullanıcı silmez. Audit yerine
--      geçmez — kullanıcıya görünen ürün datası.
--
-- Yetki: comment/status-history endpoint'leri mevcut Booking visibility
-- (`canSee`) kuralı ile çalışır; Admin universal, SystemEng özel değil.

CREATE TABLE "booking_comments" (
  "id"             SERIAL                       PRIMARY KEY,
  "booking_id"     INT                          NOT NULL,
  "author_user_id" VARCHAR(100)                 NOT NULL,
  "author_name"    VARCHAR(200),
  "body"           TEXT                         NOT NULL,
  "created_at"     TIMESTAMPTZ(6)               NOT NULL DEFAULT NOW(),
  "updated_at"     TIMESTAMPTZ(6)               NOT NULL DEFAULT NOW(),
  "deleted_at"     TIMESTAMPTZ(6),
  CONSTRAINT "booking_comments_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE
);

CREATE INDEX "booking_comments_booking_created_idx"
  ON "booking_comments" ("booking_id", "created_at");


CREATE TABLE "booking_status_history" (
  "id"                  SERIAL                  PRIMARY KEY,
  "booking_id"          INT                     NOT NULL,
  "from_status"         "booking_status",
  "to_status"           "booking_status"        NOT NULL,
  "changed_by_user_id"  VARCHAR(100)            NOT NULL,
  "changed_by_name"     VARCHAR(200),
  "note"                VARCHAR(500),
  "created_at"          TIMESTAMPTZ(6)          NOT NULL DEFAULT NOW(),
  CONSTRAINT "booking_status_history_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE
);

CREATE INDEX "booking_status_history_booking_created_idx"
  ON "booking_status_history" ("booking_id", "created_at");
