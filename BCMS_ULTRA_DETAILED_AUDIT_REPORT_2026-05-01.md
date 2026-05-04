# BCMS Ultra-Detaylı Kapsamlı Audit Raporu

> **Tarih:** 2026-05-01
> **Doğrulama:** 2026-05-04 — `BCMS_AUDIT_VERIFICATION_2026-05-04.md` raporunda 189 madde tek tek kod tabanına karşı doğrulandı. **Doğruluk oranı: %83.1 ✅, %12.2 🟡 kısmen, %2.1 ❌ yanlış, %2.1 ⚠️ flu, %0.5 🔄 outdated.** Kullanmadan önce o raporu da oku.
> **Mod:** Tamamen Read-Only — hiçbir dosya, kod, veritabanı veya Docker durumu değiştirilmemiştir.
> **Kapsam:**
> - `apps/api/src` (~50+ TS dosya, Prisma schema, 27 migration)
> - `apps/web/src` (~62+ TS/HTML/SCSS dosya, Angular 21)
> - `packages/shared/src` (tipler, PERMISSIONS, constantlar)
> - `infra/` (Docker, Keycloak, Prometheus, Grafana, PostgreSQL, RabbitMQ)
> - `docker-compose.yml` + `docker-compose.nohost.yml`
> - `.github/workflows/ci.yml`
> - `ops/` (systemd, scriptler, dokümanlar)
> - Runtime: Docker container health, log analizi, canlı DB sorguları
> - Mevcut raporlar: BCMS_AUDIT_REPORT_2026-05-01, BCMS_DETAILED_AUDIT_REPORT_2026-04-30

---

## 1. Executive Summary

> ⚠️ **2026-05-04 düzeltmesi:** Aşağıdaki tabloda raporun kendi yazdığı sayılar **yanlıştı** (toplamda 126 deniyordu). Gerçek bulgu sayısı **189**. Düzeltilmiş tablo:

| Severity | API Backend | Web Frontend | Infra / DB / Docker | Shared / Config | Toplam |
|----------|-------------|--------------|---------------------|-----------------|--------|
| 🔴 **CRITICAL** | 0 | 3 | 7 | 0 | **10** |
| 🟠 **HIGH** | 19 | 11 | 20 | 7 | **57** |
| 🟡 **MEDIUM** | 25 | 17 | 8 | 7 | **57** |
| 🟢 **LOW** | 26 | 10 | 7 | 1 | **44** |
| ℹ️ **INFO** | — | — | — | — | **21** |

**Sistem Genel Sağlık Durumu:** Kod düzeyinde auth bypass, secret leak veya production-stop sınıfı acil bir gap yoktur. Ancak altyapı ve operasyonel hijyen seviyesinde **7 adet CRITICAL** bulgu mevcuttur. En tehlikeli olanlar: Keycloak/web dışarıya açık portlar, hardcoded şifreler, migration baseline kaybı (clean-room replay imkansız), worker healthcheck devre dışı, ve Prometheus sahte exporter yapılandırmasıdır.

**Cross-Cutting Temalar:**
1. **Altyapı güvenliği açıkları** — Docker Compose'da resource limit, log rotation, TLS, network kısıtlama yok.
2. **Migration / Schema bütünlüğü** — DB'de 27 migration, FS'te 27 klasör ama bazıları no-op placeholder; clean PG'de `migrate deploy` başarısız (baseline absent).
3. **Soft-delete stratejisi yokluğu** — `deleted_at` kolonları var ama neredeyse hiç kullanılmıyor; hem veri bütünlüğü hem de `@unique` çakışması riski.
4. **Race conditions (uygulama katmanı)** — Ingest plan ve schedule import'ta TOCTOU var, DB GiST exclusion kısmen koruyor ama uygulama katmanı yanlış hata mesajı üretebiliyor.
5. **God component / teknik borç** — `schedule-list` (2,306 satır) ve `ingest-list` (1,580 satır) tek sorumluluk ilkesini ihlal ediyor.
6. **Audit log enflasyonu** — 2026-04-30 00:00-09:30 arası tek bir burst'te 205,022 satır (toplam audit log'un %36'sı) yazılmış; root cause bilinmiyor.

---

## 2. Tarama Metodolojisi

1. **Statik Kod Analizi** — Tüm TypeScript kaynak dosyaları satır satır incelendi (pattern: `find`, `grep`, `ReadFile`).
2. **Prisma & DB Analizi** — Schema, migration'lar, canlı PostgreSQL `_prisma_migrations`, `pg_stat_user_tables`, index ve constraint listeleri.
3. **Docker & Infra Analizi** — `docker-compose.yml`, Dockerfile'lar, nginx config, Keycloak realm, systemd unit'ler.
4. **Runtime Analizi** — Docker container healthcheck'leri, `docker logs` (API/Worker/Web/Postgres/OPTA), `docker stats`, `curl` health endpoint.
5. **Cross-Reference** — Önceki audit raporları (2026-04-30, 2026-05-01) ile karşılaştırma; çözülmüş/çözülmemiş ayrımı.
6. **Type Check** — `npx tsc --noEmit` hem API hem Web için `exit 0` doğrulandı.

---

## 3. 🔴 CRITICAL Bulgular

### CRIT-001 — Keycloak Admin Console Tüm Ağ Arayüzlerine Açık
- **Dosya:** `docker-compose.yml:96`
- **Bulgu:** Keycloak `8080:8080` olarak bind edilmiş (`0.0.0.0`). Admin console, realm endpoint'leri ve token servisi doğrudan dış ağa maruz.
- **Risk:** Brute-force, admin credential leak, realm dump, DoS.
- **Öneri:** `127.0.0.1:8080:8080` yap; dışarıdan erişim reverse proxy (TLS) üzerinden sağlansın.

### CRIT-002 — Angular Web Uygulaması Tüm Ağ Arayüzlerine Açık
- **Dosya:** `docker-compose.yml:222`
- **Bulgu:** `web` servisi `4200:80` olarak `0.0.0.0`'e bind edilmiş. Production senaryosunda nginx frontend doğrudan dışarıya açık.
- **Risk:** Uygulama yüzeyi, API URL'leri, client ID'ler, Angular chunk map'leri leak.
- **Öneri:** `127.0.0.1:4200:80` yap; production'da Traefik/NGINX host-level reverse proxy kullan.

### CRIT-003 — Hardcoded Zayıf Şifreler Git Tarihçesinde
- **Dosya:** `infra/keycloak/realm-export.json:76,84,92`
- **Bulgu:** `admin123`, `planner123`, `viewer123` şifreleri plaintext olarak realm export'ta. `temporary: true` olmasına rağmen her container restart/import'ta aktif.
- **Risk:** Host compromise durumunda anında exploit.
- **Öneri:** Tüm `credentials` bloklarını realm-export'tan sil. İlk kullanıcı oluşturmayı environment-based bootstrap script'e taşı.

### CRIT-004 — Prisma Migration Baseline Kayıp: Clean-Room Replay İmkansız
- **Dosya:** `apps/api/prisma/migrations/`
- **Bulgu:** En eski migration (`20260416000000_add_matches`) `schedules`/`bookings` gibi tablolara `ALTER` yapıyor ama bu tabloları oluşturan **baseline migration yok**. `ops/NOTES_FOR_CODEX.md`'de "Local DB 2026-04-22'de 8 migration baseline edildi" deniyor ama bu baseline'ın DDL'i FS'te yok. Clean-room test: `prisma migrate deploy` ilk adımda `relation "schedules" does not exist` hatası veriyor.
- **Risk:** CI/CD, yeni dev ortamı, staging provision, DR senaryolarında kırılır.
- **Öneri:** Production'dan `pg_dump --schema-only` al; `00000000000000_baseline/migration.sql` oluştur. Eski migration'ları `_archive/` taşı; `migrate resolve --applied` ile işaretle.

### CRIT-005 — Worker Healthcheck Aktif Olarak Devre Dışı Bırakılmış
- **Dosya:** `docker-compose.yml:171`
- **Bulgu:** `worker` servisi `healthcheck: { disable: true }`. Worker arka plan işlemlerini (notifications, ingest, bxf-watcher, audit-retention) çalıştırıyor. Crash veya askıda kalma durumunda Docker otomatik restart edemez.
- **Risk:** Sessizce duran worker = iş kuyrukları tükenmez, bildirimler gitmez, audit retention çalışmaz.
- **Öneri:** Hafif bir liveness probe (process check veya minimal HTTP endpoint) ekle ve healthcheck'i yeniden etkinleştir.

### CRIT-006 — Prometheus Var Olmayan Exporter'lara Scrape Ediyor
- **Dosya:** `infra/prometheus/prometheus.yml:17-26`
- **Bulgu:** `postgres-exporter:9187` ve `node-exporter:9100` hedefleri tanımlı ama `docker-compose.yml`'de bu servisler yok. `rabbitmq:15692` için de RabbitMQ prometheus plugin'i aktif değil.
- **Risk:** Yanlış negatif alarm, log spam, "her şey izleniyor" hissiyatı altında gerçek blind spot.
- **Öneri:** Eksik exporter servislerini ekle veya scrape job'ları kaldır.

### CRIT-007 — `deleted_at` Soft-Delete Kolonu Var Ama Tamamen Kullanılmıyor
- **Dosya:** `apps/api/prisma/schema.prisma` (20'den fazla model)
- **Bulgu:** Neredeyse her modelde `deleted_at` var ama hiçbir `findMany`/`findUnique`/`count` bunu filtrelemiyor. Tüm `DELETE` endpoint'leri hard delete (`prisma.model.delete()`) yapıyor. `schedules` tablosunda 1 satır soft-deleted ama listede görünüyor.
- **Risk:** Silinen veriler sızdırılıyor, soft-delete/@unique çakışması (aynı isimle yeniden oluşturulamama), semantik kararsızlık.
- **Öneri:** Karar ver: (a) tüm soft-delete kolonlarını drop et ve hard-delete standardize et; veya (b) Prisma extension ile otomatik `deletedAt: null` filtresi ekle ve delete endpoint'lerini `update({ deletedAt })` yap.

### CRIT-008 — God Component: `schedule-list.component.ts` (2,306 satır)
- **Dosya:** `apps/web/src/app/features/schedules/schedule-list/schedule-list.component.ts`
- **Bulgu:** Tek dosyada 5 component (`ScheduleListComponent`, 4 dialog), ~1,000 satır inline CSS. SRP ihlali, merge conflict riski, test edilemezlik, bundle bloat.
- **Risk:** Geliştirici verimliliği düşer, regresyon riski yüksek.
- **Öneri:** Her dialog'u ayrı dosyaya taşı; CSS'i `.scss` dosyalarına çıkar. Ana component < 300 satır hedefle.

### CRIT-009 — God Component: `ingest-list.component.ts` (1,580 satır)
- **Dosya:** `apps/web/src/app/features/ingest/ingest-list/ingest-list.component.ts`
- **Bulgu:** Ingest job polling, live plan candidate, studio plan slot mapping, ingest plan CRUD, port board, print/PDF generation, burst polling — hepsi tek component'te.
- **Risk:** CRIT-008 ile aynı.
- **Öneri:** `IngestJobListComponent`, `IngestPlanBoardComponent`, `IngestPortBoardPageComponent`'e ayır; servis katmanına taşı.

### CRIT-010 — Global `setInterval` Token Refresh Bellek Sızıntısı
- **Dosya:** `apps/web/src/app/app.config.ts:41`
- **Bulgu:** `window.setInterval(() => {...}, TOKEN_REFRESH_INTERVAL_MS)` başlatılıyor ama interval ID saklanmıyor/temizlenmiyor. SPA lifecycle dışında (HMR, test, micro-frontend) interval yığılıyor.
- **Risk:** Bellek sızıntısı, gereksiz token refresh spam'i.
- **Öneri:** Interval ID'yi sakla; `onDestroy` hook veya teardown'da `clearInterval` yap.

---

## 4. 🟠 HIGH Bulgular

### API Backend (HIGH)

| ID | Dosya | Satır | Açıklama | Öneri |
|----|-------|-------|----------|-------|
| HIGH-API-001 | `schedule.import.ts` | 59 | `parseTurkishDateTime` `new Date(year, month, ...)` sunucu local timezone kullanıyor; Türkiye UTC+3 olmayan sunucuda kayar | `Date.UTC()` veya `+03:00` explicit parse kullan |
| HIGH-API-002 | `ingest.routes.ts` | 412-506 | Conflict check `findFirst` transaction dışında; TOCTOU race condition | Check'i transaction içine al veya tamamen kaldırıp DB exclusion constraint'e güven |
| HIGH-API-003 | `schedule.import.ts` | 163-185 | `findFirst` + `create` atomik değil; concurrent Excel import overlap üretebilir | `$transaction` + Serializable isolation ile sarmala |
| HIGH-API-004 | `plugins/audit.ts` | 154-165 | `onSend` hook audit log'ları sadece `statusCode < 400` ise flush ediyor. Handler yazma sonrası throw ederse (500) audit kaybolur | Write başına flush veya transaction wrap; status koduna bakma |
| HIGH-API-005 | `opta.sync.routes.ts` | 93-110 | Tek `$transaction` içinde tüm match create/update `Promise.all` ile sınırsız paralel; bağlantı havuzu tükenir, kilit çatışması | Batch (`createMany`) + concurrency limit (`p-map` gibi, limit=10) |
| HIGH-API-006 | `ingest.routes.ts` | 276-304 | Report endpoint'leri (`/ingest/plan/report`, `/studio-plans/reports/usage`) satır limiti yok; 1 yıllık data onbinlerce satır dönebilir | Pagination veya `take`/`LIMIT` ekle |
| HIGH-API-007 | `opta.sync.routes.ts` | 19-21 | `syncBodySchema.matches` array'in `max` limiti yok; DoS payload mümkün | `.max(5000)` ekle |
| HIGH-API-008 | `users.routes.ts` | 196-301 | Email validation yok (`z.string()`), password complexity yok | `z.string().email()` ve `z.string().min(12)` ekle |
| HIGH-API-009 | `app.ts` | 139-159 | Prisma error mesajları (`error.message`) client'a dönüyor; schema detayı sızdırıyor | Client'a generic mesaj dön; detayı server log'la |
| HIGH-API-010 | `app.ts` | 197-216 | Swagger UI (`/docs`) production'da koşulsuz açık; API surface tamamen expose | `NODE_ENV !== 'production'` koşuluyla kaydet veya `app.authenticate` koru |
| HIGH-API-011 | `weekly-shift.routes.ts` | 392-418 | `PUT /:group` body Zod validasyonu yok; `assignments` direkt `createMany`'e gidiyor | `ShiftInput` Zod schema tanımla ve parse et |
| HIGH-API-012 | `keycloak-admin.client.ts` | 17-54 | `adminToken`/`tokenExpiry` module-level variable; concurrent refresh race condition | Promise-based gate (`refreshPromise`) kullan |
| HIGH-API-013 | `booking.service.ts` | 137-147 | Her `findAll`'da Keycloak'dan 500 kullanıcı çekiliyor; cache yok | Kısa TTL (60sn) cache ekle |
| HIGH-API-014 | `weekly-shift.routes.ts` | 157,163 | `visibleGroups.map(...)` içinde `fetchCurrentUserType` her grup için ayrı HTTP isteği atıyor | Önce bir kere hesapla, sonucu parametre olarak geç |
| HIGH-API-015 | `users.routes.ts` | 109-111 | Her listing'de 13 Keycloak HTTP turu (users + 12 grup) | Grup üyeliklerini TTL cache'le |
| HIGH-API-016 | `ingest.worker.ts` | 31-116 | `computeChecksum`, `probeFile`, `measureLoudness`, `generateProxy` timeout yok; ffmpeg askıda kalabilir | `Promise.race` ile 5dk timeout |
| HIGH-API-017 | `ingest.routes.ts:332`, `studio-plan.routes.ts:262`, `weekly-shift.routes.ts:334`, `schedule.export.ts:94` | çeşitli | Excel export `workbook.xlsx.write(stream)` `await` edilmiyor; error listener yok | `await` + try/catch + `pipeline()` kullan |
| HIGH-API-018 | `ingest.watcher.ts`, `bxf.watcher.ts` | 10, 65 | `chokidar.watch()` referansı saklanmıyor; `onClose`'da `.close()` yapılmıyor | Watcher instance'ını sakla; `app.addHook('onClose', ...)` içinde kapat |
| HIGH-API-019 | `app.ts` | 165-173 | `trustProxy: true` kapalı; `request.ip` nginx container IP'si oluyor; rate-limit tek IP'ye (nginx) uygulanıyor, audit IP yanlış | `trustProxy: true` veya güvenilir CIDR listesi ile başlat |

### Web Frontend (HIGH)

| ID | Dosya | Satır | Açıklama | Öneri |
|----|-------|-------|----------|-------|
| HIGH-FE-001 | `audit-log.component.ts` | 20-21,327,378 | `beforePayload: any`, `afterPayload: any`, `formatJson(value: any)` — TypeScript bypass | `JsonValue` tipi tanımla; `unknown` + guard kullan |
| HIGH-FE-002 | `app.component.ts` | 162 | `const parsed: any = kc?.tokenParsed ?? {};` `BcmsTokenParsed` yerine `any` | Tipi `BcmsTokenParsed | undefined` yap |
| HIGH-FE-003 | `api.service.ts` | tümü | `HttpClient` wrapper; zero error handling, retry, global notification | Global `catchError` pipe veya `HttpErrorInterceptor` ekle |
| HIGH-FE-004 | `ingest-list.component.ts`, `audit-log.component.ts`, `weekly-shift.component.ts`, `ingest-port-board.component.ts` | çeşitli | `::ng-deep` kullanımı (deprecated, Angular'da kaldırılacak) | CSS custom properties veya global `styles.scss` BEM kullan |
| HIGH-FE-005 | `booking-list.component.ts` | 354-360 | API'den gelen bookings her seferinde client-side sort ediliyor | Backend `sort` query param ekle veya `computed()`'a taşı |
| HIGH-FE-006 | `settings.component.ts` | 179-214 | SMB şifresi component state'inde plaintext; Angular DevTools'ta görünür | Şifreyi state'te tutma; ayrı input alanı ve gönderimden sonra temizle |
| HIGH-FE-007 | `schedule-form.component.ts` | 476 | `safeToIso()` geçersiz tarihte throw ediyor; `submit()` try/catch içermiyor | `safeToIso` çağrılarını try/catch ile sarmala |
| HIGH-FE-008 | `schedule-form.component.ts` | 303-310 | Kanal/lig/schedule getirme çağrıları `error` handler içermiyor | Her `subscribe`'a `error` callback ekle |
| HIGH-FE-009 | `schedule-detail.component.ts` | 116 | `Number(route.snapshot.params['id'])` `NaN` kontrolü yok | `if (!Number.isFinite(id))` doğrula |
| HIGH-FE-010 | `ingest-list.component.ts`, `schedule-list.component.ts`, `schedule-reporting.component.ts` | çeşitli | `new Date(\`${dateValue}T00:00:00+03:00\`)` sabit kodlanmış timezone | `environment.utcOffset` kullan veya `Intl.DateTimeFormat` ile türet |
| HIGH-FE-011 | `app.routes.ts` | çocuk route'lar | `canActivate` lazy-load'ı koruyor ama çocuk route'lar korunmasız kalabilir | Tüm çocuk route'lara `canActivateChild: [AuthGuard]` ekle |

### Infra / DB / Docker (HIGH)

| ID | Dosya | Açıklama | Öneri |
|----|-------|----------|-------|
| HIGH-INF-001 | `docker-compose.yml` (tüm servisler) | CPU/memory limit yok; runaway container tüm host'u tüketebilir | `deploy.resources.limits` ekle (API 1g, Worker 1g, Postgres 2g vb.) |
| HIGH-INF-002 | `docker-compose.yml` (tüm servisler) | Docker log rotation yok; disk dolabilir | `logging: driver: json-file, max-size: 100m, max-file: 3` |
| HIGH-INF-003 | `docker-compose.yml:90` | `KC_HTTP_ENABLED: "true"` plain HTTP; token'lar şifresiz ağda | `KC_HTTP_ENABLED: "false"`; TLS reverse proxy kullan |
| HIGH-INF-004 | `docker-compose.yml` | Container'lar arası plain HTTP (API→Postgres, API→RabbitMQ, API→Keycloak); `bcms_net` şifrelenmemiş | PostgreSQL SSL mode (`sslmode=require`), RabbitMQ TLS, Keycloak HTTPS |
| HIGH-INF-005 | `docker-compose.yml`, `infra/postgres/RESTORE.md` | Off-host backup yok; local volume backup host failure'da kaybolur | rsync/S3 sync/borgbackup ile günlük off-host kopya |
| HIGH-INF-006 | `docker-compose.yml`, `schema.prisma` | PgBouncer yok; Prisma doğrudan PG'ye bağlanıyor; burst'te `max_connections` tükenir | `pgbouncer` servisi ekle veya `DATABASE_URL`'ye `connection_limit=20` ekle |
| HIGH-INF-007 | `docker-compose.yml` (postgres) | `archive_mode` kapalı; PITR yok; crash sonrası son backup'tan sonraki data kayıp | `archive_mode = on` + `archive_command` (volume veya S3) |
| HIGH-INF-008 | `docker-compose.yml:261-269` | `mailhog/mailhog` production compose'da; development-only SMTP trap | Ayrı `docker-compose.dev.yml`'e taşı; production'da gerçek SMTP relay |
| HIGH-INF-009 | `infra/postgres/init-multiple-dbs.sh:9-11` | `$database` değişkeni SQL heredoc içinde interpolasyon; enjeksiyon riski (kontrollü input ama) | `psql -v dbname="$database"` + `quote_ident()` kullan |
| HIGH-INF-010 | `schema.prisma:415-439` | `content_entry_categories`, `content_entry_tags`, `workspaces` — ilişkisiz, kullanılmayan modeller | Relation tanımla veya migration ile drop et |
| HIGH-INF-011 | `schema.prisma` | Soft-delete olan modellerde `deleted_at` index yok; sequential scan | `@@index([deleted_at])` veya partial index ekle |
| HIGH-INF-012 | `docker-compose.yml:271-303` | Prometheus (9090) auth yok; Grafana sadece admin password | Prometheus basic auth veya reverse proxy auth ekle |
| HIGH-INF-013 | `docker-compose.yml:254-256` | `opta-watcher` healthcheck `interval`/`timeout`/`retries` eksik; default 30s çok agresif olabilir | `interval: 60s, timeout: 10s, retries: 3` ekle |
| HIGH-INF-014 | `.env.example` | `SKIP_AUTH=true`, `NODE_ENV=development`, zayıf placeholder şifreler (`changeme_*`) | `SKIP_AUTH`'i çıkar; `NODE_ENV=production` yap; `<GENERATE_ME>` placeholder kullan |
| HIGH-INF-015 | `docker-compose.nohost.yml` | Sadece postgres/rabbitmq port override edilmiş; keycloak/web/prometheus/grafana hâlâ açık | Tüm servisler için `!override []` veya `ports: []` ekle |
| HIGH-INF-016 | `docker-compose.yml:77` | `quay.io/keycloak/keycloak:23.0` outdated; CVE-2024-1249, CVE-2024-29857 | Keycloak 25.x/26.x'e upgrade et |
| HIGH-INF-017 | `docker-compose.yml:206-207` | `worker` `depends_on: api` var; API fail → worker fail (cascading) | Worker'dan `api` bağımlılığını kaldır; sadece postgres+rabbitmq yeterli |
| HIGH-INF-018 | `.github/workflows/ci.yml` | Hardcoded zayıf şifreler (`changeme_*`), `SKIP_AUTH=true` CI'da | GitHub Secrets kullan; prod `.env`'de `SKIP_AUTH` olmadığını verify et |
| HIGH-INF-019 | `schema.prisma` | `Schedule` üzerinde 2 redundant GiST exclusion (`_no_overlap` ve `_no_channel_time_overlap`) | `[)` semantik daha doğru olan `_no_channel_time_overlap` kalsın, eski drop edilsin |
| HIGH-INF-020 | `schema.prisma` | `Channel.name`, `League.code`, `StudioPlanProgram.name`, `RecordingPort.name`, `IngestPlanItem.sourceKey`, `ShiftAssignment` unique alanları soft-delete ile çakışıyor | `@@unique([field, deleted_at])` veya partial unique index (`WHERE deleted_at IS NULL`) |

### Shared / Config (HIGH)

| ID | Dosya | Açıklama | Öneri |
|----|-------|----------|-------|
| HIGH-SHARED-001 | `types/schedule.ts` | `matchId` DB'de var ama shared `Schedule` interface'inde yok | `matchId?: number \| null;` ekle |
| HIGH-SHARED-002 | `types/common.ts` | `AuditLog.action` sadece `CREATE|UPDATE|DELETE`; Prisma enum `UPSERT|CREATEMANY` da üretiyor | Union'a `UPSERT` ve `CREATEMANY` ekle |
| HIGH-SHARED-003 | `types/booking.ts` | `requestedByName` DB'de yok; sadece `findAll`'da hesaplanıyor ama base tip'te | `BookingListItem extends Booking` ayrı tip oluştur |
| HIGH-SHARED-004 | `types/booking.ts`, `types/ingest.ts` | `updatedAt` Prisma'da `@updatedAt` ama shared type'larda yok | `updatedAt: string;` ekle |
| HIGH-SHARED-005 | `types/schedule.ts` | `UpdateScheduleDto`'da `broadcastTypeId` yok; `CreateScheduleDto`'da var | Ekle veya kasıtlı değilse belgele |
| HIGH-SHARED-006 | `types/rbac.ts` | `PERMISSIONS` haritasında `users`, `broadcastTypes`, `opta` domain'leri eksiz; route'lar yanlış domain kullanıyor | Yeni domain'ler ekle ve route'ları güncelle |
| HIGH-SHARED-007 | `types/rbac.ts` | `JwtPayload.email` zorunlu `string`; Keycloak servis hesaplarında eksik olabilir | `email?: string` yap veya runtime guard ekle |

---

## 5. 🟡 MEDIUM Bulgular

### API Backend (MEDIUM)

| ID | Dosya | Açıklama | Öneri |
|----|-------|----------|-------|
| MED-API-001 | `package.json` | `exceljs@^4.4.0` → vulnerable `uuid` (<14.0.0) [GHSA-w5hq-g745-h8pq] | `exceljs` upgrade veya `uuid` override pin |
| MED-API-002 | `opta.smb-config.ts:35-42` | SMB şifresi `~/.bcms-opta-config.json`'de plaintext (chmod 600 ama yine de) | `crypto` ile şifrele veya OS keyring kullan |
| MED-API-003 | `opta.watcher.ts`, `audit-retention.job.ts`, `bxf.watcher.ts`, `ingest.watcher.ts` | `setInterval`/`setTimeout`/`chokidar.watch` shutdown'ta temizlenmiyor | Timer/watcher ref'lerini sakla; `onClose` hook'ta temizle |
| MED-API-004 | `bxf.watcher.ts:142-166` | Hard delete + create transaction yok; `bxfEventId` duplicate riski | Her event'i `$transaction` içine al veya upsert kullan |
| MED-API-005 | `schedule.schema.ts` | `updateScheduleSchema`'da `endTime > startTime` refine yok | Conditional refine ekle |
| MED-API-006 | `booking.schema.ts` | `updateBookingSchema`'da `scheduleId \|\| taskTitle` requirement yok | Conditional refine ekle |
| MED-API-007 | `ingest.routes.ts:30-47` | `callbackSchema.jobId: z.number().int()` ama `.positive()` yok; 0 veya negatif geçer | `z.number().int().positive()` yap |
| MED-API-008 | `signal.routes.ts:49-61` | `take: 360` sabit; daha sık telemetry'de overflow | Query'ye hard `LIMIT` ekle veya `take`'i dinamik hesapla |
| MED-API-009 | `booking.service.ts:327-335` | Import edilen bookings `userGroup` undefined; non-admin filter `userGroup: { in: visibleGroups }` null'ları exclude ediyor | Default `userGroup` ata veya filter'a null ekle |
| MED-API-010 | `schedule.import.ts:183` | `metadata: { importTitle: headerTitle } as never` gereksiz ve tehlikeli cast | `as Prisma.InputJsonValue` veya cast kaldır |
| MED-API-011 | `playout.routes.ts:215-221` | `tcNow` frame calculation hardcoded 25fps (`/40`) | Frame rate'i env variable yap |
| MED-API-012 | `ingest.routes.ts` | Callback handler 3 ayrı DB çağrısı; transaction yok | Tek `$transaction` içine al |
| MED-API-013 | `ingest.routes.ts` | `ingestJob.create` + `ingestPlanItem.updateMany` transaction'sız | `$transaction` ile sarmala |
| MED-API-014 | `ingest.routes.ts` | `decodeURIComponent(params.sourceKey)` bozuk encoding'de `URIError` | try/catch ile sarla; 400 dön |
| MED-API-015 | `ingest.routes.ts` | Yorum "ingest-plan source only" ama kod `sourceType` kontrolü yapmıyor | Kontrol ekle veya yorumu güncelle |
| MED-API-016 | `opta.routes.ts` | `$queryRaw` `ANY(${FEATURED})` array cast edilmeyebilir | `ANY(${FEATURED}::text[])` yaz |
| MED-API-017 | `opta.routes.ts` | `metadata` JSON path ile `optaMatchId` filtreleniyor; AGENTS.md metadata JSON filtrelemeyi obsolete sayıyor | `Schedule` tablosuna `optaMatchId` kolonu ekle |
| MED-API-018 | `users.routes.ts` | `location` header `split('/').pop()!` ile ID çıkarılıyor; bozuksa empty string | Header'ı doğrula; eksikse 500 fırlat |
| MED-API-019 | `users.routes.ts` | Keycloak'da kullanıcı oluşturulup grup ataması fail ederse rollback yok | Compensating transaction: grup fail ise kullanıcıyı sil |
| MED-API-020 | `opta.parser.ts` | `fs.openSync` fd, `fs.readSync` hata verirse kapatılmıyor | `try/finally` ile `fs.closeSync(fd)` garantile |
| MED-API-021 | `booking.service.ts` | Import loop her satır için `schedule.findUnique` + create; batch yok | `createMany` veya transaction içinde toplu işle |
| MED-API-022 | `notifications/notification.consumer.ts` | SMTP transport startup'ta `transport.verify()` yok | `verify()` ekle ve sonucu logla |
| MED-API-023 | `app.ts` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` production zorunlu env listesinde yok | `validateRuntimeEnv()`'e ekle |
| MED-API-024 | `prisma.ts` | `pool_timeout=20` çok uzun; HTTP isteği 20sn DB bağlantısı bekleyebilir | `pool_timeout=5` yap |
| MED-API-025 | `rabbitmq.ts` | `RABBITMQ_OPTIONAL=true` veya `NODE_ENV !== 'production'`'da hata yutuluyor | Prod'da optional kaldır; FATAL log at |

### Web Frontend (MEDIUM)

| ID | Dosya | Açıklama | Öneri |
|----|-------|----------|-------|
| MED-FE-001 | `studio-plan-report.component.ts:221` | `totalMinutes = () => this.rows().reduce(...)` plain method; her change detection'da recalc | `computed(() => ...)` yap |
| MED-FE-002 | `schedule-list.component.ts`, `booking-list.component.ts`, `users-list.component.ts` | `afterClosed().subscribe()` parent destroy'dan önce dialog kapanmazsa subscription kalıyor | `takeUntilDestroyed()` ekle |
| MED-FE-003 | `app.config.ts:55` | `importProvidersFrom(KeycloakAngularModule)` legacy; standalone provider var | `provideKeycloak(...)` veya standalone eşdeğerini kullan |
| MED-FE-004 | `ingest-list.component.ts` | Native `<input type="time">` ve `<mat-select>` label/aria-label yok | `aria-label` ekle veya `<mat-form-field>` + `<mat-label>` kullan |
| MED-FE-005 | `environments/environment.ts` | `skipAuth: true` dev backdoor; build pipeline hatasında prod'a sıçrayabilir | Runtime guard: `skipAuth && hostname !== 'localhost'` ise throw |
| MED-FE-006 | `ingest-list.component.ts`, `schedule-reporting.component.ts` | `TrDateAdapter` iki yerde tanımlı (code duplication) | `app/core/adapters/` altına tek tanım koy ve reuse et |
| MED-FE-007 | `schedule-form.component.ts:324-328` | `onTabChange` tab 1'de `loadOptaCompetitions()`; hızlı tab switch → paralel istekler | Loading flag (`optaCompsLoading`) veya `exhaustMap` kullan |
| MED-FE-008 | `schedule-list.component.ts:1061` | `forkJoin(requests)` 50 match seçilirse 50 paralel POST; batching yok | Chunked `forkJoin` (örn. 5'erli) veya `concatMap` kullan |
| MED-FE-009 | `studio-plan.component.ts:111` | `STUDIO_EDIT_GROUPS` kontrolünü merkezi `hasGroup()` yerine kendisi tekrar ediyor | `core/auth`'e `hasGroup()` utility koy ve reuse et |
| MED-FE-010 | `schedule-list.component.ts:2107-2115` | `environment.skipAuth` true ise `_userGroups.set([GROUP.SystemEng])` | Runtime guard ekle (MED-FE-005 ile aynı) |
| MED-FE-011 | `booking-list.component.ts:417-420` | Aynı `skipAuth` bypass deseni | Runtime guard |
| MED-FE-012 | `users-list.component.ts:420-431` | `toggleEnabled` PATCH + optimistic UI; hızlı tıklama → paralel istek | İstek uçuşdayken toggle'ı disable et |
| MED-FE-013 | `ingest-list.component.ts:244-245` | `source-pill` sadece renk; ekran okuyucu ayırt edemiyor | `aria-label` + kontrast ekle |
| MED-FE-014 | `ingest-port-board.component.ts:46-49` | Zoom butonları sadece CSS class; `aria-label` yok | `aria-label="Zoom sıkı"` vb. ekle |
| ❌ MED-FE-015 | `audit-log.component.ts:96-99` | ~~`filterEntityId` input `aria-label` yok~~ — **YANLIŞ POZİTİF (2026-05-04 doğrulamada):** `<mat-label>Kayıt ID</mat-label>` zaten var; matInput otomatik `aria-labelledby` ekler | Kaldırılmalı |
| ❌ MED-FE-016 | `mcr-panel.component.ts:350-351` | ~~`setInterval` `ngOnDestroy`'da temizleniyor ama hızlı create/destroy gap var~~ — **YANLIŞ POZİTİF (2026-05-04):** Standart Angular pattern; component lifecycle tek thread, race yok | Kaldırılmalı |
| MED-FE-017 | `schedule-form.component.ts:382-390` | `onOptaMatchSelect` string üretip `submit()`'ta `new Date(value)`; DST kayması | API'den ISO string al; sadece görüntüleme için formatla |

### Infra / DB / Docker (MEDIUM)

| ID | Dosya | Açıklama | Öneri |
|----|-------|----------|-------|
| MED-INF-001 | `schema.prisma:247-264` | `QcReport` `updatedAt` yok | `updatedAt DateTime @updatedAt @map("updated_at")` ekle |
| MED-INF-002 | `infra/postgres/RESTORE.md` | Backup `.sql.gz` extension ama gerçekte gzip değil | Backup sidecar'ı gerçekten gzip'le veya extension `.sql` yap |
| MED-INF-003 | `docker-compose.yml:131,189,245` | `OPTA_SYNC_SECRET`, `OPTA_WATCHER_API_TOKEN`, `BCMS_API_TOKEN` aynı env variable | Ayrı secret'lar kullan; bağımsız rotate |
| MED-INF-004 | `app.ts:232` | Healthcheck `prisma.$queryRaw\`SELECT 1\`` raw SQL; AGENTS.md tutarlılık | `prisma.auditLog.count({ take: 1 })` gibi typed query kullan |
| MED-INF-005 | `docker-compose.nohost.yml` | `!override` tag Docker Compose 2.24+ gerektirir | `ports: []` syntax veya min version belgele |
| MED-INF-006 | `docker-compose.yml:55,273,289` | `rabbitmq:3.12-management`, `prom/prometheus:v2.53.1`, `grafana/grafana:11.1.0` outdated | Aylık image güncelleme cadence oluştur |
| MED-INF-007 | `docker-compose.yml:224`, `nginx.conf:59-62` | Web healthcheck `localhost/health` nginx API'ye proxy ediyor; API down → web unhealthy | Nginx'de statik `/health` endpoint ekle |
| MED-INF-008 | `infra/postgres/init-multiple-dbs.sh` | Dosya permissions `664` (çalıştırılabilir değil) | `chmod +x` yap |

### Shared / Config (MEDIUM)

| ID | Dosya | Açıklama | Öneri |
|----|-------|----------|-------|
| MED-SHARED-001 | `types/studio-plan.ts` | `StudioPlanSlot` `planId` eksik; `day: string` DB ile (`dayDate DateTime`) uyuşmuyor | `StudioPlanSlot` ve `StudioPlanSlotEntity` olarak ayır |
| MED-SHARED-002 | `types/match.ts` | `Match` interface'inde `optaUid?: string \| null` eksik | Ekle |
| MED-SHARED-003 | `types/match.ts` | `League` interface'inde `metadata`, `createdAt`, `updatedAt` eksik | Ekle |
| MED-SHARED-004 | `types/channel.ts` | `Channel` interface'inde `updatedAt: string` eksik | Ekle |
| MED-SHARED-005 | `types/rbac.ts` | `PERMISSIONS.bookings.read/write/delete` hepsi `[]` (boş) → `requireGroup(...[])` her authenticated user | Açık grup listesi tanımla veya belgele |
| MED-SHARED-006 | `types/rbac.ts` | `JwtPayload.email` zorunlu (HIGH-SHARED-007 ile aynı) | `email?: string` yap |
| MED-SHARED-007 | `types/studio-plan.ts` | Web app kendi tip setini tanımlıyor; `@bcms/shared` ile kayma riski | Yerel tipleri shared ile hizala veya shared'e taşı |

---

## 6. 🟢 LOW Bulgular

### API Backend (LOW)

| ID | Dosya | Açıklama | Öneri |
|----|-------|----------|-------|
| LOW-API-001 | `users.routes.ts`, `booking.service.ts`, `weekly-shift.routes.ts` | Keycloak response `kcFetch<any[]>` | Strict interface tanımla |
| LOW-API-002 | `plugins/audit.ts` | Prisma extension `any` kullanımı (runtime API sınırı) | `unknown` + guard veya Prisma generic types |
| LOW-API-003 | `plugins/auth.ts:72` | `secret` callback `token: any` | FastifyJWT tipini kullan |
| 🔄 LOW-API-004 | `schedule-list.component.ts:2070` | ~~Admin auto-augment dead code~~ — **ZATEN ÇÖZÜLDÜ:** Aynı gün commit `feed1d3` ile düzeltildi (2026-05-01 03:37). Gerçek kod zaten `this._userGroups.set(groups);` (kategori yanlış: bu satır frontend kodu, LOW-FE'ye taşınmalı) | Kaldırılmalı / Section 9'a taşı |
| LOW-API-005 | `users.routes.ts` | `PERMISSIONS.auditLogs.read` users CRUD'da kullanılıyor (namespace overload) | `PERMISSIONS.users.*` ekle |
| LOW-API-006 | `middleware/audit.ts` | `writeAuditLog` hiç import edilmiyor; ölü dosya | Kaldır |
| LOW-API-007 | `utils/prisma-json.ts` | `asPrismaJson` hiç kullanılmıyor; ölü dosya | Kaldır |
| LOW-API-008 | `booking.service.ts` | `remove()` metodu hiç çağrılmıyor; route `removeForRequest()` kullanıyor | Kaldır |
| LOW-API-009 | `plugins/auth.ts` | `isAdminPrincipal` `'Admin'` string hardcode (AGENTS.md ihlali) | `GROUP.Admin` constant kullan |
| LOW-API-010 | `plugins/auth.ts` | `DEV_USER` `['SystemEng']` hardcode | Constant kullan veya belgele |
| LOW-API-011 | `app.ts` | `rateLimit` key generator `x-real-ip`'i `as string` cast; array olabilir | `Array.isArray` kontrolü ekle |
| LOW-API-012 | `plugins/auth.ts` | JWKS fetch/network hatası her durumda 401; altyapı hatası 503 olmalı | 503/401 ayrımı yap |
| LOW-API-013 | `schedule.service.ts` | `updateMany` `broadcastTypeId` içermiyor | Kasıtlı mı doğrula |
| LOW-API-014 | `schedule.export.ts` | `getDate()`, `getMonth()`, `getHours()` yerel zaman kullanıyor | `toLocaleString('tr-TR', {timeZone:'Europe/Istanbul'})` |
| LOW-API-015 | `playout.routes.ts` | `new Date(q.date)` UTC parse edip `setHours(0,0,0,0)` yerel zamana çeviriyor | İstanbul zamanında explicit oluştur |
| LOW-API-016 | `matches/match.routes.ts` | `buildLabel` yerel zaman kullanıyor | Timezone-aware formatla |
| LOW-API-017 | `audit-retention.job.ts` | `setTimeout`/`setInterval` `.unref()` yok | `.unref()` ekle |
| LOW-API-018 | `opta.watcher.ts` | İki `setInterval` başlatılıyor; shutdown'ta temizlenmiyor | Handle sakla ve `onClose`'da temizle |
| LOW-API-019 | `channels/channel.routes.ts` | `createChannelSchema.partial().parse(...)` cast ediliyor | `updateChannelSchema` tanımla |
| LOW-API-020 | `ingest.routes.ts` | `dateSchema.parse(from)` iki kez parse | Birini kaldır |
| ❌ LOW-API-021 | `ingest.routes.ts` | ~~`safeEqual` string olmayan input alırsa `Buffer.from(undefined)` patlar~~ — **YANLIŞ POZİTİF (2026-05-04):** TS imza string zorluyor; tek çağrı yerinde falsy guard zaten var. Patlama yolu yok | Kaldırılmalı veya defensive guard önerisi olarak yeniden yazılmalı |
| LOW-API-022 | `signals/signal.routes.ts` | `+(Math.random() * 1e-6).toExponential(2) as unknown as number` gereksiz cast | Cast'i kaldır |
| LOW-API-023 | `ingest.worker.ts` | `ffmpeg.setFfmpegPath(...)` import anında global state değiştiriyor | Startup fonksiyonuna taşı |
| LOW-API-024 | `plugins/metrics.ts` | Sayaç `Number.MAX_SAFE_INTEGER` aşabilir (teorik) | `BigInt` veya startup'ta resetle |
| LOW-API-025 | `opta.smb-config.ts` | SMB şifresi `~/.bcms-opta.cred`'e yazılıyor; home shared volume olabilir | Konteyner home'unun shared mount olmadığını doğrula |
| LOW-API-026 | `users.routes.ts` | `groupIdMapCache` 5dk TTL; Keycloak grup değişikliği bu pencerede etkisiz | Admin flush endpoint veya daha kısa TTL |

### Web Frontend (LOW)

| ID | Dosya | Açıklama | Öneri |
|----|-------|----------|-------|
| LOW-FE-001 | `schedule-list.component.ts`, `ingest-list.component.ts` | Inline CSS bloat (~1000 ve ~500 satır) | `.scss` dosyalarına taşı |
| LOW-FE-002 | `schedule-list.component.ts` | Mixed tabs/spaces inline CSS | Prettier/stylelint çalıştır |
| LOW-FE-003 | `booking-list.component.ts:342` | `visibleGroups = computed(() => this.groups());` gereksiz | `groups()` doğrudan kullan |
| LOW-FE-004 | `weekly-shift.component.ts:447-458` | `shiftCellDisplay` private method hiç çağrılmıyor | Kaldır |
| LOW-FE-005 | `channel-list.component.ts:40-44` | Hata sessizce `channels.set([])`; kullanıcı bildirimi yok | `MatSnackBar` mesajı göster |
| LOW-FE-006 | `settings.component.ts:199,207-208` | SMB password masking `********` string karşılaştırmasına dayanıyor | `passwordChanged` boolean flag kullan |
| LOW-FE-007 | `documents.component.ts`, `provys-content-control.component.ts` | Stub component; hiçbir işlev yok | Route guard veya feature flag ile gizle |
| ❌ LOW-FE-008 | `ingest-list.component.ts`, `audit-log.component.ts` | ~~Bazı `@for` loop'larda `trackBy` eksik~~ — **YANLIŞ POZİTİF (2026-05-04):** Modern `@for` syntax track'i zorunlu kılar; `ingest-list` 10/10 ve `audit-log` 3/3 zaten track içeriyor | Kaldırılmalı |
| LOW-FE-009 | `auth.guard.spec.ts` | Mock object'lerde `as any` kullanımı | Proper mock veya `jasmine.createSpyObj` |
| LOW-FE-010 | `api.service.ts` | `getBlob` `Content-Disposition` parse etmiyor | `{ blob, filename }` dönüş tipi ekle |

### Infra / DB / Docker (LOW)

| ID | Dosya | Açıklama | Öneri |
|----|-------|----------|-------|
| LOW-INF-001 | `.env.example` | Password pattern'ler (`changeme_*`) Git'te | `<GENERATE_STRONG_SECRET>` yap |
| LOW-INF-002 | `infra/docker/web.Dockerfile` | `USER` directive yok; nginx master root olarak çalışıyor | `USER nginx` ekle veya unprivileged image kullan |
| LOW-INF-003 | `ops/systemd/*.service` | `WorkingDirectory` `/home/ubuntu/Desktop/bcms` hardcode | `%h/Desktop/bcms` veya env file kullan |
| LOW-INF-004 | `ops/systemd/bcms-api-dev.service` | `SKIP_AUTH=true` baked into systemd | Kaldır; sadece `.env`'den yükle |
| LOW-INF-005 | `docker-compose.yml` | Config volume'lar read-write; sadece read gerekir | `:ro` ekle (keycloak import, prometheus config) |
| LOW-INF-006 | `infra/docker/nginx.conf:8` | `client_max_body_size 10m`; büyük ingest/Excel 413 verebilir | `100m` yap veya env'den configurable yap |
| LOW-INF-007 | `docker-compose.yml` | `mailhog` localhost'a bind ama hâlâ production compose'da | Kaldır (HIGH-INF-008 ile aynı) |

### Shared / Config (LOW)

| ID | Dosya | Açıklama | Öneri |
|----|-------|----------|-------|
| LOW-SHARED-001 | `packages/shared/dist/` | Eski build artifact'ları (`errors.js`, `constants.js`) kaynak dosyası olmayan kalıntılar | Temizle ve rebuild yap |

---

## 7. ℹ️ INFO — Olumlu Gözlemler

### API Backend
- ✅ Prisma parameterized queries — tüm `$queryRaw` tagged template literal kullanıyor; SQL injection yok.
- ✅ JWT RS256 + JWKS endpoint; `cache: true, rateLimit: true`.
- ✅ Timing-safe secret comparison (`crypto.timingSafeEqual`) `INGEST_CALLBACK_SECRET` ve `OPTA_SYNC_SECRET` için.
- ✅ Group-based auth centralized; `PERMISSIONS` map kullanımı yaygın; hardcoded group string yok (route'lerde).
- ✅ Optimistic locking `Schedule` + `Booking` için doğru uygulanmış; `version` + `If-Match`.
- ✅ DB-level GiST exclusion constraints (schedules channel/time overlap, ingest port/time overlap).
- ✅ `SKIP_AUTH=true` production'da `validateRuntimeEnv()` + `authPlugin` tarafından engelleniyor.
- ✅ TODO/FIXME comment yok — code hygiene mükemmel.
- ✅ Type check temiz (`npx tsc --noEmit` exit 0).

### Web Frontend
- ✅ Signals-first mimari yaygın; `signal()` + `computed()` doğru kullanılmış.
- ✅ Lazy loading tutarlı; tüm feature route'lar `loadComponent`/`loadChildren`.
- ✅ Auth interceptor 30sn redirect throttling; infinite reload loop engellenmiş.
- ✅ XSS mitigation print/PDF export'lerde (`escapeHtml` veya eşdeğeri).
- ✅ Group-based authorization centralized; `hasGroup()` helper Admin bypass pattern tutarlı.
- ✅ `ApiService.patch` optimistic locking `If-Match` header destekliyor.

### Infra / DB / Docker
- ✅ Non-root container users: API (`fastify` uid 1001), opta-watcher (`opta`).
- ✅ Healthcheck'ler: Postgres, RabbitMQ, Keycloak, API, Web, Opta-Watcher (Worker hariç).
- ✅ Restart policy: `unless-stopped` tüm servislerde.
- ✅ Backup retention: 7-günlük + 4-haftalık + 6-aylık; restore drill 110→110 OK.
- ✅ Prisma audit extension mandatory; raw SQL write yasak.
- ✅ Multi-stage Docker builds (API + Web).

---

## 8. Runtime & Log Analizi

### Container Durumu (2026-05-01 11:35)

| Container | Durum | Sağlık | Not |
|-----------|-------|--------|-----|
| `bcms_api` | Up 8h | Healthy | `127.0.0.1:3000` |
| `bcms_worker` | Up 8h | N/A (healthcheck disable) | ⚠️ |
| `bcms_web` | Up 8h | Healthy | `0.0.0.0:4200` |
| `bcms_postgres` | Up 41h | Healthy | `127.0.0.1:5433` |
| `bcms_keycloak` | Up 22h | Healthy | `0.0.0.0:8080` ⚠️ |
| `bcms_rabbitmq` | Up 36h | Healthy | `127.0.0.1:5673/15673` |
| `bcms_opta_watcher` | Up 22h | Healthy | Process-based |
| `bcms_prometheus` | Up 42h | N/A | `127.0.0.1:9090` |
| `bcms_grafana` | Up 41h | N/A | `127.0.0.1:3001` |
| `bcms_postgres_backup` | Up 13h | Healthy | Daily 03:00 |
| `bcms_mailhog` | Up 41h | N/A | `127.0.0.1:1025/8025` |

### Log Analizi

- **API (bcms_api):** Son 500 satırda `error|warn|fail|exception|fatal|unhandled|crash|timeout` pattern'i **0 eşleşme**. Sistem sessiz ve sağlıklı çalışıyor.
- **Worker (bcms_worker):** Son 500 satırda aynı pattern **0 eşleşme**.
- **Web (bcms_web):** Son 500 satırda **1 adet 404** tespit:  
  `GET /chunk-XID64MNC.js HTTP/1.1" 404 189`  
  Bu, eski bir Angular lazy-loaded chunk dosyasına yapılan istek. Muhtemelen browser cache'inde eski `index.html` veya main chunk referansı var. Angular build artifact'lerinin deploy sonrası cache invalidation'ı kontrol edilmeli.

### Veritabanı Anlık Görüntüsü (Read-Only SELECT)

| Metrik | Değer |
|--------|-------|
| `audit_logs` toplam | ~565,032 satır |
| `audit_logs` son 24h | ~297,541 satır (çok yüksek — burst etkisi) |
| `audit_logs` boyut | ~104 MB |
| `schedules` soft-deleted | 1 satır (`deleted_at IS NOT NULL`) |
| `ingest_plan_items` port atamasız | 3 satır (`port_count=0`, `status=WAITING`) |
| `_prisma_migrations` (DB) | 27 satır (finished) |
| FS migration klasör sayısı | 27 klasör |
| FS no-op placeholder migration | 3 adet (`SELECT 1`) |
| Type check (API) | ✅ `exit 0` |
| Type check (Web) | ✅ `exit 0` |

---

## 9. Çözülmüş / False Positive Bulgular (Önceki Audit'lerden)

| ID | Önceki Rapor | Durum | Not |
|----|--------------|-------|-----|
| CRIT-001 (eski) | RabbitMQ confirm channel yok | ✅ **ÇÖZÜLDÜ** (`acde48e`) | `ConfirmChannel` + `await sendToQueue` |
| CRIT-002 (eski) | Ingest plan race condition | ❌ **FALSE POSITIVE** | DB GiST exclusion (`20260426`) zaten koruyor |
| CRIT-003 (eski) | Auth interceptor token refresh fail → silent send | ✅ **ÇÖZÜLDÜ** (`51306ec`) | `throwError(() => err)` yapılıyor |
| CRIT-004 (eski) | Token refresh interval not cleared | 🟡 **REVİZE** LOW | SPA context'te normal; sadece HMR/test edge case |
| CRIT-005 (eski) | `canEdit` non-reactive | 🟡 **REVİZE** MEDIUM | Token refresh sırasında groups değişmez; risk minimal |
| CRIT-006→009 (eski) | MatDialog/snackbar subscription leak | ❌ **FALSE POSITIVE** | `afterClosed()`/`onAction()` auto-complete observable; RxJS contract |
| CRIT-011 (eski) | Backup yok | ✅ **PARTIAL FIX** (`5f6e728`) | `postgres_backup` sidecar eklendi; **off-host kopya hâlâ yok** |
| CRIT-010 (eski) | Baseline migration yok | 🟡 **PARTIAL FIX** | FS klasör adları/checksum'lar hizalandı (`05829f8`) ama **clean-room replay hâlâ imkansız** (baseline absent) |
| LOW-API-004 (bu rapor) | Admin auto-augment dead code | ✅ **ÇÖZÜLDÜ** (`feed1d3`, 2026-05-01) | `schedule-list.component.ts:2070-2073` artık sade `this._userGroups.set(groups)` |
| (audit'te yok) | `/channels` GET Admin-only; non-Admin schedule dropdown'u boş | ✅ **ÇÖZÜLDÜ** (`ba1ab74`, 2026-05-04) | `/api/v1/channels/catalog` endpoint'i eklendi (JWT-only, minimal projection); audit bu functional gap'i yakalamamıştı |

---

## 10. Önceliklendirilmiş Aksiyon Planı

### Acil (Bu hafta — CRITICAL kapatma)

| # | Aksiyon | Etki Alanı | Tahmini Süre |
|---|---------|------------|--------------|
| 1 | Keycloak port'u `127.0.0.1:8080:8080` yap | `docker-compose.yml` | 2 dk |
| 2 | Web port'u `127.0.0.1:4200:80` yap | `docker-compose.yml` | 2 dk |
| 3 | `realm-export.json`'dan hardcoded credentials bloklarını sil | `infra/keycloak/` | 15 dk |
| 4 | Worker healthcheck'i yeniden etkinleştir (process check veya mini endpoint) | `docker-compose.yml` + worker | 30 dk |
| 5 | Prometheus sahte scrape job'larını kaldır veya exporter ekle | `infra/prometheus/` | 15 dk |
| 6 | Soft-delete stratejisi karar ver (drop vs universal filter) | Prisma schema + tüm servisler | 2-3 saat |
| 7 | `schedule-list` ve `ingest-list` god component'lerini parçala | Web frontend | 4-8 saat |
| 8 | Token refresh `setInterval` leak'i düzelt | `app.config.ts` | 15 dk |

### Yüksek Öncelik (Bu ay)

| # | Aksiyon | Etki Alanı | Tahmini Süre |
|---|---------|------------|--------------|
| 9 | Prisma baseline migration oluştur (clean-room replay) | DB migrations | 2-4 saat |
| 10 | Docker resource limit + log rotation ekle | `docker-compose.yml` | 30 dk |
| 11 | Mailhog'u dev compose'a taşı | `docker-compose.yml` | 15 dk |
| 12 | `.env.example` güvenli default'larla rewrite | `.env.example` | 15 dk |
| 13 | `trustProxy: true` etkinleştir | `app.ts` | 5 dk |
| 14 | Swagger UI'yi production'da gizle veya auth koru | `app.ts` | 10 dk |
| 15 | Keycloak Admin token refresh race condition düzelt | `keycloak-admin.client.ts` | 30 dk |
| 16 | Schedule import timezone bug fix (UTC explicit) | `schedule.import.ts` | 15 dk |
| 17 | Ingest plan conflict check transaction içine al | `ingest.routes.ts` | 30 dk |
| 18 | Audit log loss on handler failure düzelt | `plugins/audit.ts` | 1 saat |
| 19 | OPTA sync payload `max` limiti ekle | `opta.sync.routes.ts` | 5 dk |
| 20 | Email/password Zod validation ekle | `users.routes.ts` | 15 dk |
| 21 | Off-host backup copy implementasyonu (rsync/S3) | `infra/postgres/` + cron | 2-4 saat |
| 22 | Keycloak 23.0 → 26.x upgrade | `docker-compose.yml` | 2-4 saat |
| 23 | Worker `depends_on: api` kaldır | `docker-compose.yml` | 2 dk |

### Orta Öncelik (Sprint planına al)

| # | Aksiyon | Etki Alanı | Tahmini Süre |
|---|---------|------------|--------------|
| 24 | `uuid` vulnerability fix (exceljs upgrade/override) | `package.json` | 15 dk |
| 25 | SMB password plaintext disk encryption | `opta.smb-config.ts` | 1 saat |
| 26 | Report endpoint'lerine pagination/limit ekle | `ingest.routes.ts`, `studio-plan.routes.ts` | 30 dk |
| 27 | Prisma error mesajlarını client'tan gizle | `app.ts` | 15 dk |
| 28 | Background service resource cleanup (timers/watchers) | `opta.watcher.ts`, `bxf.watcher.ts`, `ingest.watcher.ts` | 1 saat |
| 29 | Weekly shift input Zod validation | `weekly-shift.routes.ts` | 30 dk |
| 30 | `::ng-deep` migration (CSS variables / global styles) | Web (çoklu dosya) | 2-3 saat |
| 31 | `totalMinutes` `computed()`'a çevir | `studio-plan-report.component.ts` | 5 dk |
| 32 | `TrDateAdapter` duplicate'ını tekilleştir | Web core adapters | 15 dk |
| 33 | Studio-plan `canEdit` signal pattern'e dönüştür | `studio-plan.component.ts` | 15 dk |
| 34 | `skipAuth` runtime guard ekle (localhost dışında throw) | `app.config.ts`, `auth.guard.ts` | 15 dk |
| 35 | `usageScope` Prisma enum yap (String yerine) | `schema.prisma` | 15 dk |
| 36 | `QcReport` `updatedAt` ekle | `schema.prisma` | 5 dk |
| 37 | `ShiftAssignment.weekStart` `DateTime @db.Date` normalize et | `schema.prisma` | 30 dk |
| 38 | `Booking` + `IngestJob` shared type `updatedAt` ekle | `packages/shared/` | 15 dk |
| 39 | `AuditLog.action` union'ını genişlet (UPSERT, CREATEMANY) | `packages/shared/` | 5 dk |
| 40 | `Match` duplicate fixture önleme (composite unique) | `schema.prisma` | 15 dk |

### Düşük Öncelik / Refactor (Borç listesi)

| # | Aksiyon | Etki Alanı |
|---|---------|------------|
| 41 | `PERMISSIONS` namespace overload düzelt (users, broadcastTypes, opta) | `packages/shared/` + route'lar |
| 42 | `requestedByName` shared type'tan çıkar (HIGH-SHARED-003) | `packages/shared/` |
| 43 | `matchId`, `optaUid`, `channel.updatedAt` shared type'a ekle | `packages/shared/` |
| 44 | `JwtPayload.email` optional yap | `packages/shared/` |
| 45 | `any` usage cleanup (API + Web) | Tüm proje |
| 46 | Inline styles >50 satır olanları `.scss`'e taşı | Web |
| 47 | `auth.guard.spec.ts` mock type safety | Web test |
| 48 | `ApiService` global error handling + `HttpErrorInterceptor` | Web |
| 49 | Nginx `client_max_body_size` artır (100m) | `infra/docker/nginx.conf` |
| 50 | `infra/postgres/init-multiple-dbs.sh` executable bit + quoting fix | `infra/postgres/` |

---

## 11. Sonuç & Risk Değerlendirmesi

**BCMS, kod mimarisi açısından production-ready bir temele sahiptir.** Auth, audit, optimistic locking, Prisma parameterized queries, timing-safe secret comparison ve group-based RBAC doğru uygulanmıştır. Type-check temizdir. Container'lar sağlıklı çalışmaktadır.

**Büyük risk alanları:**
1. **Altyapı güvenliği** — Docker Compose'da network exposure, hardcoded şifreler, resource limit yokluğu, log rotation yokluğu.
2. **Veritabanı operasyonel süreklilik** — migration baseline kaybı, off-host backup yokluğu, WAL/PITR yokluğu, worker healthcheck devre dışı.
3. **Veri bütünlüğü** — soft-delete stratejisi yokluğu, uygulama katmanı TOCTOU race'leri (DB constraint ile kısmen mitigate), audit log loss scenario.
4. **Frontend teknik borç** — god component'ler, `::ng-deep`, inline CSS bloat, accessibility eksiklikleri.
5. **Opservabilite** — Prometheus sahte hedefler, Grafana/Prometheus auth yokluğu, API log retention yokluğu (burst root cause analizi imkansız).

**Önerilen Yaklaşım:**
- **Hafta 1:** CRITICAL'ları kapat (port binding, realm-export credentials, worker healthcheck, Prometheus cleanup).
- **Hafta 2-3:** HIGH infra fix'leri (resource limits, log rotation, Keycloak upgrade, `.env.example` rewrite, `trustProxy`).
- **Sprint:** HIGH kod fix'leri (timezone, transaction, audit flush, baseline migration).
- **Sprint:** MEDIUM dedupe + observability (OPTA sync dedupe, Prometheus metrics, alert rules).
- **Q2 Refactor:** God component decomposition, soft-delete strategy implementation, shared type sync.

---

*Bu rapor tamamen read-only modda hazırlanmıştır. Hiçbir dosya, kod satırı, veritabanı kaydı, Docker container durumu veya yapılandırma değiştirilmemiştir. Tüm aksiyon kararları kullanıcıya/ekibe bırakılmıştır.*

---

## 12. Açık Riskler — State Tracking (eski `BCMS_AUDIT_REPORT_2026-05-01.md`'dan birleştirildi)

> **Status legend**: 🔴 açık · 🟡 partial · ✅ kapatıldı

Bu bölüm, paralel sürdürülen state-tracker raporundan (2026-05-04'te bu rapora birleştirilip silindi) kalan iteratif kapatma izlemelerini içerir. Bulgu ID'leri orijinal state-tracker'a aittir (HIGH-001/002/003, MED-001/005, LOW-1) ve bu raporun ana bulgu numaralandırmasıyla **uyuşmaz** — state-tracker farklı bir granülerlikte çalışmıştı.

### HIGH-001 — Migration baseline-absent 🔴

**Sorun:** Clean PG'ye replay edildiğinde ilk migration (`20260416000000_add_matches`) "relation 'schedules' does not exist" hatasıyla fail oluyor. `add_matches` migration'ı `matches` tablosunu CREATE ederken aynı zamanda `schedules` ve `bookings`'e `match_id` kolonu ALTER ediyor — bu tablolar lokal DB'de 2026-04-22 baseline'ında yaratıldı, baseline DDL'i FS'te yok.

**Status:** FS-name drift ✅ `05829f8` ile kapatıldı (FS=DB=27); core baseline-absent 🔴 hâlâ açık.

⚠️ **Test kalitesi notu:** Clean-room replay testinde `btree_gist` extension manuel olarak inject edildi. Gerçek fresh env'de extension yok varsayımıyla replay denenmeli; extension migration içinde olmalı (`CREATE EXTENSION IF NOT EXISTS btree_gist`).

**Etki matrisi:**
| Senaryo | Etki |
|---|---|
| Mevcut prod | ✅ Çalışıyor (DDL'ler zaten DB'de) |
| Postgres backup → restore (DR) | 🟡 Code-level safe; DR güvencesi ancak off-host kopya + drill ile |
| CI/CD clean-build | ❌ Replay fail |
| Fresh dev env | ❌ Replay fail |
| Staging provisioning | ❌ Replay fail |

**Design doc:** `ops/REQUIREMENTS-MIGRATION-BASELINE.md` (`2e2b6a4`) — measurement-first strategy selection, decision-ready / implementation-scoped. Naive `pg_dump --schema-only` → `000_baseline` çözümü duplicate constraint/index/sequence hataları üretir; doğru tasarım clean-room replay harness ile A vs B prototype karşılaştırması gerektirir.

### OPS-CRITICAL — Off-host backup yok 🔴

**Sorun:** `postgres_backup` sidecar (commit `5f6e728`) günlük 03:00'te local Docker volume'a pg_dump alıyor. Off-site/off-host kopya yok.

**Etki:** Disk arızası / host kaybı / ransomware / dosya sistemi corruption → hem prod hem backup birlikte kaybolur. 1-7 gün arası tüm veri kayıp.

**Mevcut korumanın kapsamı:**
- ✅ Yanlışlıkla DROP TABLE / silme / mantıksal hata için 7-gün lookback
- ✅ DB corruption recovery
- ❌ Disk/host failure için **KORUMA YOK**

**Severity rasyonalitesi:** "Tam OPS-CRITICAL" değil çünkü backup VAR. "Tam OK" değil çünkü kapsam dar (host'a bağımlı). **Aday** sınıfı: yarım mitigation, mitigation tamamlanırsa CRITICAL'dan düşer.

**Design doc:** `ops/REQUIREMENTS-S3-BACKUP.md` (`9925422`) — S3-compatible provider matrix (MinIO / B2 / AWS S3 / Wasabi / R2), retention/encryption/sync-tool kararları, decision-ready / implementation-scoped (credential + provider seçimi bekliyor).

### HIGH-002 — Doc drift ✅ KAPATILDI

**Status:** ✅ **Kapatıldı** (`feed1d3` ilk büyük kısmı + `90c8779` kalan sweep). Live verify: 0 stale hit (Pattern A/B/C/D/E/F sweep, README + ops/README + ops/NOTES_FOR_CODEX).

**Yapısal eklenti:** `ops/NOTES_FOR_CODEX.md`'a "SystemEng Yetki Kapsamı — Canonical Tablo" eklendi; sekme bazında SystemEng yetkileri tek kaynaktan okunabilir.

### HIGH-003 — OPTA League upsert burst observability 🟡

**Geçmiş olay:** 2026-04-30 saat 00:00–09:30 arası ~9.5 saatlik burst. Saatte ~31k league upsert (~528/dakika, ~8.8/saniye). Audit_logs'a ~205k satır (snapshot anında ~%36). Burst içinde League ratio %99.99. Root cause: API log retention yokluğunda caller belirlenemedi.

**Status — detection vs notification ayrımı:**
- **Detection katmanı** ✅:
  - Idempotent UPSERT dedupe `a0946c4`
  - P2002 outer retry `0d67c6e` (`withLeagueCreateConflictRetry`)
  - Metric `bcms_opta_league_sync_total{action="create|update|skip"}` `4e364f3`
  - Alert rules (`infra/prometheus/alerts.yml`):
    - `OptaLeagueSyncBurst`: `sum(increase(...[1h])) > 500`
    - `OptaLeagueWriteBurst`: `sum(increase(...{action=~"create|update"}[1h])) > 200`
- **Notification katmanı** 🔴:
  - **Alertmanager** kurulu değil; firing alert'ler operasyonel alarm üretmiyor
  - Slack/email/PagerDuty webhook routing yok
- **Caller post-mortem** 🔴: API log retention (Loki/Promtail veya json-file rotation) hâlâ kurulmamış

**P2002 retry — canonical desen** (opta.sync.routes.ts'te uygulandı):
```ts
withLeagueCreateConflictRetry(() =>
  fastify.prisma.$transaction(async (tx) => { ... })
)
```
- Outer wrapper ile tüm `$transaction` retry edilir (PG'nin aborted-tx semantiği nedeniyle inline catch çalışmaz)
- `isLeagueCodeUniqueConflict` predicate `meta.target` ile sadece `leagues.code` conflict'ini yakalar
- Max 2 attempt; retry sırasında `findMany` concurrent insert'i görür → leagueMap doğru doldurulur

⚠️ **Inline `try/catch` + `findUniqueOrThrow` ÇALIŞMAZ** — PG aborted-tx state'i nedeniyle. Outer retry zorunlu desen.

**Design doc:** `ops/REQUIREMENTS-NOTIFICATION-DELIVERY.md` (`9be627a`).

### MED-001 — Soft-delete schema redesign 🔴

**Sorun:** 21 tabloda `deleted_at` kolonu var (live: `COUNT(DISTINCT) → 21`); sadece 1 tabloda (`shift_assignments`, `weekly-shift.routes.ts:144`) filter aktif. Diğer 20 tabloda kolonlar görmezden geliniyor. Inventory'de fiili soft-deleted satır sadece 1: `schedules.id=32`.

**Status:** Inventory ✅ tamamlandı. Karar: schema redesign 🔴 ayrı PR.

**Sıralama:**
1. Önce data cleanup decisions (Section 13) — schedules.id=32 + 3 orphan ingest_plan_items decision tamamlanır
2. Audit-traced maintenance pattern netleşir (yeni doğru desen)
3. Schema redesign uygulanır (ayrı tasarım PR'ı, staging dry-run + review)

**Design doc:** `ops/REQUIREMENTS-MAINTENANCE-PATTERN.md` (`cc6d688`) — audit-traced entry-point design (app-booted one-off command), `audit_logs.metadata` schema prerequisite, transaction-aware queue+flush pattern.

---

## 13. Veri Temizliği Bekleyen Kararlar

**Tek prensip:** Production veri yazımı **ancak audit-traced maintenance path netleşince** yapılır. İki kural:
1. Raw SQL `DELETE`/`UPDATE` proje kuralı ihlali (`CLAUDE.md`: tüm yazımlar Prisma audit extension'dan geçmeli)
2. Standalone `new PrismaClient()` script'i de bypass eder; audit-traced olması için app'in `$extends`'li factory chain'i kullanılmalı

### Decision item 1 — `schedules.id=32`

| Alan | Değer |
|---|---|
| Title | "Manchester United - Brentford" |
| Status | DRAFT |
| FK alanları | `channel_id` NULL, `match_id` NULL, booking 0 |
| `deleted_at` | 2026-04-28 09:13:50 (dolu) |
| OPTA bağlantı | `metadata.optaMatchId = "g2562231"` → `matches.id=6305` (gerçek maç) |
| Audit izi | sadece CREATE event (2026-04-21); soft-delete event bulunamadı |
| Mevcut görünürlük | live-plan listesinde görünür (filter yok) |

**Audit izinin yokluğu** ya raw SQL bypass ya audit plugin race ihtimali — kesin değil.

**Karar (defer):** Kanonik aktif kayıt mı, hard delete mi — kullanıcı iş kararı. Audit-traced maintenance pattern netleşince uygulanır. MED-001 schema redesign PR'ı kapsamında.

### Decision item 2 — 3 orphan `ingest_plan_items`

| id | gün | saat | tip | not |
|---|---|---|---|---|
| 54 | 2026-04-25 | 13:30-15:30 | manual | - |
| 107 | 2026-04-26 | 14:30-16:30 | ingest-plan | yedek |
| 108 | 2026-04-26 | 14:30-16:30 | ingest-plan | - |

**Bağlantı kontrolü** (live psql, 0 hit her tabloda):
- `ingest_plan_items.job_id` (orphan satırlarda) → NULL
- `qc_reports` → 0
- `incidents.metadata.sourceKey` → 0
- `ingest_plan_item_ports` → 0

**Karar (defer):** Cascade etki yok. Aynı write-deferred prensibi: audit-traced maintenance pattern + Prisma `deleteMany` üzerinden yapılır (raw SQL DELETE değil). id=32 ile birlikte ele alınır.

---

## 14. Açık Follow-up'lar (Pending iş listesi)

| # | Konu | Bağlam |
|---|---|---|
| 1 | OPTA drift scan PR | `0ed06f9` ve `5ee459b` mesajları: `metadata.optaAppliedMatchDate` field + her sync'te tarama job'u atomik introduction |
| 2 | Backup compression fix | image v0.0.11 quirk (`.sql.gz` aslında plain SQL) |
| 3 | ~~Tekyon /channels permission UX~~ ✅ **ÇÖZÜLDÜ** (`ba1ab74`, 2026-05-04) — `/api/v1/channels/catalog` endpoint'i eklendi |
| 4 | Channel-overlap cascade conflict resolution UX | OPTA cascade conflict yaşadığında kullanıcıya UI'da gösterme |
| 5 | Architecture decoupling | OPTA ingest vs cascade ayrıştırması |
| 6 | Healthcheck eksikleri 🟡 partial | (a) Prometheus + Grafana ✅ kapatıldı (`05fc592`); (b) `bcms_worker` `disable: true` (bilinçli karar, comment ekleme PR'ı bekliyor); (c) **`bcms_opta_watcher` sahte `pgrep` healthcheck** — "(healthy)" sinyali aldatıcı (SMB unmount / password expire'da yine pass). Design doc `ops/REQUIREMENTS-HEALTHCHECK.md` (`13ae22c`). |
| 7 | Restore drill execution | `infra/postgres/RESTORE.md` runbook var, fiili drill kanıtı yok |
| 8 | API log retention (Loki/Promtail) | HIGH-003 ile bağlı, gelecek burst post-mortem için |
| 9 | MED-002 redundant GiST drop | `schedules` tablosunda `_no_channel_time_overlap` ve `_no_overlap` GiST exclusion'ları çakışıyor. Drop migration HIGH-001 baseline-absent çözüldükten sonra eklenmeli |

---

## 15. Doğrulama Komutları (canlı re-check)

```bash
# Migration count (FS-name drift kontrolü)
ls apps/api/prisma/migrations/ | grep -v migration_lock.toml | wc -l

# Audit log durumu
docker exec -i bcms_postgres psql -U bcms_user -d bcms -c "
  SELECT count(*) AS total, pg_size_pretty(pg_total_relation_size('audit_logs')) AS size
  FROM audit_logs;
"

# Container health
docker ps --format "table {{.Names}}\t{{.Status}}"

# Soft-delete kolonu olan tablo sayısı
docker exec -i bcms_postgres psql -U bcms_user -d bcms -c "
  SELECT count(DISTINCT table_name) FROM information_schema.columns
  WHERE column_name='deleted_at';
"

# Schedules.id=32 mevcut durumu
docker exec -i bcms_postgres psql -U bcms_user -d bcms -c "
  SELECT id, title, status, channel_id, match_id, deleted_at FROM schedules WHERE id=32;
"

# Orphan ingest_plan_items
docker exec -i bcms_postgres psql -U bcms_user -d bcms -c "
  SELECT id, day_date, source_type FROM ingest_plan_items
  WHERE id NOT IN (SELECT plan_item_id FROM ingest_plan_item_ports);
"

# RBAC drift sweep (post-90c8779, 0 hit beklenir)
for p in "Admin/SystemEng" "Admin ve SystemEng" "SystemEng.*tam yetki" \
         "SystemEng.*tüm grup" "auto-augment yapıyor" '`Admin`.*`SystemEng`'; do
  echo "=== $p ==="
  grep -nE "$p" README.md ops/README.md ops/NOTES_FOR_CODEX.md || echo "no hits"
done

# Type-check
(cd apps/api && npx tsc --noEmit) && (cd apps/web && npx tsc --noEmit)

# OPTA P2002 retry pattern (kod-level kanıt)
grep -n "withLeagueCreateConflictRetry\|isLeagueCodeUniqueConflict" \
  apps/api/src/modules/opta/opta.sync.routes.ts

# OPTA observability metric + alerts
curl -sf http://127.0.0.1:3000/metrics | grep "bcms_opta_league_sync_total"
curl -sf http://127.0.0.1:9090/api/v1/rules | grep -E "OptaLeague(Sync|Write)Burst"
```

### Snapshot konvansiyonu

Bu raporda canlı sayaçlar (audit_logs total, container Up süresi, FS migration count vb.) **snapshot**'tır — tam-sayı drift eder, doküman bunu reflect etmez. Yaklaşık değer + zaman damgası ile sunulur.

### Static iddialar (drift etmez, sadece kapatılırsa değişir)

- **21 tablo `deleted_at` kolonu** (schema-level)
- **`withLeagueCreateConflictRetry` outer pattern** (kod-level kanıt, opta.sync.routes.ts)
- **3 orphan ingest_plan_items id'leri** (54, 107, 108)
- **schedules.id=32 detayları** (tek soft-deleted satır)
- **27 FS migration / 27 DB migration** (FS-name drift kapalı, baseline-absent ayrı)

---

## 16. Review History

| Tarih | Tur | Yöntem | Çıktı |
|---|---|---|---|
| 2026-05-01 | İlk audit | 12.5 dk, 141 tool çağrısı (read-only) | `d074bcd` initial draft |
| 2026-05-01 | Triage + scope refinement | User feedback iteration | `5e3f238` sayı düzeltmeleri |
| 2026-05-01 | Spot fix turları | 8 commit (`feed1d3`, `05829f8`, vd.) | İncremental fix'ler + 4 placeholder migration directory |
| 2026-05-01 | OPTA P2002 retry | Kod fix + commit | `0d67c6e` `withLeagueCreateConflictRetry` |
| 2026-05-01 | Schedules.id=32 deferral tracking | Section 13 follow-up | `9c8b690` |
| 2026-05-01 | Critical review pass-1/2/3 + rewrite | 32 hata spot-fix + 5-bölümlü sadeleştirme | `faec08e`, `19d3450`, `469967f` |
| 2026-05-01 | RBAC doc final sweep | 6-pattern grep sweep (3 docs) | `90c8779` HIGH-002 ✅ |
| 2026-05-01 | OPTA observability detection | prom-client + metric + 2 alert rule | `4e364f3` HIGH-003 detection ✅ |
| 2026-05-01 | State sync pass | Section 1/2/3 + state güncelleme | `c6dace0` |
| 2026-05-02 | OPTA notification delivery design doc | Alertmanager + routing + secret yönetimi | `9be627a` |
| 2026-05-02 | Audit-traced maintenance pattern design doc | App-booted command + ALS context | `cc6d688` |
| 2026-05-02 | Migration baseline-absent design doc | Measurement-first strategy selection | `2e2b6a4` |
| 2026-05-03 | Cross-ref state sync (4 design docs) | Section 2 her open risk'te design doc pointer | `08802e4` |
| 2026-05-03 | Healthcheck design doc | Per-service health semantiği inventory | `13ae22c` |
| 2026-05-03 | State sync (5th design doc + opta_watcher finding) | Appendix A #6 + closing italic update | `a6c9e67` |
| 2026-05-03 | PR-1 healthcheck implementation (Prom + Grafana) | wget for both + endpoints | `05fc592` |
| 2026-05-03 | State sync (PR-1 reflection) | Appendix A #6 status update — 🟡 partial | `110d1dc` |
| 2026-05-04 | `/channels/catalog` endpoint | Tekyon dropdown 403 fix (Appendix A #3) | `ba1ab74` |
| 2026-05-04 | 189-finding verification | 7 paralel subagent doğrulama; Section 1 sayım düzeltildi | `75c7a93` |
| 2026-05-04 | State tracker merge | `BCMS_AUDIT_REPORT_2026-05-01.md` bu rapora birleştirildi ve silindi | bu commit |

---

## 17. False Positives Önlendi

Bug gibi görünen ama olmayanlar — gelecekteki audit'lerin tekrar tuzağa düşmemesi için belgelendi:

- **`ScheduleService.update` outside-transaction version check**: `findById`'de version'a bakıp 412 atıyor, ardından `tx.updateMany({ where: { id, version } })` ile gerçek lock — ikinci aşama race-safe. Sadece hız iyileştirmesi, bug değil.
- **`audit.ts` worker context phantom audit yazımı**: ALS store yoksa anlık `base.auditLog.createMany`, transaction rollback → audit kalır. Mevcut worker'lar atomic single-step yazıyor; transaction içinde failed write zaten en altta `try/catch` ile recoverable. Risk var ama somut bug üretmedi.
- **`config.ts:41 setInterval` SPA bootstrap'ta clear edilmiyor**: SPA root'ta token refresh için 60sn interval. Browser sekmesi kapanınca GC. Önceki audit'lerde "memory leak" denmişti — yanlış. (Ancak bu audit Section 3'te CRIT-010 olarak yine listeli; HMR/test edge case için teknik gözlem geçerli.)
- **MatDialog `afterClosed()` ve MatSnackBar `onAction()` subscribe'lar**: complete-once observable'lar; auto-teardown var. Önceki audit'te yanlışlıkla CRITICAL listelendi.
- **RabbitMQ reconnect window race**: connection drop → close handler → 5sn sonra reconnect → consumers re-register var. Optional/dev mode'da fallback null-publisher; production'da `RABBITMQ_OPTIONAL=false` zaten throw eder.
- **`/metrics` endpoint auth'sız**: production'da nginx-arkasında, dış dünya görmüyor. Internal Prometheus pull pattern.
- **`opta-watcher` Node service kalıntısı**: `app.ts:122` çağrı var ama worker container env'inde listelenmemiş, runtime'da disabled (logs doğrulandı).

---

*Bu rapor 2026-05-01 read-only audit ile başladı. 2026-05-04'te (a) 189 maddenin 7 paralel subagent ile doğrulanması, (b) state-tracker raporun bu rapora birleştirilmesi sonucunda **tek doğruluk kaynağı** haline geldi. Açık riskler için 5 design doc tamamlandı: S3 backup, OPTA notification, maintenance pattern, migration baseline, per-service healthcheck — hepsi decision-ready / implementation-scoped.*
