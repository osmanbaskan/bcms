# BCMS Operasyon Scriptleri ve Mimarisi

Bu klasör, projenin operasyonel scriptlerini ve `systemd` gibi eski altyapı bileşenlerini içerir. Proje artık tamamen **Docker Compose** ile yönetildiği için buradaki `systemd` ve `cron` tabanlı kurulum scriptleri **kullanımdan kaldırılmıştır**.

## Güncel Mimari ve Çalıştırma Yöntemi

Projenin tüm altyapısı (API, Web, veritabanları, mesaj kuyruğu vb.) `docker-compose.yml` dosyasında tanımlanmıştır. Projeyi başlatmak, durdurmak ve yönetmek için Docker komutları kullanılmalıdır.

```bash
# Projeyi arka planda başlat
docker compose up -d

# Servislerin loglarını izle
docker compose logs -f

# Bir servisi yeniden build et (kod değişikliğinden sonra)
docker compose up -d --build api
```

Kurulumdan sonra servisler otomatik baslar. PC restart oldugunda API ve Web yine otomatik ayaga kalkar.

User-level systemd kullanmak istersen:

```bash
./ops/scripts/bcms-install-user-services.sh
```

Sudo yoksa fallback kurulum:

```bash
./ops/scripts/bcms-install-cron-fallback.sh
```

Bu kurulum `crontab @reboot` ile supervisor baslatir. Supervisor API veya Web kapanirsa tekrar baslatir.

## Gunluk kullanim

```bash
./ops/scripts/bcms-status.sh
./ops/scripts/bcms-restart.sh
./ops/scripts/bcms-logs.sh
./ops/scripts/bcms-logs.sh api
./ops/scripts/bcms-logs.sh web
./ops/scripts/bcms-opta-status.sh
npm run smoke:api
```

`bcms-start.sh`, `bcms-restart.sh` ve kurulum scriptleri once `packages/shared`, `apps/api` ve `apps/web` build eder; sonra servisleri baslatir.

## Adresler

- Web: http://172.28.204.133:4200
- API: http://172.28.204.133:3000

## Frontend Operasyon Sekmeleri

Admin sol navigasyonunda uc yeni operasyon sekmesi bulunur:

- `Stüdyo Planı` -> `/studio-plan`
- `Haftalık Shift` -> `/weekly-shift`
- `Provys İçerik Kontrol` -> `/provys-content-control`

## Ingest Operasyon Mimarisi

`Ingest` frontend'i artik iki ayri calisma penceresi mantigi ile ilerler:

- `Ingest Planlama`: satir bazli plan tablosu
- `Port Görünümü`: kayit portlarina gore operasyonel pano

Teknik notlar:

- Kayit port katalogu backend tablosu `recording_ports` uzerinden yonetilir.
- Varsayilan aktif liste `1..44`, `Metus1`, `Metus2` toplam 46 porttur.
- Plan satiri kaliciligi `ingest_plan_items` tablosundadir.
- `recording_port`, `planned_start_minute`, `planned_end_minute`, `status`,
  `job_id` ve `updated_by` burada tutulur.
- Port cakismasi backend'de reddedilir; ayni gun ve ayni port icin kesisen
  saat araliklari ikinci kez kaydedilemez.
- `Port Görünümü` bos portlari da gosterir; operasyon ekibi toplam kapasiteyi
  tek ekranda gorebilir.
- Guncel pano davranisi: 5 satirli dagilim, tam ekran, zoom ve print/export.

`Stüdyo Planı` web uzerinde haftalik plan hazirlamak ve PDF/print export almak
icin kullanilir. Ekran 06:00-02:00 araliginda 30 dakikalik slotlarla calisir,
gun basina 5 studyo kolonu gosterir ve program/renk secimini toolbar
select'leriyle yapar. Ardisik ayni program-renk secimleri gorunumde birlesik
blok gibi davranir; `Silgi` tek hucre temizler. `Bu Haftayı Gelecek Haftaya
Taşı` butonu bu haftanin dolu hucrelerini 7 gun ileri tasir.

Operasyon notu:

- `Stüdyo Planı` artik backend'e kalici kaydedilir.
- Veri modeli `schedules` tablosundan ayridir: haftalik plan ust kaydi
  `studio_plans`, 30 dakikalik dolu kutucuklar `studio_plan_slots` tablosunda
  tutulur.
- API endpointleri:
  - `GET /api/v1/studio-plans/:weekStart`
  - `PUT /api/v1/studio-plans/:weekStart`
  - `GET /api/v1/studio-plans/catalog`
  - `PUT /api/v1/studio-plans/catalog`
- Program ve renk secenekleri artik backend katalog tablolarindan gelir:
  `studio_plan_programs` ve `studio_plan_colors`.
- `weekStart` Pazartesi tarihi olmak zorundadir; ekran sadece gecen hafta,
  bu hafta ve gelecek hafta Pazartesi seceneklerini gosterir.
- Bu ekran canli yayin plani `schedules.usage_scope` verisini kullanmaz.
- Yeni ortamda veya migration uygulanmamis lokal DB'de once
  `npm run db:migrate:prod -w apps/api` calistirilmelidir.

## Systemd servisleri

- `bcms-opta-mount.service`
- `bcms-api-dev.service`
- `bcms-web-dev.service`

API servisi `/mnt/opta-backups` mount hazir olmadan baslamayacak sekilde ayarlanmistir.

## Canli Yayin Plani Kapsami

Canli yayin plani ekranindan eklenen kayitlar genel yayin plani kaydi olarak
kullanilmaz. Bu kayitlar sadece Raporlama ve Ingest akislarinda kullanilir.

Teknik kolon:

```text
schedules.usage_scope = 'live-plan'
```

Varsayilan normal yayin kayitlari:

```text
schedules.usage_scope = 'broadcast'
```

Karar mekanizmasi metadata degil bu DB kolonudur. Eski kayitlarda metadata
icinde kalmis `usageScope` alanlari temizlenmistir, filtreleme icin
kullanilmamalidir.

API mimarisi:

- `schedules.usage_scope` Prisma schema'da `Schedule.usageScope` olarak
  tanimlidir.
- 2026-04-22 temiz Prisma reinstall sonrasi generated client bu alani uretir.
- Schedule listeleme/export ve Ingest hedef dogrulamasi Prisma `usageScope`
  field'i ile yapilir; bu alan icin raw SQL uyumluluk koprusu kullanilmaz.
- `prisma generate` tekrar schema'yi okuyup client dosyalarini yenilemezse
  once `node_modules/.prisma`, `node_modules/@prisma/client` ve
  `node_modules/prisma` temizlenip Prisma paketleri yeniden kurulmalidir.
- Bu lokal DB 2026-04-22'de Prisma migration history acisindan baseline edildi:
  repo altindaki 8 migration `_prisma_migrations` tablosunda applied olarak
  isaretlidir ve `npm run db:migrate:prod -w apps/api` bekleyen migration
  gormemelidir.
- DB'deki eski enum tip adlari `booking_status`, `ingest_status` ve
  `incident_severity` olarak korunur. Prisma schema bunlari `BookingStatus`,
  `IngestStatus` ve `IncidentSeverity` enumlarina `@@map` ile baglar.
- Yeni ve bos PostgreSQL veritabanlari icin
  bash tabanli bootstrap scriptleri birakilmis, standart Prisma migration ve
  seed sureclerine gecilmistir. CI/CD tamamen `prisma migrate deploy` kullanir.

Excel notu:

- Guvenlik nedeniyle `xlsx` paketi kaldirildi ve Excel islemleri `exceljs` ile
  yapilir.
- Import sadece `.xlsx` kabul eder; `.xls` desteklenmez.

CI notu:

- GitHub Actions workflow'u `.github/workflows/ci.yml` dosyasindadir.
- CI bos PostgreSQL DB'yi `./ops/scripts/bcms-db-bootstrap-empty.sh` ile
  standart `prisma migrate deploy` komutu ile hazirlar, unit testleri
  (`npm run test`) ve `npm run smoke:api` calistirir.
- CI ortaminda watcher/background servisleri `BCMS_BACKGROUND_SERVICES=none`
  ile kapatilir.

DB constraint:

```text
schedules_usage_scope_check -> broadcast | live-plan
```

Ilgili kontroller:

```bash
curl -fsS 'http://127.0.0.1:3000/api/v1/schedules?usage=live-plan&pageSize=1'
curl -fsS 'http://127.0.0.1:3000/api/v1/schedules/ingest-candidates?pageSize=1'
curl -fsS 'http://127.0.0.1:3000/api/v1/schedules/reports/live-plan?pageSize=1'
```
