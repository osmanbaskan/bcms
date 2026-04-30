# BCMS Kapsamlı Audit & Bug Raporu
**Tarih:** 2026-04-30
**Kapsam:** API, Web Arayüzü, Veritabanı, Altyapı, Docker, Güvenlik, Loglar
**Yöntem:** Read-only kod taraması + runtime log analizi + container durum incelemesi
**Değişiklik yapılmamıştır.**

---

## 1. Özet (Executive Summary)

Sistem genel olarak çalışır durumdadır (10 container healthy). Ancak runtime logları ve kod incelemesi **3 CRITICAL**, **13 HIGH**, **22 MEDIUM** ve **12 LOW** seviyede sorun ortaya koymuştur. En acil eylem gerektiren konular:

1. **OPTA Watcher state persist edemiyor** → Her restart’ta 34.000+ dosya baştan taranıyor.
2. **Ingest List burst polling** → Tarayıcıda memory leak + connection exhaustion riski.
3. **RabbitMQ bağlantı kopması worker’ı crash ediyor** → Uncaught exception sonrası restart.
4. **Prisma migration history tamamlanmamış** → Shadow DB hatası, yeni index/relation migrate edilemiyor.
5. **Frontend’de 0 unit test** → Production broadcast sisteminde test coverage yok.

---

## 2. CRITICAL 🔴 (Sistem Çökmesi / Veri Kaybı / Güvenlik İhlali Riski)

### CR-1: OPTA Watcher — `HOME=/nonexistent` Nedeniyle State Kaydedilemiyor
- **Dosya:** `infra/docker/opta-watcher.Dockerfile` (line 9: `ENV HOME=/data`)
- **Runtime:** `docker exec bcms_opta_watcher env` çıktısı: `HOME=/nonexistent`
- **Açıklama:** Dockerfile’da `ENV HOME=/data` tanımlı olmasına rağmen container çalışma zamanında `HOME=/nonexistent` değerini taşıyor. `adduser --system --no-create-home opta` komutu `/etc/passwd`’de home dizinini `/nonexistent` yapar. `opta_smb_watcher.py` state dosyasını `$HOME/.bcms-opta-watcher-state.json` yoluna yazmaya çalışıyor ve `FileNotFoundError` alıyor.
- **Etki:** Her container restart’ında 34.000+ XML dosyası baştan taranıyor. SMB share üzerinde gereksiz yük, CPU/bant genişliği israfı, watcher response time’ı artıyor.
- **Log Kanıtı:**
  ```
  FileNotFoundError: [Errno 2] No such file or directory: '/nonexistent/.bcms-opta-watcher-state.json'
  ```
- **Öneri:** Dockerfile’da `USER opta`’dan önce `HOME=/data`’yı passwd override olarak ayarla veya `docker-compose.yml`'de `environment: [HOME=/data]` olarak zorla. Image yeniden build edilip deploy edilmeli.

---

### CR-2: Ingest List — Recursive Burst Poll, Sonsuz Subscription Oluşturuyor
- **Dosya:** `apps/web/src/app/features/ingest/ingest-list/ingest-list.component.ts`
- **Satır:** ~957–975 (`startBurstPoll()`)
- **Açıklama:** `interval(10000).pipe(take(6))` subscription’ının `next` handler’ı, data değişirse **tekrar** `startBurstPoll()` çağırıyor. Aktif ingest işlemleri sürekli güncelleniyorsa her poll yeni bir subscription doğurur. Tarayıcı event loop’u ve HTTP connection pool’u tükenir, sekme çöker.
- **Etki:** Browser tab crash, memory leak, API üzerinde DDoS benzeri yük.
- **Öneri:** Recursion kaldırılsın. Tek bir Observable kullanılsın (`exhaustMap` veya `switchMap` ile) ve bounded retry counter eklensin.

---

### CR-3: RabbitMQ Connection Loss → Worker Uncaught Exception → Crash
- **Dosya:** `apps/api/src/plugins/rabbitmq.ts` (line 48–56)
- **Runtime Log:**
  ```
  RabbitMQ connection closed, reconnecting...
  Error: connect ECONNREFUSED 172.18.0.3:5672
  ...
  node:internal/process/promises:391
      triggerUncaughtException(err, true);
  ```
- **Açıklama:** `connection.on('close', ...)` içinde `setTimeout(() => connect(3), 5000)` var. `connect()` fonksiyonu `retries` bittikten sonra `throw err` yapıyor (line 63). Bu throw, bir event handler içinde gerçekleştiği için **uncaught exception** oluyor ve Node.js process’i crash ediyor. Worker container restart edilmiş ama root cause düzeltilmemiş.
- **Etki:** Worker down süresi; background job’lar (notification, ingest, bxf) işlenemiyor.
- **Öneri:** Event handler içinde `throw` yapılmamalı. Bağlantı koparsa exponential backoff ile sınırsız retry veya process graceful shutdown yapılmalı.

---

## 3. HIGH 🟠 (İşlevsellik Bozukluğu / Güvenlik Açığı / Performans)

### HI-1: Studio Plan — Race Condition (Hızlı Tıklamalar)
- **Dosya:** `apps/web/src/app/features/studio-plan/studio-plan.component.ts`
- **Satır:** ~235–257 (`assignProgram()`)
- **Açıklama:** Her hücre tıklaması anında `saveCurrentWeek()` → HTTP PUT gönderiyor. Debounce yok, in-flight request iptali yok. Son tamamlanan request geçerli data üzerine yazıyor.
- **Öneri:** `debounceTime(400)` + `switchMap` ile request cancellasyonu eklenmeli.

### HI-2: Audit Plugin — `user.roles` Yerine `user.groups` Kullanılmalı
- **Dosya:** `apps/api/src/plugins/audit.ts`
- **Satır:** 37–39
- **Açıklama:** `store.userRoles = user.roles;` satırı JWT payload’daki `roles` claim’ini okuyor. Ancak BCMS’te yetkilendirme `groups` claim’i üzerinden yapılıyor (`JwtPayload.groups`). `user.roles` her zaman `undefined` gelir. Audit log’larda kullanıcı rolleri eksik kalıyor.
- **Öneri:** `store.userRoles = user.groups ?? [];` olarak değiştirilmeli.

### HI-3: Rate Limit — `skipOnError: true` Güvenlik Açığı
- **Dosya:** `apps/api/src/app.ts`
- **Satır:** 184
- **Açıklama:** `@fastify/rate-limit` `skipOnError: true` ile yapılandırılmış. Eğer Redis/store bağlantısı hatalı olursa rate limiting tamamen devre dışı kalır.
- **Öneri:** `skipOnError: false` yapılmalı. Store hatası durumunda API 429 yerine 503 dönmeli.

### HI-4: Auth Guard — `keycloak.login()` Reject Edilirse Asılı Kalır
- **Dosya:** `apps/web/src/app/core/guards/auth.guard.ts`
- **Satır:** 24–26
- **Açıklama:** `await this.keycloak.login(...)` try/catch ile sarılı değil. Keycloak erişilemezse Promise reject olur, guard asılı kalır, kullanıcı boş beyaz ekranda kalır.
- **Öneri:** `try/catch` eklensin; hata durumunda `false` dönüp login sayfasına yönlendirilsin.

### HI-5: Auth Interceptor — Token Alınamazsa HTTP Request Ölür
- **Dosya:** `apps/web/src/app/core/interceptors/auth.interceptor.ts`
- **Satır:** 20–28
- **Açıklama:** `from(keycloak.getToken())` reject ederse `catchError` olmadığı için HTTP isteği sessizce ölür. Kullanıcıya hiçbir hata gösterilmez.
- **Öneri:** `catchError` eklenmeli; token alınamazsa login sayfasına yönlendirilmeli.

### HI-6: Schedule Form — Geçersiz Tarih `RangeError` Fırlatır
- **Dosya:** `apps/web/src/app/features/schedules/schedule-form/schedule-form.component.ts`
- **Satır:** 446–448, 453–454
- **Açıklama:** `new Date(v.startTime!).toISOString()` çağrısı kullanıcı geçersiz bir datetime-local girerse `RangeError` fırlatır. Component çöker, kullanıcıya bilgi verilmez.
- **Öneri:** Tarih validasyonu `try/catch` ile sarılmalı veya `isNaN(date.getTime())` kontrolü eklenmeli.

### HI-7: Users List — `toggleEnabled` Hata Handler Eksik
- **Dosya:** `apps/web/src/app/features/users/users-list/users-list.component.ts`
- **Satır:** 420–427
- **Açıklama:** Toggle switch optimistik olarak UI’ı güncelliyor ama `subscribe()`’ta `error` handler yok. API başarısız olursa UI backend ile senkronize kalmıyor.
- **Öneri:** `error` handler eklenip local state geri alınmalı, snackbar gösterilmeli.

### HI-8: Settings — `********` Sentinel Değeri API’ye Gidiyor
- **Dosya:** `apps/web/src/app/features/settings/settings.component.ts`
- **Satır:** 196–205
- **Açıklama:** Şifre alanı save sonrası `'********'` olarak maskeleniyor. Kullanıcı tekrar save yaparsa bu literal string API’ye gönderiliyor. Backend bu sentinel değeri işlemiyorsa gerçek şifre üzerine yazılır.
- **Öneri:** `passwordDirty` flag’i takip edilsin; değiştirilmemişse password field’ı payload’dan çıkarılsın.

### HI-9: OPTA Sync Bombardımanı — Aşırı Yüksek İstek Frekansı
- **Runtime Log:** API loglarında `/api/v1/opta/sync` endpoint’ine saniyede 2–4 istek geliyor.
- **Açıklama:** OPTA watcher veya dışarıdan bir kaynak her saniye senkronizasyon gönderiyor. Her istek Prisma transaction içinde 100 maç kontrol ediyor. DB CPU ve connection pool üzerinde gereksiz yük.
- **Öneri:** OPTA watcher tarafında polling interval artırılmalı (örn. 60s) veya değişiklik tabanlı push mekanizması kullanılmalı.

### HI-10: Channel List — API Hatasında Sessiz Kalma
- **Dosya:** `apps/web/src/app/features/channels/channel-list/channel-list.component.ts`
- **Satır:** 39–40
- **Açıklama:** `ngOnInit`’te HTTP çağrısına `error` handler eklenmemiş. API hata verirse tablo boş kalır, kullanıcı bilgilendirilmez. *(Not: Bu component zaten `<mat-table>` kullanıyor; raporun önceki versiyonundaki "custom table" bulgusu bu dosya için geçersizdir.)*
- **Öneri:** `error` handler ve boş durum mesajı eklenmeli.

### HI-11: Schedule Detail — `as never` Cast + Hata Handler Eksik
- **Dosya:** `apps/web/src/app/features/schedules/schedule-detail/schedule-detail.component.ts`
- **Satır:** 115–117
- **Açıklama:** Response `as never` olarak cast edilmiş (tip güvenliği yok). Ayrıca error handler yok.
- **Öneri:** Cast kaldırılmalı, tip tanımı kullanılmalı, error handler eklenmeli.

### HI-12: Prisma Migration Tarihi Çakışması / Shadow DB Hatası
- **Açıklama:** `npx prisma migrate dev` P3006 hatası veriyor. Migration history’de bazeline (`init`) migration eksik. Live DB’de `deleted_at`, `content_entry_categories`, `content_entry_tags`, `workspaces` gibi schema’da olmayan tablolar/sütunlar var.
- **Etki:** Yeni eklenen relation, index ve cascade delete’ler production DB’ye uygulanamıyor.
- **Öneri:** `prisma db pull` ile mevcut schema baseline’lanmalı, ardından yeni migration oluşturulmalı. Production’da `migrate deploy` öncesi mutlaka yedek alınmalı.

### HI-13: Audit Plugin Tip Güvenliği — `(fastify as any).prisma`
- **Dosya:** `apps/api/src/plugins/audit.ts`
- **Satır:** 147
- **Açıklama:** Tip güvenliği kasıtlı olarak `any` cast ile bypass edilmiş. Fastify instance tipi bozuluyor.
- **Öneri:** `buildAuditExtension`’ın dönüş tipi `PrismaClient` olarak tanımlanmalı ve module augmentation kullanılmalı.

---

## 4. MEDIUM 🟡 (Bakım / Kalite / Erişilebilirlik / Best Practice)

### ME-1: Çoklu Component’te `OnDestroy` Eksik
- **Dosyalar:** `audit-log.component.ts`, `booking-list.component.ts`, `channel-list.component.ts`, `schedule-detail.component.ts`, `schedule-form.component.ts`, `studio-plan.component.ts`, `users-list.component.ts`, `weekly-shift.component.ts`, `studio-plan-report.component.ts`, `settings.component.ts`
- **Açıklama:** Bu component’ler `OnInit` implement ediyor ama `OnDestroy` etmiyor. One-shot HTTP call’lar auto-complete olsa da dialog referansları ve snackbar subscription’ları leak edebilir.
- **Öneri:** `takeUntilDestroyed()` veya `OnDestroy` + `Subscription` cleanup pattern’i uygulanmalı.

### ME-2: Dialog Subscription’ları Cleanup Eksik
- **Dosyalar:** `booking-list.component.ts` (L383), `schedule-list.component.ts`, `users-list.component.ts` (L407–417)
- **Açıklama:** `dialog.open(...).afterClosed().subscribe(...)` subscription’ları explicit temizlenmiyor.
- **Öneri:** `takeUntilDestroyed()` kullanılmalı.

### ME-3: Studio Plan Print — Pencere Çok Erken Kapanıyor
- **Dosya:** `apps/web/src/app/features/studio-plan/studio-plan.component.ts`
- **Satır:** 330–333
- **Açıklama:** `setTimeout(() => { printWindow.print(); printWindow.close(); }, 250)` — `.close()` print dialog’u gösterilmeden kapatıyor.
- **Öneri:** `printWindow.close()` yerine `printWindow.onafterprint = () => printWindow.close()` kullanılmalı; syntax olarak kod temiz ama UX riski var.

### ME-4: Schedule Reporting — `Date | null` Üzerinden `getFullYear()`
- **Dosya:** `apps/web/src/app/features/schedules/reporting/schedule-reporting.component.ts`
- **Satır:** 977–988
- **Açıklama:** `selectedFromDate` `Date | null` tipinde. Null ise `getFullYear()` çağrısı `NaN` üretir. Validation öncesi çağrı yapılıyor.
- **Öneri:** Null check strict yapılmalı.

### ME-5: Booking Dialog — Form Validasyonu Yok
- **Dosya:** `apps/web/src/app/features/bookings/booking-list/booking-list.component.ts`
- **Satır:** 128–212
- **Açıklama:** `ngModel` kullanılıyor ama `Validators` yok. `canSave()` manuel kontrol ediyor. Kullanıcıya görsel feedback yok.
- **Öneri:** `ReactiveFormsModule` ile `Validators.required` kullanılmalı.

### ME-6: MCR Panel — Timeline Form Validasyonu Yok
- **Dosya:** `apps/web/src/app/features/mcr/mcr-panel/mcr-panel.component.ts`
- **Satır:** 348, 425–442
- **Açıklama:** `newEvent` düz obje, validation yok. Boş TC veya type submit edilebilir.
- **Öneri:** Minimum validasyon kuralları ve submit butonu disabled state’i eklenmeli.

### ME-7: Erişilebilirlik — Özel Tablolar (`mat-table` Yerine)
- **Dosyalar:** `schedule-list.component.ts`, `audit-log.component.ts`, `studio-plan-list.component.ts`, `studio-plan-report.component.ts`, `schedule-reporting.component.ts`
- **Açıklama:** Angular Material `<mat-table>` yerine custom `<table>` kullanılıyor. `role`, `scope`, `aria-label` eksik.
- **Öneri:** `mat-table`’a migrate edilmeli veya ARIA attribute’leri eklenmeli.

### ME-8: Erişilebilirlik — Dinamik İçerik Bildirimi Yok
- **Dosyalar:** `ingest-list.component.ts`, `mcr-panel.component.ts`, `monitoring-dashboard.component.ts`
- **Açıklama:** Auto-refresh panel’ler (5–30 sn) ekran okuyuculara bildirim göndermiyor.
- **Öneri:** `aria-live="polite"` region’ları eklenmeli.

### ME-9: Service’lerde Request Deduplication Yok
- **Dosyalar:** `api.service.ts`, `schedule.service.ts`, `studio-plan.service.ts`
- **Açıklama:** Hızlı kullanıcı eylemleri (filtre toggle) duplicate paralel HTTP request’lere neden oluyor.
- **Öneri:** Idempotent GET’ler için `shareReplay({ bufferSize: 1, refCount: true })` eklenmeli.

### ME-10: Weekly Shift PDF — Inline Style XSS Riski (Düşük)
- **Dosya:** `apps/web/src/app/features/weekly-shift/weekly-shift.component.ts`
- **Satır:** 491–670
- **Açıklama:** `shiftCellPdf()` `cell.startTime` ve `cell.endTime` değerlerini inline CSS’e gömüyor. Değerler `<mat-select>`’ten geliyor ama API tarafından bozulursa HTML yapısı kırılabilir.
- **Öneri:** Zaman değerleri de `escapeHtml()`’den geçirilmeli.

### ME-11: Environment.prod.ts — Runtime Config Yarış Koşulu
- **Dosya:** `apps/web/src/environments/environment.prod.ts`
- **Açıklama:** `(window as any).__BCMS_KEYCLOAK_URL__` modül yükleme anında okunuyor. Eğer `/assets/runtime-config.js` yüklenmemişse boş string kalıyor.
- **Öneri:** `APP_INITIALIZER`’da asenkron config yükleme yapılmalı.

### ME-12: Metrics Plugin — Çok Minimal, Scale Edilemez
- **Dosya:** `apps/api/src/plugins/metrics.ts`
- **Açıklama:** Sadece `http_requests_total` ve `http_errors_total` counter var. Path, method, status code label’ı yok. Birden fazla pod olduğunda her pod farklı sayaç tutar, aggregate edilemez.
- **Öneri:** `prom-client` entegre edilmeli, path/method/status label’lı histogram kullanılmalı.

### ME-13: RabbitMQ Graceful Degradation — Mesajları Sessizce Drop Ediyor
- **Dosya:** `apps/api/src/plugins/rabbitmq.ts`
- **Satır:** 112–118
- **Açıklama:** Non-production ortamda RabbitMQ bağlanamazsa no-op stub ekleniyor. `publish()` sadece log atıyor, mesaj kayboluyor.
- **Öneri:** En azından `publish()` queue’a yazılamazsa hata fırlatmalı (fail-fast) veya local disk queue kullanılmalı.

### ME-14: Prisma `deletedAt` Soft Delete Tutarsızlığı
- **Dosya:** `apps/api/prisma/schema.prisma`
- **Açıklama:** Sadece bir model’de `deletedAt` var. Live DB’de diğer tablolarda da `deleted_at` sütunu var ama schema’da tanımlı değil. Query’lerde soft delete filtresi tutarsız uygulanıyor (sadece `weekly-shift.routes.ts`’te görüldü).
- **Öneri:** Tüm entity’lerde soft delete stratejisi standartlaştırılmalı ve Prisma middleware/extension ile otomatik `deletedAt: null` filtresi uygulanmalı.

### ME-15: Ingest List — `JSON.stringify` ile Array Karşılaştırma
- **Dosya:** `apps/web/src/app/features/ingest/ingest-list/ingest-list.component.ts`
- **Satır:** 893, 968
- **Açıklama:** `JSON.stringify(next) !== JSON.stringify(current)` büyük dataset’lerde yavaş ve key ordering farklılıklarında yanlış sonuç verebilir.
- **Öneri:** Immutable reference veya `fast-deep-equal` benzeri utility kullanılmalı.

### ME-16: `skipAuth` Production Bundle’a Sızma Riski
- **Dosya:** `apps/web/src/environments/environment.ts`
- **Açıklama:** `skipAuth: true` ve `dev-admin` hardcoded. `fileReplacements` yanlış yapılandırılırsa production build’a sıçrayabilir.
- **Öneri:** Build-time check eklenmeli (örn. `angular.json` post-build script).

### ME-17: Schedule Form — `channelId` Validator Zayıf
- **Dosya:** `apps/web/src/app/features/schedules/schedule-form/schedule-form.component.ts`
- **Satır:** 259–265
- **Açıklama:** `channelId: [0]` default değeri `Validators.required` veya `min(1)` olmadan valid kabul ediliyor.
- **Öneri:** `Validators.required` ve `Validators.min(1)` eklenmeli.

### ME-18: API `multipart` Limiti — 10 MB Sabit
- **Dosya:** `apps/api/src/app.ts`
- **Satır:** 221
- **Açıklama:** `multipart` limit 10 MB. Excel import dosyaları büyüdükçe başarısız olabilir.
- **Öneri:** Limit ortam değişkeninden okunmalı veya daha yüksek bir default (50–100 MB) kullanılmalı.

### ME-19: CI Workflow — `npm audit` Sonucu Ignore Edilebilir
- **Dosya:** `.github/workflows/ci.yml`
- **Satır:** 71
- **Açıklama:** `npm audit --audit-level=high` çalışıyor ama `--audit-level=high` yüksek seviyeli vulnerability’leri döndürse de build’i fail etmeyebilir (exit code 0). `npm audit` davranışı sürüme bağlıdır.
- **Öneri:** `npm audit --audit-level=high` sonrası `|| true` kontrolü yapılmamalı; kesin fail etmesi için `audit-ci` veya `better-npm-audit` kullanılmalı.

### ME-20: Docker Compose — `opta-watcher` Image Rebuild Edilmemiş
- **Açıklama:** `docker-compose.yml`’de `build` context tanımlı ama container hala eski image’dan çalışıyor (`HOME=/nonexistent`).
- **Öneri:** `docker-compose up --build` veya `docker-compose build opta-watcher` çalıştırılmalı.

### ME-21: `opta-watcher` Python Script — SMB Credential Exposure Riski
- **Dosya:** `scripts/opta_smb_watcher.py`
- **Açıklama:** SMB credentials environment variable’lardan okunuyor ama log’larda credential sızıntısı olup olmadığı kontrol edilmemiş.
- **Öneri:** Script log’larında password/username maskelenmeli.

### ME-22: Health Check — OPTA Status Yanıltıcı
- **Dosya:** `apps/api/src/app.ts`
- **Satır:** 238–249
- **Açıklama:** `getOptaWatcherStatus().connected` false ise sadece dizin varlığı kontrol ediliyor. Dizin varsa `ok` dönüyor. Bu watcher’ın çalışmadığını gizleyebilir.
- **Öneri:** Watcher process heartbeat veya son başarılı tarama zamanı kontrol edilmeli.

---

## 5. LOW 🟢 (Kod Stili / Teknik Borç / Küçük İyileştirmeler)

### LO-1: Redundant Route Guard’lar
- **Dosya:** `apps/web/src/app/features/schedules/schedules.routes.ts`
- **Açıklama:** Child route’larda `canActivate: [AuthGuard]` tekrarlanıyor. Parent route zaten guard uyguluyor.
- **Öneri:** Child route’lardan kaldırılmalı.

### LO-2: Magic Numbers
- **Dosyalar:** Çoklu
- **Örnekler:** `ingest-list`: `5000`, `10000`, `48 * 60`; `mcr-panel`: `30_000`; `schedule-list`: `60_000`, `pageSize = 100`
- **Öneri:** Named constant’lara çıkarılmalı.

### LO-3: Karışık Signal / Non-Signal State
- **Dosyalar:** `app.component.ts`, `schedule-list.component.ts`, `mcr-panel.component.ts`, `monitoring-dashboard.component.ts`
- **Açıklama:** `username`, `selectedDate`, `rundownDate`, `weekStart` gibi değişkenler hala plain property. `detectChanges()` manuel çağrılıyor.
- **Öneri:** Tüm state signal’e çevrilmeli.

### LO-4: SEO Meta Tag’leri Eksik
- **Dosya:** `apps/web/src/index.html`
- **Açıklama:** `description`, `theme-color`, OpenGraph tag’leri yok.
- **Öneri:** Standart meta tag’leri eklenmeli.

### LO-5: Print Style `!important` ve Tag Selector Kullanımı
- **Dosya:** `apps/web/src/app/features/studio-plan/studio-plan-shell.scss`
- **Açıklama:** `app-studio-plan-toolbar` gibi tag selector’lar component rename edilirse kırılır.
- **Öneri:** `.no-print` gibi class-based selector kullanılmalı.

### LO-6: `any` Tip Kullanımı
- **Dosyalar:** `app.component.ts` (L157), `auth.guard.ts` (L32), `audit-log.component.ts` (L20–21)
- **Açıklama:** `tokenParsed as any`, `beforePayload: any` tip güvenliğini bypass ediyor.
- **Öneri:** Strict interface tanımları kullanılmalı.

### LO-7: `keycloak-angular` Legacy Provider
- **Dosya:** `apps/web/src/app/app.config.ts`
- **Satır:** 37
- **Açıklama:** `importProvidersFrom(KeycloakAngularModule)` kullanılıyor.
- **Öneri:** `provideKeycloak()`’a migrate edilmeli.

### LO-8: Frontend Build Uyarıları
- **Açıklama:** Build başarılı olsa da deprecation veya unused import uyarıları olabilir. CI’da `ng build` `--configuration production` ile strict mode aktif değilse bundle boyutu artabilir.
- **Öneri:** `angular.json`’da `strict: true` ve CI’da `--no-progress` ile build log’ları temiz tutulmalı.

### LO-9: `apps/web/src/app/app.component.ts` — `username` Signal Değil
- **Satır:** 147, 161
- **Açıklama:** `username` plain string, `cdr.detectChanges()` gerektiriyor.
- **Öneri:** `username = signal<string>()` yapılmalı.

### LO-10: `studio-plan-shell.scss` — `@page { margin: 0 }` Tüm Sayfalara Etki
- **Açıklama:** Global `@page` rule sadece studio plan değil, uygulamanın tüm print çıktılarına etki edebilir.
- **Öneri:** Scope’lu CSS class ile sınırlandırılmalı.

### LO-11: `snackRef.onAction()` Subscription Memory Leak
- **Dosya:** `apps/web/src/app/features/schedules/schedule-list/schedule-list.component.ts`
- **Satır:** 1975–1989
- **Açıklama:** Snackbar action subscription temizlenmiyor. Rapid delete işlemlerinde birikebilir.
- **Öneri:** `take(1)` veya explicit unsubscribe eklenmeli.

### LO-12: `apps/api/src/app.ts` — `multipart` File Size Limit Loglanmamış
- **Açıklama:** 10 MB limit yapılandırma dosyası veya log’da görünmüyor.
- **Öneri:** Startup log’unda limit değeri yazdırılmalı.

---

## 6. Veritabanı & Migration Durumu

| Konu | Durum | Risk |
|------|-------|------|
| `prisma validate` | ✅ Pass | — |
| `prisma migrate dev` | ❌ P3006 Shadow DB hatası | Yeni index/relation uygulanamıyor |
| Baseline migration | ❌ Eksik | Live DB ile schema arası fark var |
| Live DB ek tablolar | `deleted_at` (çoklu tablo), `content_entry_categories`, `content_entry_tags`, `workspaces` | Schema drift |
| Soft delete tutarlılığı | ❌ Sadece 1 model’de `deletedAt` | Diğer entity’ler hard delete oluyor |
| Yeni relation’lar | ✅ Schema’da tanımlı (Schedule-BroadcastType, IngestJob-PlanItem) | Migration bekliyor |
| Yeni index’ler | ✅ Schema’da tanımlı | Migration bekliyor |
| `onDelete: Cascade` | ✅ Eklendi | Migration bekliyor |

### Öneri:
1. **Production DB yedeği al.**
2. `npx prisma db pull` ile mevcut schema baseline’lanmalı.
3. `npx prisma migrate diff` ile farklar incelenmeli.
4. Manuel reconcile sonrası yeni migration oluşturulup `migrate deploy` ile uygulanmalı.

---

## 7. Test Kapsamı

| Katman | Dosya Sayısı | Kapsam | Not |
|--------|-------------|--------|-----|
| API Unit/Integration | 3 | Çok Düşük | `opta.sync.routes.spec.ts`, `booking.import.test.ts`, `notification.test.ts` |
| Frontend Unit | **0** | **Yok** | `find ... -name "*.spec.ts"` 0 sonuç |
| E2E | 0 | Yok | — |
| Smoke Test | 1 | Minimal | `ops/scripts/bcms-smoke-api.mjs` |

### Öneri:
- **En azından** `auth.guard.ts`, `api.service.ts`, `schedule.service.ts`, `studio-plan.service.ts` için unit test yazılmalı.
- Critical path’ler (schedule create/update, booking CRUD, ingest callback) için integration test eklenmeli.

---

## 8. Runtime Container & Log Analizi

| Container | Durum | Not |
|-----------|-------|-----|
| `bcms_api` | ✅ Healthy | OPTA sync bombardımanı aktif (2–4 req/s) |
| `bcms_worker` | ⚠️ Running (Restarted, healthcheck disabled) | RabbitMQ kopması sonrası crash → restart |
| `bcms_opta_watcher` | ⚠️ Running (healthcheck yok, state persist edemiyor) | `HOME=/nonexistent` |
| `bcms_web` | ✅ Healthy | — |
| `bcms_postgres` | ✅ Healthy | Normal checkpoint logları |
| `bcms_rabbitmq` | ✅ Healthy | — |
| `bcms_keycloak` | ✅ Healthy | — |
| `bcms_grafana` | ✅ Healthy | — |
| `bcms_prometheus` | ✅ Healthy | — |
| `bcms_mailhog` | ✅ Healthy | — |

> **Not:** `docker-compose.yml`'de image tag'leri pinlenmiş (`mailhog/mailhog:v1.0.1`, `prom/prometheus:v2.53.1`, `grafana/grafana:11.1.0`) ancak çalışan container'lar recreate edilmemiş; halen eski `latest` image hash'leri görülebilir.

### Log Anomalileri:
- **API:** `OPTA sync tamamlandı — yeni: 0, güncellenen: 0, değişmeyen: 100` mesajı her istekte tekrarlanıyor. 100 maçın hiçbiri değişmiyor ama transaction her seferinde çalışıyor.
- **Worker:** `RabbitMQ connection closed` → `ECONNREFUSED` → uncaught exception → process crash. Auto-restart var ama down time oluşuyor.
- **OPTA Watcher:** `Tarama tamamlandı — değişen:179 dosya | yeni:0 güncellenen:0 değişmeyen:34058` → sonra `FileNotFoundError` → restart.

---

## 9. Önerilen Öncelikli Eylem Planı (Önce Acil, Sonra Önemli)

### Faz 1: Acil (1–2 Gün)
1. **OPTA watcher container’ını yeniden build et** ve `HOME=/data`’nın geçerli olduğunu doğrula.
2. **Ingest List burst poll recursion’ını kaldır.**
3. **RabbitMQ reconnect logic’ini düzelt** — event handler içinde `throw` yapma.
4. **Production DB yedeği al** ve Prisma migration sorununu çöz.

### Faz 2: Kısa Vadeli (1 Hafta)
5. Audit plugin `user.roles` → `user.groups` düzelt.
6. Rate limit `skipOnError: false` yap.
7. Auth Guard + Interceptor error handler ekle.
8. Schedule form date validation ekle.
9. Settings password sentinel bug’ını düzelt.
10. Frontend’e unit test altyapısı kur ve en az 5 kritik service/component için test yaz.

### Faz 3: Orta Vadeli (2–4 Hafta)
11. Studio Plan debounce + request cancellation ekle.
12. `OnDestroy` cleanup pattern’ini tüm component’lere uygula.
13. Metrics plugin’i `prom-client` ile değiştir.
14. Soft delete stratejisini tüm entity’lerde standartlaştır.
15. Erişilebilirlik (a11y) iyileştirmeleri: `mat-table`, `aria-live`, form validation.

### Faz 4: Uzun Vadeli (1–3 Ay)
16. CI/CD’ye test coverage threshold ekle (%70 hedef).
17. E2E test suite kur (Playwright/Cypress).
18. API endpoint’lerinde N+1 query analizi yap ve optimize et.
19. Horizontal scaling için stateless design’a geç (metrics, session).

---

*Rapor tamamlanmıştır. Hiçbir dosya değiştirilmemiştir.*
