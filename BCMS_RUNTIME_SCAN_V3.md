# BCMS Kapsamlı Runtime & Kod Tarama Raporu — v3

> Tarih: 2026-04-30  
> Kapsam: API log, DB, Docker, arayüz, kod, konfigürasyon  
> Amaç: Bug/fix tespiti — **sadece rapor, değişiklik yok**  

---

## 🔴 KRİTİK BULGULAR

### 1. Container Restart Eksikliği — Yeni Kod Çalışmıyor

**Durum:** `docker-compose.yml`'de yapılan son değişiklikler (AUDIT_RETENTION_DAYS, BCMS_BACKGROUND_SERVICES `audit-retention` ekleme) container'lara yansımamış.

| Container | Env (Gerçek) | Env (docker-compose.yml) | Kod (dist/) | Beklenen |
|-----------|-------------|--------------------------|-------------|----------|
| `bcms_api` | `BCMS_BACKGROUND_SERVICES=none` | `none` ✅ | `prisma.js` eski (connection limit yok) | Yeni kod yok ❌ |
| `bcms_worker` | `BCMS_BACKGROUND_SERVICES=notifications,ingest-worker,ingest-watcher,bxf-watcher` | `+audit-retention` | `prisma.js` eski, `audit-retention.job.js` yok | Yeni kod yok ❌ |

**Neden:** Container'lar `docker compose up -d --build` ile restart edilmedi. `docker-compose.yml`'deki env ve image değişiklikleri çalışan container'lara uygulanmadı.

**Etki:**
- Audit retention job **çalışmıyor** → `audit_logs` 104 MB, büyümeye devam ediyor
- Prisma connection limit **etkin değil** → API ve Worker varsayılan pool boyutunu kullanıyor
- Worker health endpoint **503** döndürüyor (eski kod + eski env)

**Öneri:**
```bash
docker compose up -d --build api worker
```

### 2. Worker Health Endpoint 503

**Kanıt:**
```bash
$ docker exec bcms_worker wget -qO- http://127.0.0.1:3000/health
wget: server returned error: HTTP/1.1 503 Service Unavailable
```

**Neden:** Worker container'ı eski `dist/` ile çalışıyor. Eski health check logic'te `fs.stat(opta.dir)` hatası → `checks.opta = 'degraded'` → 503. Yeni kodda (`main` branch) bu sorun `enabledBackgroundServices` kontrolü ile çözülmüş.

**Docker healthcheck:** `disable: true` olduğu için container `docker ps`'te `Up` görünüyor ama HTTP health 503.

---

## 🟡 ORTA SEVİYE BULGULAR

### 3. `audit_logs` Tablosu — Büyüme Devam Ediyor

| Metrik | Değer |
|--------|-------|
| Satır sayısı | 564.846 |
| Boyut | 104 MB |
| Index boyutu | 29.6 MB |
| Son vacuum | 2026-04-30 07:03 |

**Not:** Retention job container restart edilmediği için çalışmıyor. 90 günlük politikaya göre ilk purge gece yarısı gerçekleşecekti.

### 4. DB Dead Tuples

| Tablo | Dead Tuples | Yorum |
|-------|-------------|-------|
| `_prisma_migrations` | 24 | Migrations table'ının update edilmesi tuhaf |
| `studio_plans` | 20 | 2 satır, 20 dead tuple — sürekli upsert pattern |
| `matches` | 32 | 34.783 satır, normal seviye |
| `bookings` | 2 | Aktif kullanım yok gibi görünüyor |

**Öneri:** `VACUUM ANALYZE` periyodik çalıştırılmalı (PostgreSQL autovacuum aktif ama yoğun dönemlerde manuel tetikleme faydalı).

### 5. `console.error` Kullanımları Production Kodda

| Dosya | Satır | İçerik | Risk |
|-------|-------|--------|------|
| `auth.interceptor.ts:30` | `console.error('Token retrieval failed', err)` | Orta — kullanıcı token hatası loglanıyor |
| `schedule-list.component.ts:1065,1097,1302` | `console.error(e)` | Düşük — dialog hata handler'ları |
| `ingest-list.component.ts:970` | `console.error('Burst poll error', err)` | Düşük — polling hatası |
| `main.ts:5` | `console.error(err)` | Düşük — Angular bootstrap hatası |

**Öneri:** `console.error`'lar Angular `ErrorHandler`'a veya API logger'a yönlendirilmeli.

### 6. Kalan `as any` Cast'leri

| Dosya | Satır | Sayı | Açıklama |
|-------|-------|------|----------|
| `weekly-shift.routes.ts` | 316-317 | 2 | ExcelJS `cell.alignment` / `cell.font` — ExcelJS tip tanımı eksik |
| `audit.ts` | 75,77,97,114,147,160 | 6 | Dynamic Prisma model erişimi (`base[model]`) — teknik olarak zorunlu |
| `schedule-list.component.ts` | 1798,1858,1977 | 3 | `tokenParsed`, `params`, `metadata` — `schedule-list` component testi henüz yok |
| `booking-list.component.ts` | 421 | 1 | `tokenParsed as any` — `BcmsTokenParsed` pattern uygulanabilir |
| `environment.prod.ts` | 1 | 1 | `window as any` — runtime env injection, tip tanımı eklenebilir |

**Öneri:**
- `booking-list.component.ts` → `BcmsTokenParsed` ile düzeltilebilir (düşük risk)
- `schedule-list.component.ts` → Component refactor ile düzeltilebilir (orta risk)
- `audit.ts` → Prisma `$extends` dynamic access pattern'ı değişmez, **kabul edilebilir teknik borç**
- `environment.prod.ts` → `declare global { interface Window { __BCMS_KEYCLOAK_URL__?: string; } }` eklenebilir

---

## 🟢 DÜŞÜK SEVİYE / GÖZLEM

### 7. API Log Analizi (Son 24h)

| Level | Sayı | İçerik |
|-------|------|--------|
| `30` (info) | 1.124 | Normal işlem |
| `40` (warn) | 16 | `Invalid or expired token` (401) — kullanıcı token'ı expire olmuş |
| `50` (error) | 0 | Yok ✅ |
| `60` (fatal) | 0 | Yok ✅ |

**Yorum:** Sadece 401'ler var. Bu normal kullanıcı davranışı (token refresh öncesi istekler). Hiç 500, unhandled exception veya crash yok.

### 8. Worker Log Analizi (Son 24h)

- Error/fatal log: **Yok** ✅
- Background service'ler başarıyla başlatılmış:
  - `notifications` ✅
  - `ingest-worker` ✅
  - `ingest-watcher` ✅
  - `bxf-watcher` ✅
  - `opta-watcher` (disabled) ✅

### 9. OPTA Watcher Logları

- Python traceback: **Yok** ✅
- State file: `/data/.bcms-opta-watcher-state.json` persists ✅
- ~4 sync/saat normal seyirde ✅

### 10. Docker Container Durumu

| Container | Status | Healthcheck |
|-----------|--------|-------------|
| `bcms_api` | Up 2h | `healthy` ✅ |
| `bcms_worker` | Up 2h | `disable` ⚠️ (HTTP 503) |
| `bcms_web` | Up ~1h | `healthy` ✅ |
| `bcms_postgres` | Up 20h | `healthy` ✅ |
| `bcms_rabbitmq` | Up 16h | `healthy` ✅ |
| `bcms_keycloak` | Up ~1h | `healthy` ✅ |
| `bcms_opta_watcher` | Up 2h | `healthy` ✅ |
| `bcms_grafana` | Up 20h | N/A |
| `bcms_prometheus` | Up 22h | N/A |
| `bcms_mailhog` | Up 20h | N/A |

### 11. RabbitMQ Durumu

| Queue | Messages | Consumers | Durum |
|-------|----------|-----------|-------|
| `queue.notifications.slack` | 0 | 0 | running |
| `queue.ingest.completed` | 0 | 0 | running |
| `queue.booking.created` | 0 | 0 | running |
| `queue.ingest.new` | 0 | 1 | running |
| `queue.schedule.created` | 0 | 0 | running |
| `queue.notifications.email` | 0 | 1 | running |
| `queue.schedule.updated` | 0 | 0 | running |

**Yorum:** Mesaj birikimi yok. Consumer'lar aktif.

### 12. Prisma & DB Tutarlılık

| Kontrol | Sonuç |
|---------|-------|
| `prisma migrate status` | 21 migrations, up-to-date ✅ |
| `prisma migrate diff` | No difference detected ✅ |
| `max_connections` | 100 |
| Aktif connections | 7 |
| Connection limit yeni kodda | API=10, Worker=5 (container restart edilmediği için etkisiz) |

### 13. Angular Build & Test Durumu

| Kontrol | Sonuç |
|---------|-------|
| `ng build --configuration production` | ✅ 12.4s |
| `ng test --watch=false --browsers=ChromeHeadless` | ✅ 25/25 PASS |
| `tsc --noEmit` (API) | ✅ |
| `strict` mode | ✅ Aktif (strictTemplates, noImplicitOverride, noPropertyAccessFromIndexSignature) |

### 14. Environment Tutarlılığı

| Kontrol | Sonuç |
|---------|-------|
| `.env.example` vs `docker-compose.yml` | Tam uyumlu ✅ |
| `environment.ts` vs `environment.prod.ts` | `skipAuth`, `production`, `keycloak.url` farklı — beklenen davranış ✅ |

### 15. Graceful Shutdown

| Servis | Timeout | Not |
|--------|---------|-----|
| API | 30 sn | `server.ts`'te `SHUTDOWN_TIMEOUT_MS = 30_000` |
| Worker | 30 sn | Aynı dosyayı kullanıyor. AGENTS.md "Worker için 60 sn" öneriyor. |

**Öneri:** Worker `SHUTDOWN_TIMEOUT_MS`'ini 60 sn yap veya ayrı `worker.ts` entrypoint'i oluştur.

---

## 📋 ÖNERİLEN EYLEM PLANI

| Öncelik | Eylem | Risk | Tahmini Süre |
|---------|-------|------|--------------|
| 🔴 **P0** | `docker compose up -d --build api worker` | Düşük | 2 dk |
| 🔴 **P0** | Worker healthcheck 503 doğrulama (restart sonrası) | Düşük | 1 dk |
| 🟡 **P1** | `booking-list.component.ts` `as any` → `BcmsTokenParsed` | Düşük | 5 dk |
| 🟡 **P1** | `environment.prod.ts` `window as any` → global declare | Düşük | 5 dk |
| 🟡 **P1** | `console.error` kullanımlarını logger'a yönlendir | Düşük | 15 dk |
| 🟢 **P2** | `schedule-list.component.ts` `as any` temizliği | Orta | 30 dk |
| 🟢 **P2** | Worker shutdown timeout 60 sn | Düşük | 10 dk |
| 🟢 **P2** | `VACUUM ANALYZE` manuel tetikleme | Düşük | 5 dk |

---

## ÖZET

Sistem **genel olarak stabil**. Kritik teknik sorun: **container restart eksikliği** nedeniyle son kod değişiklikleri (audit retention, Prisma connection limit, worker health fix) production container'larına yansımamış. Bu, `audit_logs`'un büyümeye devam etmesine ve worker health endpoint'inin 503 döndürmesine neden oluyor.

Diğer bulgular (dead tuples, console.error, kalan `as any` cast'leri) düşük-orta riskli teknik borçtur.

**Hiçbir production crash, unhandled exception veya veri kaybı tespit edilmedi.**
