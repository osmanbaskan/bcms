# BCMS Developer Guide

Bu dosya gelistirici rehberidir. Gunluk servis kullanimi ve sahadaki baglanti bilgileri icin Desktop uzerindeki operasyon rehberlerini kullan:

- `/home/ubuntu/Desktop/BCMS_README.md`
- `/home/ubuntu/Desktop/BCMS_BAGLANTI_BILGILERI.txt`

## Mimari

- Backend: Fastify + Prisma + PostgreSQL + RabbitMQ
- Frontend: Angular
- Auth: Keycloak
- Shared package: TypeScript tipleri ve ortak yardimcilar
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

Ilgili endpointler:

```text
GET  /api/v1/schedules?usage=live-plan
GET  /api/v1/schedules/ingest-candidates
GET  /api/v1/schedules/reports/live-plan
GET  /api/v1/schedules/reports/live-plan/export
POST /api/v1/ingest
```

DB dogrulama:

```sql
SELECT usage_scope, COUNT(*) FROM schedules GROUP BY usage_scope;
```

DB korumalari:

- `schedules_usage_scope_check` constraint'i sadece `broadcast` ve `live-plan`
  degerlerini kabul eder.
- Eski `metadata.usageScope` gecis alani temizlenmistir.

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
```

Not: Lokal auth bypass artik `NODE_ENV=development` olmasina bagli degil; `SKIP_AUTH=true` gerekir.

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
