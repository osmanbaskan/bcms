# BCMS Developer Guide

Bu dosya gelistirici rehberidir. Gunluk servis kullanimi ve sahadaki baglanti bilgileri icin Desktop uzerindeki operasyon rehberlerini kullan:

- `/home/ubuntu/Desktop/BCMS_README.md`
- `/home/ubuntu/Desktop/BCMS_BAGLANTI_BILGILERI.txt`

## Mimari

- Backend: Fastify + Prisma + PostgreSQL + RabbitMQ
- Frontend: Angular
- Auth: Keycloak
- Shared package: TypeScript tipleri ve ortak yardimcilar
- Schedule veri kapsami: `schedules.usage_scope` kolonu Prisma
  `Schedule.usageScope` alani uzerinden yonetilir.
- Stüdyo planlari `studio_plans` ve `studio_plan_slots` tablolarinda,
  `schedules` akisini kirletmeden kalici tutulur.
- Frontend operasyon sekmeleri:
  - `Stüdyo Planı`: web uzerinde haftalik studyo planlama ve PDF export
  - `Haftalık Shift`: sol navigasyonda ayrilmis admin sekmesi
  - `Provys İçerik Kontrol`: sol navigasyonda ayrilmis admin sekmesi
- Monorepo:
  - `apps/api`
  - `apps/web`
  - `packages/shared`

## Dizinler

```text
apps/api              Fastify API, Prisma schema, background workers
apps/web              Angular web uygulamasi
packages/shared       Ortak TypeScript tipleri
ops/scripts           Lokal operasyon scriptleri
ops/systemd           Systemd service template dosyalari
infra                 Docker, nginx, monitoring, mount yardimcilari
scripts               OPTA/SMB yardimci scriptleri
```

## Lokal Kalici Runtime

Bu makinede ana runtime terminale bagli degildir. Systemd kullanilir.

- OPTA mount: `bcms-opta-mount.service`
- API: `bcms-api-dev.service`
- Web: `bcms-web-dev.service`

Runtime komutlari:

```bash
node apps/api/dist/server.js
node ops/scripts/bcms-web-static-server.mjs
```

Ana runtime icin `tsx watch` ve `ng serve` kullanilmaz. Bu komutlar sadece gecici gelistirme/debug ihtiyacinda manuel kullanilmalidir.

## Gelistirme Akisi

Kod degisikliginden sonra:

```bash
./ops/scripts/bcms-restart.sh
```

Bu script:

1. `packages/shared` build eder.
2. `apps/api` build eder.
3. `apps/web` build eder.
4. Systemd servislerini restart eder.

Sadece build almak icin:

```bash
./ops/scripts/bcms-build.sh
```

Tek tek build:

```bash
npm run build -w packages/shared
npm run build -w apps/api
npm run build -w apps/web
```

Tum repo build:

```bash
npm run build
```

API smoke test:

```bash
npm run smoke:api
```

Bu test health endpoint'ini, schedule/booking optimistic lock davranisini ve
playout state guard'ini kontrol eder. Varsayilan API adresi
`http://127.0.0.1:3000/api/v1`; farkli ortam icin `BCMS_API_URL` verilebilir.

CI:

- GitHub Actions workflow'u `.github/workflows/ci.yml` altindadir.
- Workflow `npm ci`, `npm audit --audit-level=high`, Prisma generate, bos DB
  bootstrap, tum repo build ve `npm run smoke:api` adimlarini calistirir.
- CI PostgreSQL ve RabbitMQ servis container'lari ile calisir; API arka plan
  watcher'lari `BCMS_BACKGROUND_SERVICES=none` ile kapali tutulur.

## API

API kaynak kodu:

```text
apps/api/src
```

API build output:

```text
apps/api/dist
```

API komutlari:

```bash
npm run build -w apps/api
npm run start -w apps/api
npm run db:generate -w apps/api
npm run db:migrate -w apps/api
npm run db:studio -w apps/api
```

Bos DB bootstrap:

```bash
./ops/scripts/bcms-db-bootstrap-empty.sh
```

Bu script sadece yeni ve bos PostgreSQL veritabanlari icindir. Public schema
bos degilse calismayi reddeder. Guncel Prisma schema'dan baseline SQL uretir,
DB'ye uygular ve repo altindaki migration'lari applied olarak isaretler.

API health:

```bash
curl -fsS http://127.0.0.1:3000/health
```

Swagger:

```text
http://172.28.204.133:3000/docs
```

## Canli Yayin Plani Veri Kapsami

Canli yayin plani ekranindan eklenen kayitlar normal yayin akisi kaydi gibi
kullanilmaz. Bu kayitlar `Schedule.usageScope` kolonu ile ayrilir:

```text
usage_scope = 'live-plan'
```

Varsayilan deger:

```text
usage_scope = 'broadcast'
```

Kural:

- Canli yayin plani ekraninda eklenen icerikler sadece `Raporlama` ve `Ingest`
  akislari icindir.
- Genel `/api/v1/schedules` listesi varsayilan olarak bu kayitlari disarida
  birakir.
- Canli yayin plani listesi ve raporlama `usage=live-plan` filtresiyle bu
  kayitlari okur.
- Ingest ekrani `/api/v1/schedules/ingest-candidates` endpoint'i ile sadece bu
  kapsamdaki plan kayitlarini gosterir.
- Ingest job `targetId` ile bir schedule'a baglanacaksa hedef kaydin
  `usageScope=live-plan` olmasi gerekir.
- Eski metadata icindeki `usageScope=reporting-ingest` degeri karar noktasi
  degildir; gecis sonrasi kanonik kaynak `schedules.usage_scope` kolonudur.
- Raporlama boyutlari artik JSON metadata path taramasi ile degil,
  `schedules.report_league`, `schedules.report_season` ve
  `schedules.report_week_number` kolonlari ile filtrelenir. Bu kolonlar
  schedule create/update sirasinda metadata icindeki `league`, `season` ve
  `weekNumber` alanlarindan senkronlanir.

Ilgili endpointler:

```text
GET  /api/v1/schedules?usage=live-plan
GET  /api/v1/schedules/ingest-candidates
GET  /api/v1/schedules/reports/live-plan
GET  /api/v1/schedules/reports/live-plan/export
POST /api/v1/ingest
GET  /api/v1/studio-plans/:weekStart
PUT  /api/v1/studio-plans/:weekStart
```

DB dogrulama:

```sql
SELECT usage_scope, COUNT(*) FROM schedules GROUP BY usage_scope;
SELECT report_league, report_season, report_week_number, COUNT(*)
FROM schedules
WHERE usage_scope = 'live-plan'
GROUP BY report_league, report_season, report_week_number;
```

DB korumalari:

- `schedules_usage_scope_check` constraint'i sadece `broadcast` ve `live-plan`
  degerlerini kabul eder.
- `schedules_usage_report_dims_idx` index'i canli yayin plani raporlama
  filtrelerini destekler.
- Eski `metadata.usageScope` gecis alani temizlenmistir.

Tutarlilik kurallari:

- Schedule ve booking update islemleri `If-Match` version header'i geldiyse
  `id + version` kosulu ile atomik uygulanir; stale update `412` doner.
- Playout gecisleri kontrolludur: sadece `CONFIRMED` kayit `ON_AIR`
  yapilabilir, sadece `ON_AIR` kayit `COMPLETED` yapilabilir.
- Ayni anda ayni kanalda ikinci bir `ON_AIR` schedule baslatilamaz.

Prisma Client notu:

- 2026-04-22'de `prisma generate` komutu schema'yi okuyup hata vermeden
  cikmasina ragmen `node_modules/.prisma/client` dosyalarini yenilemiyordu.
- Temiz kurulumla `node_modules/.prisma`, `node_modules/@prisma/client` ve
  `node_modules/prisma` silinip `prisma@5.22.0` ve `@prisma/client@5.22.0`
  yeniden kuruldu.
- Bu islemden sonra generated client `Schedule.usageScope` alanini yeniden
  uretmeye basladi.
- API artik `usage_scope` icin gecici raw SQL koprusu kullanmaz; schedule
  listeleme, export ve ingest hedef kontrolu Prisma `usageScope` field'i ile
  yapilir.
- Ayni regenerate sorunu tekrar gorulurse once ayni temiz Prisma reinstall
  proseduru uygulanmalidir; raw SQL koprusu geri eklenmemelidir.

Prisma migration ve enum notu:

- Bu lokal DB eski Alembic/manual kurulumdan geldigi icin `_prisma_migrations`
  tablosu yoktu. 2026-04-22'de mevcut DB semasi kontrol edildi ve repo altindaki
  8 Prisma migration `migrate resolve --applied` ile baseline edildi.
- `npm run db:migrate:prod -w apps/api` artik temiz sekilde `No pending
  migrations to apply` sonucunu verir.
- DB'deki eski PostgreSQL enum tipleri `booking_status`, `ingest_status` ve
  `incident_severity` olarak durur. Prisma schema bunlari sirasiyla
  `BookingStatus`, `IngestStatus` ve `IncidentSeverity` enumlarina `@@map`
  ile baglar. Bu nedenle enum tiplerini DB'de yeniden adlandirmadan once Prisma
  schema mapping'i dikkate alinmalidir.
- Bos yeni ortamlar icin `./ops/scripts/bcms-db-bootstrap-empty.sh`
  kullanilmalidir; mevcut veri olan DB'lerde bu script calistirilmaz.

Excel import/export notu:

- `xlsx` paketi bilinen high severity aciklari icin fix sunmadigindan kaldirildi.
- API Excel islemleri `exceljs` ile yapilir ve import dosyalari sadece `.xlsx`
  olarak kabul edilir. Eski `.xls` formati desteklenmez.

## Web

Web kaynak kodu:

```text
apps/web/src
```

Web build output:

```text
apps/web/dist/web/browser
```

Web build:

```bash
npm run build -w apps/web
```

Kalici runtime'da web, Angular dev server ile degil statik server ile sunulur:

```bash
node ops/scripts/bcms-web-static-server.mjs
```

Bu server:

- Angular build dosyalarini sunar.
- `/api` ve `/webhooks` isteklerini `http://127.0.0.1:3000` adresine proxy eder.

### Stüdyo Planı

`Stüdyo Planı` admin rolune acik, web uzerinde hazirlanan haftalik bir operasyon
ekranidir. Kaynak dosya:

```text
apps/web/src/app/features/studio-plan/studio-plan.component.ts
```

Guncel davranis:

- Sol navigasyonda `Stüdyo Planı`, `Haftalık Shift` ve
  `Provys İçerik Kontrol` admin-only route olarak bulunur.
- `Stüdyo Planı` Pazartesi-Pazar haftalik gorunum veya tek gun gorunumu sunar.
- Plan tablosu 06:00-02:00 araliginda 30 dakikalik slotlardan olusur.
- Her gun 5 studyo kolonuna bolunur: `Stüdyo 1`, `Stüdyo 2`, `Stüdyo 3`,
  `Stüdyo 4`, `beIN Gurme`.
- Program secimi ve renk secimi toolbar'daki select box'lardan yapilir.
- Ayni program ve renk ardisik slotlarda secildiginde gorunumde birlesik
  blok gibi davranir; metin tekrar etmez ve blok yuksekligine gore kuculur.
- `Silgi` modu tek bir 30 dakikalik kutucugu temizler.
- `Bu Haftayı Gelecek Haftaya Taşı` butonu bu haftadaki dolu hucreleri 7 gun
  ileri tasir ve gorunumu gelecek haftaya alir.
- `Export PDF` simdilik browser print akisini kullanir.
- Plan degisiklikleri backend'e kaydedilir; ekran yuklenirken secili
  Pazartesi haftasinin kaydi API'den okunur.

Mimari not:

- Stüdyo planlari `schedules` tablosundan ayri tutulur. Bu karar bilincli:
  stüdyo haftalik planlama operasyonel bir hazirlik tablosudur; canli yayin
  plani, raporlama ve ingest kapsamindaki yayin kayitlariyla ayni lifecycle'a
  sahip degildir.
- Backend endpoint'i `GET /api/v1/studio-plans/:weekStart` ile haftayi okur,
  `PUT /api/v1/studio-plans/:weekStart` ile haftanin tum slotlarini atomik
  olarak degistirir.
- Program ve renk secenekleri frontend icinde sabit liste degildir. Backend
  katalog endpoint'i `GET /api/v1/studio-plans/catalog` ile okunur; admin
  yazma yetkisiyle `PUT /api/v1/studio-plans/catalog` uzerinden yenilenebilir.
- `weekStart` sadece Pazartesi tarihi olarak kabul edilir. Slotlar gun tarihi,
  studyo, baslangic dakikasi, program ve renk degeriyle saklanir.
- Prisma modelleri `StudioPlan` ve `StudioPlanSlot`; DB tabloları
  `studio_plans` ve `studio_plan_slots` seklindedir.
- Katalog modelleri `StudioPlanProgram` ve `StudioPlanColor`; DB tabloları
  `studio_plan_programs` ve `studio_plan_colors` seklindedir.
- Bu ozellik icin migration:
  `apps/api/prisma/migrations/20260423000000_studio_plans/migration.sql`.
- Katalog migration'i:
  `apps/api/prisma/migrations/20260423001000_studio_plan_catalog/migration.sql`.
- Migration uygulanmadan API calistirilirsa Stüdyo Planı endpoint'i veritabani
  tablo hatasi verebilir. Yerelde PostgreSQL acikken
  `npm run db:migrate:prod -w apps/api` calistirilmalidir.

## Shared Package

Ortak tipler:

```text
packages/shared/src
```

Build:

```bash
npm run build -w packages/shared
```

API veya Web shared tiplerini kullanacaksa once shared build alinmalidir. Operasyon scriptleri bunu otomatik yapar.

## Environment

Ana ortam dosyasi:

```text
.env
```

Lokal runtime icin onemli degerler:

```bash
NODE_ENV=development
SKIP_AUTH=true
CORS_ORIGIN=http://localhost:4200,http://172.28.204.133:4200
OPTA_DIR=/mnt/opta-backups/OPTAfromFTP20511
OPTA_SMB_MOUNT_POINT=/mnt/opta-backups
KEYCLOAK_ISSUER=http://localhost:8080/realms/bcms
KEYCLOAK_ALLOWED_CLIENTS=bcms-web,bcms-api
INGEST_ALLOWED_ROOTS=./tmp/watch,/mnt/opta-backups/OPTAfromFTP20511
BCMS_BACKGROUND_SERVICES=all
```

Not: Lokal auth bypass artik `NODE_ENV=development` olmasina bagli degil; `SKIP_AUTH=true` gerekir.
Production runtime `KEYCLOAK_CLIENT_ID`, `INGEST_CALLBACK_SECRET` ve
`INGEST_ALLOWED_ROOTS` olmadan baslamaz. Ingest manuel kaynak yollari sadece
`INGEST_ALLOWED_ROOTS` icindeki gercek video dosyalarini kabul eder.
Production'da RabbitMQ baglantisi kurulamazsa API fail-fast davranir ve
baslamaz. Sadece lokal/gelistirme icin `RABBITMQ_OPTIONAL=true` kullanilabilir.
`BCMS_BACKGROUND_SERVICES` API process icinde hangi arka plan islerinin
baslatilacagini belirler: `all`, `none` veya virgullu liste
(`notifications,ingest-worker,ingest-watcher,bxf-watcher,opta-watcher`).

## OPTA

Dogru OPTA yolu:

```text
/mnt/opta-backups/OPTAfromFTP20511
```

Yanlis/eski yol:

```text
/home/ubuntu/opta
```

OPTA mount systemd guard:

```bash
systemctl status bcms-opta-mount.service
```

OPTA durum scripti:

```bash
./ops/scripts/bcms-opta-status.sh
```

API, `/mnt/opta-backups` mount hazir olmadan baslamayacak sekilde ayarlanmistir.

## Servis Kontrolu

Kisa durum:

```bash
./ops/scripts/bcms-status.sh
```

Loglar:

```bash
./ops/scripts/bcms-logs.sh
./ops/scripts/bcms-logs.sh api
./ops/scripts/bcms-logs.sh web
```

Systemd:

```bash
systemctl status bcms-opta-mount.service bcms-api-dev.service bcms-web-dev.service
systemctl is-enabled bcms-opta-mount.service bcms-api-dev.service bcms-web-dev.service
```

Servisleri yeniden kurmak:

```bash
printf '%s\n' 'ubuntu' | sudo -S ./ops/scripts/bcms-install-system-services.sh
```

## Dogrulama

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:4200/
curl -fsS http://127.0.0.1:4200/api/v1/channels
curl -fsS http://127.0.0.1:3000/api/v1/opta/status
curl -fsS http://172.28.204.133:3000/health
curl -fsS http://172.28.204.133:4200/
```

Port kontrolu:

```bash
sudo ss -ltnp 'sport = :3000 or sport = :4200'
```

Beklenen:

- `3000`: `node apps/api/dist/server.js`
- `4200`: `node ops/scripts/bcms-web-static-server.mjs`

Eski watcher surecleri calismamali:

```bash
sudo sh -c "pgrep -af 'tsx watch|ng serve' | grep -v pgrep | grep -v 'sh -c' || true"
```

## Yerel Altyapi

PostgreSQL:

- Service: `snap.postgresql.postgresql.service`
- Host: `localhost`
- Port: `5432`
- DB: `bcms`

RabbitMQ:

- Service: `rabbitmq-server.service`
- AMQP port: `5672`
- Management UI: `http://localhost:15672`

Keycloak:

- URL: `http://localhost:8080`
- Realm: `bcms`

## Operasyon Dokumanlari

- `/home/ubuntu/Desktop/BCMS_README.md`: kullanici/operasyon rehberi
- `/home/ubuntu/Desktop/BCMS_BAGLANTI_BILGILERI.txt`: tum baglanti ve kimlik bilgileri
- `ops/README.md`: servis scriptleri ozeti
- `ops/NOTES_FOR_CODEX.md`: gelecekteki Codex oturumlari icin teknik not
