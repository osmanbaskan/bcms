CREATE TABLE "studio_plan_programs" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(300) NOT NULL UNIQUE,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "studio_plan_colors" (
  "id" SERIAL PRIMARY KEY,
  "label" VARCHAR(100) NOT NULL UNIQUE,
  "value" VARCHAR(20) NOT NULL UNIQUE,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "studio_plan_programs_active_sort_order_idx"
  ON "studio_plan_programs"("active", "sort_order");

CREATE INDEX "studio_plan_colors_active_sort_order_idx"
  ON "studio_plan_colors"("active", "sort_order");

INSERT INTO "studio_plan_programs" ("name", "sort_order") VALUES
  ('HABER CY', 10),
  ('beIN SABAH CY', 20),
  ('GÜN ORTASI CY', 30),
  ('beIN TENİS CY', 40),
  ('KADRO İÇİNDE BK', 50),
  ('BSL ÖZETLER BK', 60),
  ('beIN SÜPER LİG CY', 70),
  ('ANA HABER CY', 80),
  ('DEVRE ARASI', 90),
  ('KEŞFETTİK CY', 100),
  ('SKOR CY', 110),
  ('TRIO CY', 120),
  ('SPOR GECESİ CY', 130),
  ('10 NUMARA BK (UĞUR MELEKE’NİN ODASI)', 140),
  ('SPOR FİNAL CY', 150),
  ('DERBİ ANALİZ BK', 160),
  ('TAKTİK TAHTASI BK', 170),
  ('İSTATİSTİK BANKASI BK', 180),
  ('LİG MERKEZİ CY', 190),
  ('TARAFTAR BK', 200),
  ('beIN BASKETBOL CY', 210),
  ('BİR DERBİ GÜNÜ BK', 220),
  ('GAMER BK', 230),
  ('TAKTİK SETUP BK', 240),
  ('AVRUPA CY', 250),
  ('PREMIER EXPRES BK', 260),
  ('BASKETBOL SÜPER LİG MAÇ ÖNÜ REJİ ORTAK', 270),
  ('BASKETBOL SÜPER LİG MAÇ SONU REJİ ORTAK', 280);

INSERT INTO "studio_plan_colors" ("label", "value", "sort_order") VALUES
  ('HD NEWS', '#ffc400', 10),
  ('BS 1', '#c6d9f1', 20),
  ('BS 2', '#bfbfbf', 30),
  ('BS 3', '#00a6d6', 40),
  ('BS 4', '#2ff078', 50),
  ('beIN GURME', '#f4f500', 60),
  ('ADVERTORIAL / DEMO / DİĞER', '#8bc34a', 70),
  ('BS5', '#8b8956', 80),
  ('OUTSIDE', '#f5c9a8', 90),
  ('REJİ VE TANITIM', '#ff1010', 100),
  ('ORTAK YAYIN', '#6f2da8', 110);
