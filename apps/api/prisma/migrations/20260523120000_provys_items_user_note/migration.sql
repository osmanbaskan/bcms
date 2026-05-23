-- ProvysItem.userNote — kullanıcı tarafından eklenen serbest metin not.
-- BXF parser/watcher bu alana yazmaz; PATCH /provys/items/:id/note ile
-- güncellenir. Composed snapshot diff (`buildDiff`) update data'sında
-- user_note yer almadığı için Prisma alanı korur.
ALTER TABLE "provys_items"
  ADD COLUMN IF NOT EXISTS "user_note" TEXT NULL;
