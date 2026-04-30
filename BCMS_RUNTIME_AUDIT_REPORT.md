# BCMS Runtime Audit Raporu
**Tarih:** 2026-04-30
**Kapsam:** Container durumu, runtime log'ları, DB durumu, API trafik, güvenlik, performans
**Değişiklik yapılmamıştır.**

---

## 1. Container Sağlık Durumu

| Container | Status | Health | Not |
|-----------|--------|--------|-----|
| `bcms_api` | Up 19m | **healthy** | Stabil |
| `bcms_worker` | Up 19m | *none* | `/health` 503 dönüyor |
| `bcms_web` | Up 18m | **healthy** | Stabil |
| `bcms_postgres` | Up 19h | **healthy** | Stabil |
| `bcms_rabbitmq` | Up 14h | **healthy** | Stabil |
| `bcms_keycloak` | Up 20h | **healthy** | Stabil |
| `bcms_opta_watcher` | Up 27m | **unhealthy** | `pgrep` container'da yok |
| `bcms_prometheus` | Up 20h | *none* | Stabil |
| `bcms_grafana` | Up 19h | *none* | Stabil |
| `bcms_mailhog` | Up 19h | *none* | Stabil |

### 🔴 CRITICAL: OPTA Watcher Unhealthy
- **Neden:** `docker-compose.yml` healthcheck komutu: `["CMD-SHELL", "pgrep -f opta_smb_watcher.py || exit 1"]`
- **Ama:** `python:3.11-slim` image'ında `procps` paketi yok, dolayısıyla `pgrep` komutu bulunamıyor.
- **Etki:** Healthcheck her 60 saniyede bir fail ediyor. Container `unhealthy` olarak işaretleniyor. Orchestrator (Docker Swarm/K8s) olsa restart loop'a girerdi.
- **Öneri:** Healthcheck komutu `pgrep` yerine `ps aux | grep -q opta_smb_watcher.py` veya Python one-liner kullanılmalı.

### 🟠 HIGH: Worker `/health` 503 Dönüyor
- **Neden:** `app.ts`'teki healthcheck `getOptaWatcherStatus().connected` false ise `/app/tmp/opta` dizin varlığını kontrol ediyor. Worker container'ında `OPTA_DIR=/opta` set edilmiş ama `/opta` dizini fiziksel olarak yok.
- **Log kanıtı:**
  ```
  req: GET /health, res: {statusCode: 503}
  ```
- **Etki:** Worker monitoring sisteminde (Prometheus) sürekli degraded olarak görünür.
- **Öneri:** Worker container'ına `OPTA_DIR` mount edilmeli veya healthcheck logic'i worker modu için (`BCMS_BACKGROUND_SERVICES != none`) farklı olmalı.

---

## 2. API Trafiği ve Log Analizi

| Metrik | Değer |
|--------|-------|
| Son 1 saat toplam request | **10,095** |
| Son 1 saat 5xx hatası | **0** |
| Son 1 saat 4xx hatası | **0** |
| `/opta/sync` bombardımanı | **Durdu** (0 istek) |

**API log pattern:** Sadece `/health` ve `/metrics` istekleri görünüyor. Her 5–10 saniyede bir healthcheck çağrısı. Bu normal Docker healthcheck + Prometheus scrape trafiği.

**Worker log pattern:** Son 1 saatte error/fatal yok. RabbitMQ bağlantısı stabil. Background services (notifications, ingest-worker, ingest-watcher, bxf-watcher) başarıyla çalışıyor.

---

## 3. Veritabanı Durumu

### Migration ve Schema
| Kontrol | Sonuç |
|---------|-------|
| `prisma validate` | ✅ Valid |
| `prisma migrate status` | ✅ Database schema is up to date |
| Toplam migration | 22 |

### Cascade Foreign Keys (Son Durum)
DB'de aktif `ON DELETE CASCADE` constraint'ler:

| Constraint | Tablo | Durum |
|------------|-------|-------|
| `teams_league_id_fkey` | teams | ✅ Yeni uygulandı |
| `matches_league_id_fkey` | matches | ✅ Yeni uygulandı |
| `ingest_plan_items_job_id_fkey` | ingest_plan_items | ✅ Yeni uygulandı |
| `qc_reports_job_id_fkey` | qc_reports | ✅ Yeni uygulandı |
| `studio_plan_slots_plan_id_fkey` | studio_plan_slots | ✅ Mevcut |
| `timeline_events_schedule_id_fkey` | timeline_events | ✅ Mevcut |
| `bookings_schedule_id_fkey` | bookings | ✅ Mevcut |
| `signal_telemetry_channel_id_fkey` | signal_telemetry | ✅ Mevcut |
| `incidents_schedule_id_fkey` | incidents | ✅ Mevcut |

### PostgreSQL Konfigürasyonu
| Parametre | Değer | Değerlendirme |
|-----------|-------|---------------|
| `max_connections` | 100 | Düşük — production'da 200+ önerilir |
| Checkpoint | ~16s | Normal |

### Tablo Sayısı
Toplam 27 tablo (Prisma 23 model + 4 enum/internal).

---

## 4. Güvenlik ve Gizlilik

### npm Audit
| Seviye | Sayı |
|--------|------|
| Critical | 0 |
| High | 0 |
| Moderate | **7** |
| Low | 0 |

**Not:** 7 moderate vulnerability var. Detaylar `npm audit` çıktısında görülebilir. High/Critical yok.

### Çevresel Değişkenler (`.env`)
- `.env` dosyası `.gitignore`'da mevcut ✅
- `SKIP_AUTH=true` development ortamında aktif — production guard (`validateRuntimeEnv()`) tarafından engelleniyor ✅
- Secret'lar plaintext: `KEYCLOAK_ADMIN_PASSWORD`, `INGEST_CALLBACK_SECRET`, `OPTA_WATCHER_API_TOKEN`, `OPTA_SMB_PASSWORD`, `GRAFANA_PASSWORD`

### SMB Credentials Diskte Plaintext
- **Dosya:** `apps/api/src/modules/opta/opta.smb-config.ts`
- `~/.bcms-opta.cred` dosyasına `username/password/domain` plaintext yazılıyor.
- `mode: 0o600` ile korunuyor ama yine de diskte plaintext password var.
- **Öneri:** Linux kernel keyring veya tmpfs (`/dev/shm`) kullanılmalı.

### Keycloak Log Anomalileri
```
LOGIN_ERROR, error="invalid_redirect_uri", redirect_uri="http://localhost:9999/"
```
- Keycloak client config'inde `localhost:9999` redirect URI tanımlı değil.
- Ayrıca XA transaction hatası görüldü (`Connection has been closed`). Bu Keycloak'ın DB connection pool'u ile ilgili olabilir.

### Port Binding Durumu
| Servis | Port | Binding | Risk |
|--------|------|---------|------|
| Postgres | 5432 | `127.0.0.1:5433` | Düşük ✅ |
| RabbitMQ | 5672/15672 | `127.0.0.1` | Düşük ✅ |
| Keycloak | 8080 | `0.0.0.0:8080` | **Yüksek** — tüm interface'lere açık |
| API | 3000 | `127.0.0.1:3000` | Düşük ✅ |
| Web | 80 | `4200:80` | `0.0.0.0:4200` — tüm interface'lere açık |
| MailHog | 1025/8025 | `127.0.0.1` | Düşük ✅ |
| Prometheus | 9090 | `127.0.0.1` | Düşük ✅ |
| Grafana | 3000 | `127.0.0.1:3001` | Düşük ✅ |

**Risk:** Keycloak `8080:8080` ve Web `4200:80` dış ağa açık. Production'da reverse proxy (nginx/traefik) arkasına alınmalı.

---

## 5. Performans ve Kaynak Kullanımı

| Container | CPU % | Memory | Mem % |
|-----------|-------|--------|-------|
| `bcms_api` | 0.00% | 41.4 MiB | 0.26% |
| `bcms_worker` | 0.00% | 37.3 MiB | 0.23% |
| `bcms_web` | 0.00% | 8.2 MiB | 0.05% |
| `bcms_postgres` | 0.00% | 167.1 MiB | 1.05% |
| `bcms_opta_watcher` | 0.00% | 63.7 MiB | 0.40% |

**Değerlendirme:** Tüm container'lar idle durumda. Memory kullanımı çok düşük ve stabil. Memory leak belirtisi yok. CPU kullanımı neredeyse sıfır (sadece healthcheck polling var).

---

## 6. Kod Kalitesi ve Boyut Analizi

### Backend Route Dosyaları
| Dosya | Satır | Not |
|-------|-------|-----|
| `ingest.routes.ts` | 603 | En büyük route dosyası |
| `weekly-shift.routes.ts` | 422 | |
| `studio-plan.routes.ts` | 373 | |
| `users.routes.ts` | 303 | |
| `schedule.routes.ts` | 278 | |
| **Toplam** | **3,195** | 10 route modülü |

### Frontend Component Dosyaları
| Dosya | Satır | Not |
|-------|-------|-----|
| `schedule-list.component.ts` | 1,997 | En büyük component |
| `ingest-list.component.ts` | 1,495 | |
| `schedule-reporting.component.ts` | 1,011 | |
| `weekly-shift.component.ts` | 699 | |
| `studio-plan.component.ts` | 626 | |
| **Toplam** | **9,633** | 9 büyük component |

### Tip Güvenliği Bypass
| Katman | `as any` / `as unknown` Sayısı |
|--------|-------------------------------|
| Backend (`apps/api/src`) | 22 |
| Frontend (`apps/web/src`) | 22 |

---

## 7. Build Durumu

| Proje | Build | Durum |
|-------|-------|-------|
| `apps/api` | `tsc --noEmit` | ✅ Başarılı |
| `apps/web` | `ng build --configuration production` | ✅ Başarılı (14.8s) |
| `packages/shared` | `tsc` | ✅ Başarılı |

---

## 8. Yeni Bulgular (Önceki Raporlara Ek)

### 1. OPTA Watcher Healthcheck `pgrep` Eksikliği 🔴
- `docker-compose.yml` healthcheck: `pgrep -f opta_smb_watcher.py`
- `python:3.11-slim` image'ında `pgrep` yok → sürekli `unhealthy`
- **Öneri:** `ps aux | grep -q [o]pta_smb_watcher` veya Python one-liner

### 2. Worker Healthcheck 503 🔴
- `/app/tmp/opta` dizini worker container'ında yok
- Healthcheck `fs.stat(opta.dir)` fail → 503 degraded
- **Öneri:** Worker'a `OPTA_DIR` mount edilmeli veya healthcheck logic'i worker moduna göre ayarlanmalı

### 3. Keycloak `8080` Tüm Interface'lere Açık 🟠
- `docker-compose.yml`: `8080:8080` (host IP sınırlandırması yok)
- **Öneri:** `127.0.0.1:8080:8080` yapılmalı veya reverse proxy arkasına alınmalı

### 4. Web Port `4200` Tüm Interface'lere Açık 🟠
- `4200:80` (host IP sınırlandırması yok)
- **Öneri:** `127.0.0.1:4200:80` yapılmalı

### 5. PostgreSQL `max_connections` = 100 🟡
- Prisma default connection pool başına 9 connection kullanır
- API + Worker + Keycloak + diğer = toplam 30–40 connection
- 100 yeterli ama production yükünde darboğaz olabilir
- **Öneri:** `max_connections = 200` ve Prisma `connection_limit` ayarlanmalı

### 6. SMB Credential Plaintext Diskte 🟡
- `~/.bcms-opta.cred` dosyası `mode: 0o600` ile yazılıyor
- Yine de diskte plaintext password var
- **Öneri:** tmpfs mount veya Linux keyring kullanımı

### 7. npm Audit 7 Moderate Vulnerability 🟡
- High/Critical yok
- `npm audit fix` ile çözülebilir

### 8. Frontend Component Boyutu 🟡
- `schedule-list.component.ts` (1,997 satır) ve `ingest-list.component.ts` (1,495 satır) çok büyük
- Bakım ve test zorluğu artıyor
- **Öneri:** Sub-component'lere bölünmesi

---

## 9. Özet ve Öncelikli Eylem Listesi

| Öncelik | Sorun | Öneri |
|---------|-------|-------|
| 🔴 **CRITICAL** | OPTA watcher `unhealthy` | Healthcheck komutunu `pgrep` yerine `ps` veya Python one-liner ile değiştir |
| 🔴 **CRITICAL** | Worker `/health` 503 | `/app/tmp/opta` dizinini worker'a mount et veya healthcheck logic'i düzelt |
| 🟠 **HIGH** | Keycloak `8080` açık | `127.0.0.1:8080:8080` yap |
| 🟠 **HIGH** | Web `4200` açık | `127.0.0.1:4200:80` yap |
| 🟡 **MEDIUM** | PostgreSQL `max_connections` 100 | `200` yap, Prisma pool ayarla |
| 🟡 **MEDIUM** | SMB cred plaintext | tmpfs veya keyring kullan |
| 🟡 **MEDIUM** | npm 7 moderate vuln | `npm audit fix` çalıştır |
| 🟢 **LOW** | Component boyutu | Refactor planla |

---

*Rapor tamamlanmıştır. Hiçbir dosya değiştirilmemiştir.*
