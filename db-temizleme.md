# DB Temizleme — Go-Live Öncesi Veri Sıfırlama Planı

> **Durum:** PLAN (henüz uygulanmadı). Sistem inşa aşamasında; canlı kullanıma
> geçmeden önce test/deneme verilerinin sıfırlanması için hazırlanmış runbook.
> **Hazırlanma:** 2026-06-04. **Hedef DB:** `bcms` (PostgreSQL 16).
> **Dikkat:** Bu işlem geri alınamaz veri siler. Adım 1 (yedek) ATLANMAZ —
> bkz. 2026-06-01 veri kaybı olayı.

---

## 0) Ön koşullar
- İşlem **sistem kullanımda değilken** yapılır (go-live öncesi bakım penceresi).
- Çalıştıran kişide DB erişimi olmalı (`bcms_user` / db `bcms`).
- Tüm komutlar **doğrudan psql** ile çalışır → Prisma **audit extension'ı ve
  soft-delete'i bypass eder** (gerçek sıfırlama; audit tablosu şişmez). Go-live
  öncesi temizlik için istenen davranış budur.

---

## 1) ÖNCE YEDEK (zorunlu)
```bash
# Tarih damgalı tam yedek
docker compose exec -T postgres pg_dump -U bcms_user -d bcms \
  | gzip > infra/postgres/backups/pre-reset-$(date +%Y%m%d-%H%M%S).sql.gz
```
Yedeğin oluştuğunu ve boyutunun makul olduğunu doğrula.

---

## 2) Kapsam — sekme → tablo eşleştirmesi

### 2.1 Sıfırlanacak operasyonel tablolar
> Satır sayıları **2026-06-04 itibarıyla** anlık değerlerdir; zamanla değişir.

| Sekme | Tablo(lar) | Satır (snapshot) | CASCADE çocuk |
|------|-----------|------:|----------------|
| **Canlı Yayın Plan** (`/schedules` = `live_plan_entries`) | `live_plan_entries` | 104 | `live_plan_technical_details` (6), `live_plan_transmission_segments` (1) |
| **Yayın Planlama** (`/yayin-planlama` = `schedules`) | `schedules` | 1 | `incidents` (0), `timeline_events` (0) |
| **Stüdyo Planı** | `studio_plans` (0), `studio_plan_slots` (0) | 0 | slots → plan |
| **Ingest** | `ingest_plan_items` (1), `ingest_plan_item_ports` (2), `ingest_jobs` (0), `qc_reports` (0) | ~3 | ports → item, qc → job |
| **Haftalık Shift** | `shift_assignments` | 0 | — |
| **İş Takip** | `bookings` (0) | 0 | `booking_comments` (0), `booking_status_history` (0) |

### 2.2 ⚠️ İsim tuzağı (canonical reversal)
- **"Canlı Yayın Plan"** sekmesi → DB tablosu **`live_plan_entries`**.
- **"Yayın Planlama"** sekmesi → DB tablosu **`schedules`**.
- Yani ekran adları ile tablo adları **terstir**. Bu plana **her ikisi de dahildir.**

### 2.3 KESİNLİKLE korunacaklar (silinmez)
- **Tüm dropdown / lookup tabloları** (admin'in elle girdiği, `live_plan_technical_details`'in RESTRICT parent'ları):
  - 16 `transmission_*` (satellites, irds, fibers, int_resources, tie_options, demod_options, virtual_resources, feed_types, modulation_types, video_codings, audio_configs, key_types, polarizations, fec_rates, roll_offs, iso_feed_options)
  - `live_plan_locations`, `live_plan_usage_locations`, `live_plan_regions`, `live_plan_languages`, `live_plan_equipment_options`, `live_plan_off_tube_options`
  - `fiber_audio_formats`, `fiber_video_formats`, `technical_companies`
  - `schedule_commercial_options`, `schedule_logo_options`, `schedule_format_options`
  - > Bunlara dokunmak teknik formdaki dropdown'ları ve mevcut kayıtların FK'lerini bozar.
- `recording_ports` — Ayarlar > Kayıt Portları config'i (46 satır).
- `studio_plan_programs` (29) + `studio_plan_colors` (11) — plana FK ile bağlı **değil**; program kataloğu + renk paleti (referans). **Bkz. Bölüm 4 açık karar.**
- `channels`, `leagues`, `teams`, kullanıcılar (Keycloak), `avid_settings`, `watcher_settings`, `notification_types`, `notification_subscriptions`.

---

## 3) Sıfırlama komutu

**Açık liste ile TRUNCATE** (CASCADE değil). Eksik tablo bırakılırsa PG hata verir
= güvenlik freni. `CASCADE` kullanılmaz çünkü çapraz FK'ler (ör. `ingest_jobs ↔
live_plan_entries`, SET NULL) beklenmedik tabloları süpürebilir; bu yüzden ilişkili
tüm tablolar tek listede açıkça yazılır.

```sql
BEGIN;

TRUNCATE
  -- Canlı Yayın Plan
  live_plan_entries, live_plan_technical_details, live_plan_transmission_segments,
  -- Yayın Planlama (schedules) + bağlı kayıtlar
  schedules, incidents, timeline_events,
  -- Stüdyo Planı
  studio_plans, studio_plan_slots,
  -- Ingest
  ingest_jobs, ingest_plan_items, ingest_plan_item_ports, qc_reports,
  -- Haftalık Shift
  shift_assignments,
  -- İş Takip
  bookings, booking_comments, booking_status_history
RESTART IDENTITY;

COMMIT;
```

- `RESTART IDENTITY` → otomatik-artan ID sayaçları 1'den başlar (temiz go-live).
- Tek transaction → ya hepsi olur ya hiçbiri (FK tutarlılığı korunur).

---

## 4) Açık kararlar (uygulamadan önce netleştir)

| Konu | Seçenek | Öneri |
|------|---------|-------|
| `studio_plan_programs` (29) + `studio_plan_colors` (11) | (a) Referans olarak **kalsın** / (b) onlar da boşalsın | **(a) Kalsın** — admin sıfırdan tanımlamak zorunda kalmaz. Tertemiz kurulum isteniyorsa (b). |
| Entegrasyon/geçmiş: `provys_items` (~54K), `asrun_items` (~62K), `matches` (~5.3K), `search_jobs`/`restore_jobs`/`transfer_jobs`, `outbox_events`, `audit_logs` | (a) **Kapsam dışı** / (b) onlar da sıfırlansın | **(a) Kapsam dışı** — 5 sekmenin verisi değil; watcher/OPTA yeniden doldurur. |

> Eğer 4(a→b) seçilirse ilgili tablolar Bölüm 3'teki TRUNCATE listesine eklenir.

---

## 5) Doğrulama (işlem sonrası)
```sql
SELECT relname, n_live_tup
FROM pg_stat_user_tables
WHERE relname IN (
  'live_plan_entries','live_plan_technical_details','live_plan_transmission_segments',
  'schedules','incidents','timeline_events',
  'studio_plans','studio_plan_slots',
  'ingest_jobs','ingest_plan_items','ingest_plan_item_ports','qc_reports',
  'shift_assignments',
  'bookings','booking_comments','booking_status_history'
)
ORDER BY relname;
```
Hepsi **0** olmalı. Lookup/config tablolarının satır sayısının **değişmediğini** de
ayrıca kontrol et (örn. `recording_ports`, `transmission_satellites`, `studio_plan_programs`).

---

## 6) Geri dönüş (bir şey ters giderse)
```bash
# Yedekten tam geri yükleme (DİKKAT: mevcut veriyi ezer)
gunzip -c infra/postgres/backups/pre-reset-<damga>.sql.gz \
  | docker compose exec -T postgres psql -U bcms_user -d bcms
```
Seçici geri yükleme gerekiyorsa tek tablo bazında `pg_restore`/`COPY` ile yapılır.

---

## Notlar
- Bu işlem **migration değildir**; `prisma migrate` ÇALIŞTIRILMAZ (drift→reset
  riski). Sadece veri (DML) temizliği.
- API/worker container'ları açıkken de çalıştırılabilir ama **kimse arayüzü
  kullanmıyorken** yapmak en güvenlisidir (yarım kalan yazma olmasın).
- Snapshot satır sayıları yalnız büyüklük fikri içindir; gerçek silme öncesi
  Bölüm 5 sorgusuyla güncel sayıyı gör.
