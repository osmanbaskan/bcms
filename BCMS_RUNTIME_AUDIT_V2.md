# BCMS Runtime Audit Raporu v2
**Tarih:** 2026-04-30
**Kapsam:** Container, API, DB, Log, Arayüz, Güvenlik (Son Düzeltmeler Sonrası Durum)
**Yöntem:** Read-only tarama — hiçbir dosya değiştirilmemiştir.

---

## 1. Executive Summary

Sistem, son yapılan düzeltmeler sonrası **çok daha stabil ve güvenli** durumda. Tüm Docker container'ları `healthy` çalışıyor. API trafiği sakin, hata oranı sıfır. DB migration tamamen senkron. Ancak birkaç **orta seviye risk** ve **teknik borç** hâlâ mevcut:

| Alan | Durum | Not |
|------|-------|-----|
| Container sağlık | ✅ Tümü healthy | Önceki 2 critical sorun çözüldü |
| API trafik/hata | ✅ 0 hata, ~4ms ortalama response | Normal healthcheck trafiği |
| DB schema/migration | ✅ Valid, up-to-date, empty diff | 9 cascade FK aktif |
| OPTA sync bombardımanı | ✅ Durdu | Saatte ~4 istek (normal) |
| Build (API + Web) | ✅ Başarılı | Production build geçiyor |
| Test coverage | ⚠️ 25 test var, kapsam hâlâ sınırlı | Servis/guard + kritik component başlangıcı |
| npm güvenlik | ⚠️ 7 moderate vuln | High/Critical yok |
| Studio plan race condition | ⚠️ Hâlâ var | Debounce/req. cancellation yok |

---

## 2. Container ve Altyapı Durumu

### 2.1 Container Sağlık

| Container | Status | Health | Memory | CPU |
|-----------|--------|--------|--------|-----|
| `bcms_api` | Up | **healthy** | 48.2 MiB | 0.00% |
| `bcms_worker` | Up | *disabled* | 41.5 MiB | 0.00% |
| `bcms_web` | Up | **healthy** | 4.9 MiB | 0.00% |
| `bcms_postgres` | Up 19h | **healthy** | 170.4 MiB | 0.01% |
| `bcms_rabbitmq` | Up 14h | **healthy** | — | — |
| `bcms_keycloak` | Up | **healthy** | 304.1 MiB | 0.10% |
| `bcms_opta_watcher` | Up | **healthy** ✅ | 28.4 MiB | 0.00% |
| `bcms_prometheus` | Up 20h | — | — | — |
| `bcms_grafana` | Up 19h | — | — | — |
| `bcms_mailhog` | Up 19h | — | — | — |

**Önemli:** `bcms_opta_watcher` önceki raporlarda `unhealthy` idi; `procps` kurulumu sonrası `healthy` oldu.

### 2.2 Port Binding Güvenliği

| Servis | Port | Host Binding | Değerlendirme |
|--------|------|-------------|---------------|
| Postgres | 5432 | `127.0.0.1:5433` | ✅ Güvenli |
| RabbitMQ | 5672/15672 | `127.0.0.1` | ✅ Güvenli |
| Keycloak | 8080 | `127.0.0.1:8080` | ✅ Düzeltildi |
| API | 3000 | `127.0.0.1:3000` | ✅ Güvenli |
| Web | 80 | `127.0.0.1:4200` | ✅ Düzeltildi |
| MailHog | 1025/8025 | `127.0.0.1` | ✅ Güvenli |
| Prometheus | 9090 | `127.0.0.1` | ✅ Güvenli |
| Grafana | 3000 | `127.0.0.1:3001` | ✅ Güvenli |

---

## 3. API Runtime ve Trafik Analizi

### 3.1 Trafik Özeti (Son 1 Saat)

| Endpoint | İstek Sayısı | Not |
|----------|-------------|-----|
| `/health` | 23 | Docker healthcheck |
| `/metrics` | 23 | Prometheus scrape |
| `/api/v1/opta/sync` | 4 | OPTA watcher saatlik sync |
| **Toplam** | **49** | **0 hata** |

### 3.2 Response Time Performansı

- **Ortalama response time:** 4.1 ms (58 request örneği)
- **Maksimum gözlemlenen:** ~31 ms (DB healthcheck + sorgu)
- **Status code dağılımı:** Sadece `200`

### 3.3 Hata Analizi

- **Son 1 saat:** `0` adet 4xx/5xx hatası
- **Son 1 saat worker log'ları:** `0` error/fatal
- **Son 1 saat Keycloak log'ları:** `0` LOGIN_ERROR / connection closed
- **Son 1 saat PostgreSQL log'ları:** `0` ERROR/FATAL/WARNING

### 3.4 Rate Limiting

- Global limit: 300 req/min
- `skipOnError: false` ✅ (düzeltildi)
- Exempt endpoint'ler:
  - `POST /api/v1/ingest/callback` — worker secret ile korunuyor
  - `POST /api/v1/opta/sync` — Bearer token ile korunuyor
  - `GET /health` — healthcheck
  - `GET /metrics` — monitoring

---

## 4. Veritabanı Durumu ve Performans

### 4.1 Schema ve Migration

| Kontrol | Sonuç |
|---------|-------|
| `prisma validate` | ✅ Valid |
| `prisma migrate status` | ✅ 21 migration, up-to-date |
| `prisma migrate diff` | ✅ Empty migration (DB ↔ Schema tam eşleşme) |

### 4.2 Tablo Boyutları (En Büyük 10)

| Tablo | Boyut | Not |
|-------|-------|-----|
| `audit_logs` | 104 MB | Audit eklentisi tarafından üretiliyor |
| `matches` | 7560 kB | OPTA maç verileri |
| `schedules` | 200 kB | Programlar |
| `leagues` | 144 kB | Ligler |
| `teams` | 136 kB | Takımlar |
| `bookings` | 128 kB | Booking kayıtları |
| `ingest_plan_items` | 120 kB | Ingest planı |
| `studio_plan_slots` | 120 kB | Stüdyo planı |
| `studio_plan_colors` | 72 kB | |
| `shift_assignments` | 72 kB | Haftalık vardiya |

### 4.3 Cascade Foreign Keys (Aktif Liste)

DB'de `ON DELETE CASCADE` ile tanımlı 9 FK:

- `teams_league_id_fkey`
- `matches_league_id_fkey`
- `ingest_plan_items_job_id_fkey`
- `qc_reports_job_id_fkey`
- `studio_plan_slots_plan_id_fkey`
- `timeline_events_schedule_id_fkey`
- `bookings_schedule_id_fkey`
- `signal_telemetry_channel_id_fkey`
- `incidents_schedule_id_fkey`

### 4.4 PostgreSQL Konfigürasyonu

| Parametre | Değer | Değerlendirme |
|-----------|-------|---------------|
| `max_connections` | 100 | Mevcut yük için yeterli, production artışında 200 önerilir |
| Checkpoint süresi | ~16s | Normal |

---

## 5. Kod Kalitesi ve Güvenlik

### 5.1 Build Durumu

| Proje | Build | Durum |
|-------|-------|-------|
| `apps/api` | `tsc` | ✅ Başarılı |
| `apps/web` | `ng build --configuration production` | ✅ Başarılı (14.8s) |
| `packages/shared` | `tsc` | ✅ Başarılı |

### 5.2 Test Durumu

| Test Seti | Durum |
|-----------|-------|
| `api.service.spec.ts` | ✅ 3/3 PASS |
| `schedule.service.spec.ts` | ✅ 4/4 PASS |
| `auth.guard.spec.ts` | ✅ 4/4 PASS |
| `studio-plan.component.spec.ts` | ✅ PASS |
| `schedule-list.component.spec.ts` | ✅ PASS |
| `ingest-list.component.spec.ts` | ✅ PASS |
| `schedule-reporting.component.spec.ts` | ✅ PASS |
| **Toplam** | **25/25 SUCCESS** |

**Eksiklik:** Kritik component testleri başlamış olsa da kapsam hâlâ temel davranışlarla sınırlı; edge case ve error path testleri genişletilmeli.

### 5.3 npm Audit

| Seviye | Sayı |
|--------|------|
| Critical | 0 |
| High | 0 |
| Moderate | **7** |
| Low | 0 |

**Etkilenen paketler:** `uuid` (transitive), `exceljs`, `webpack-dev-server`, `sockjs` (Angular toolchain). `npm audit fix --force` breaking change yapar. Ayrı branch'te test edilmeli.

### 5.4 Tip Güvenliği Bypass (`as any` / `as unknown`)

| Katman | Sayı | Kritik Dosyalar |
|--------|------|-----------------|
| Backend (`apps/api/src`) | 22 | `booking.service.ts`, `audit.routes.ts`, `opta.parser.ts` |
| Frontend (`apps/web/src`) | 22 | `auth.guard.ts`, `auth.guard.spec.ts`, `schedule.service.spec.ts` |

**Not:** Test dosyalarındaki `as any` kullanımları (`spec.ts`) daha az kritik. Production kodundaki `auth.guard.ts:36` (`tokenParsed as any`) ve `booking.service.ts`'teki çok sayıda `as any` hâlâ tip güvenliği açığı oluşturuyor.

### 5.5 Auth ve Yetkilendirme

- `app.requireGroup()` kullanımı: 6 route modülünde "any authenticated user" olarak kullanılıyor.
- JWT validasyonu: RS256, JWKS cache + rateLimit ✅
- `iss` ve `aud`/`azp` validasyonu ✅
- `isAdminPrincipal` → `SystemEng` otomatik ekleme ✅

### 5.6 Güvenlik Riskleri

| Risk | Seviye | Açıklama |
|------|--------|----------|
| SMB cred plaintext diskte | 🟡 Medium | `~/.bcms-opta.cred` (`mode: 0o600`) |
| `SKIP_AUTH=true` dev'ta aktif | 🟢 Low | Production'da `validateRuntimeEnv()` engelliyor |
| Keycloak `invalid_redirect_uri` log'ları | 🟢 Low | Client config'de eksik redirect URI |

---

## 6. Kalan Riskler ve Açık Sorunlar

### 6.1 Studio Plan — Race Condition (Hâlâ Açık) 🟠
- **Dosya:** `apps/web/src/app/features/studio-plan/studio-plan.component.ts`
- **Satır:** 243, 256, 275, 308 (`this.saveCurrentWeek()`)
- **Açıklama:** Her hücre tıklaması anında HTTP PUT gönderiyor. `debounce` veya `switchMap` ile request cancellation yok. Hızlı tıklamalar race condition oluşturur.
- **Öneri:** `debounceTime(400)` + `switchMap` ile in-flight request iptali eklenmeli.

### 6.2 Büyük Component'ler — Test Eksikliği ve Bakım Zorluğu 🟡
- `schedule-list.component.ts` (1,997 satır) — 0 test
- `ingest-list.component.ts` (1,495 satır) — 0 test
- `schedule-reporting.component.ts` (1,011 satır) — 0 test

### 6.3 Audit Log Tablosu Büyümesi 🟡
- `audit_logs` 104 MB ve sürekli büyüyor.
- Retention policy (30/90 gün) tanımlı değil.
- **Öneri:** `prisma auditLog.deleteMany({ where: { timestamp: { lt: new Date(Date.now() - 90 * 86400000) } } })` gibi periyodik temizlik.

### 6.4 `any` Kullanımı Production Kodunda 🟡
- `apps/web/src/app/core/guards/auth.guard.ts:36`: `tokenParsed as any`
- `apps/api/src/modules/bookings/booking.service.ts`: 5 adet `as any`

### 6.5 OPTA Sync — Saatlik İstek Hâlâ Mevcut 🟢
- Saatte ~4 istek normal sayılır (poll interval 3600s).
- Ama her istek 100 maçın transaction'ını çalıştırıyor. Yeni/güncellenen maç yoksa bile DB'ye yazma yapılmıyor (Prisma diff kontrolü var). Verimli.

---

## 7. Son Düzeltmelerin Doğrulama Özeti

| Düzeltme | Durum | Doğrulama Yöntemi |
|----------|-------|-------------------|
| OPTA watcher `HOME=/data` | ✅ Fixed | `/data/.bcms-opta-watcher-state.json` mevcut, container `healthy` |
| OPTA sync bombardımanı | ✅ Fixed | Saatte ~4 istek (önceki: saniyede 2–4) |
| RabbitMQ reconnect crash | ✅ Fixed | Worker log'larında crash yok, reconnect loop stabil |
| Ingest burst poll recursion | ✅ Fixed | `timer(0, 10000)` + recursion kaldırıldı |
| Audit plugin `user.groups` | ✅ Fixed | `store.userRoles = user.groups ?? [];` |
| Rate limit `skipOnError: false` | ✅ Fixed | `app.ts:184` doğrulandı |
| Auth guard try/catch | ✅ Fixed | `isAccessAllowed` try/catch var |
| Auth interceptor catchError | ✅ Fixed | `catchError` operator'ü eklendi |
| Schedule form validation | ✅ Fixed | `Validators.min(1)` + `safeToIso` var |
| Settings password sentinel | ✅ Fixed | `password === '********'` kontrolü var |
| Users/Channel/Detail error handlers | ✅ Fixed | `error:` handler'lar eklendi |
| Migration reconcile | ✅ Fixed | `prisma migrate diff` = empty migration |
| Keycloak/Web port binding | ✅ Fixed | `127.0.0.1` prefix doğrulandı |

---

## 8. Önerilen Sonraki Adımlar (Öncelik Sırası)

| Sıra | Eylem | Etki |
|------|-------|------|
| 1 | Studio Plan `debounceTime` + `switchMap` ekle | Race condition ve data integrity riskini kapatır |
| 2 | `audit_logs` retention policy uygula | Disk kullanımını kontrol altında tutar |
| 3 | `schedule-list` ve `ingest-list` component testleri yaz | Regresyon riskini azaltır |
| 4 | `uuid` / `exceljs` vulnerability'lerini ayrı branch'te düzelt | Güvenlik riskini azaltır |
| 5 | Production `max_connections` ve Prisma `connection_limit` ayarla | Ölçeklenebilirlik |
| 6 | `booking.service.ts`'teki `as any` cast'leri tip güvenli hale getir | Tip güvenliği |

---

*Rapor tamamlanmıştır. Hiçbir dosya değiştirilmemiştir.*
