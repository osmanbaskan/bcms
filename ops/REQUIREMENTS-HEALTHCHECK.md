# Per-Service Healthcheck — Tasarım Gereksinimleri

> **Status**: 📋 Requirements doc (implement edilmedi). Implement ayrı PR(lar), per-service kararlar netleşince.
> **Audit referansı**: `BCMS_AUDIT_REPORT_2026-05-01.md` Appendix A #6 — "bcms_grafana ve bcms_prometheus healthcheck eksik"; ek olarak verify sırasında `bcms_mailhog` (yok), `bcms_worker` (explicit disable), `bcms_opta_watcher` (sahte naive process check) tespit edildi.
> **Pattern referansı**: `ops/REQUIREMENTS-S3-BACKUP.md` (`9925422`), `9be627a`, `cc6d688`, `2e2b6a4` — design-first, decisions-pending zincirinin beşincisi (gözlemleme/hijyen kategorisinde, ana risk değil).

## Amaç

Section 8 #6 follow-up'ı: mevcut compose'da bazı container'lar `Up` ama `(healthy)` olmuyor. **Hedef**: per-service "health ne demek?" kararını netleştirmek. Sahte healthcheck üretmemek (örn. naive `pgrep` ile process up'ı "healthy" olarak yazmak — gerçek readiness'i temsil etmez).

**Bu doc kapsamında değil**:
- Implementation (compose edits, worker code change, vb.)
- Alertmanager healthcheck — notification implementation (`9be627a`) ile gelir, bu doc'un dışı

---

## 1. Mevcut State Inventory (live verify, özet tablo)

⚠️ **Not**: Aşağıdaki tablo `docker-compose.yml` config'inden çıkarıldı, raw `docker inspect` çıktısı gömülmedi (drift'e açık). Stale olduğunu düşünürsen `docker inspect bcms_X --format '{{json .Config.Healthcheck}}'` ile doğrulayabilirsin.

| Service | Healthcheck durumu | Test komutu | Interval/timeout/retries | Pattern değerlendirmesi |
|---|---|---|---|---|
| `bcms_postgres` | ✅ var | `pg_isready -U $USER -d $DB` | 10s/5s/5 | Doğru — pg_isready resmi readiness aracı |
| `bcms_postgres_backup` | ✅ inherit | (image default) | (image default) | Image'dan miras; verify edilmedi, default makul |
| `bcms_rabbitmq` | ✅ var | `rabbitmq-diagnostics ping` | 30s/10s/5 | Doğru — diagnostics ping resmi |
| `bcms_keycloak` | ✅ var | `bash -c '</dev/tcp/127.0.0.1/8080' \|\| exit 1` | 30s/10s/5 + start_period 60s | Port-tabanlı, yeterli (Keycloak boot uzun, 60s grace doğru) |
| `bcms_api` | ✅ var | `wget --spider http://127.0.0.1:3000/health` | 30s/10s/5 + start_period 30s | Doğru — `/health` endpoint app-level readiness |
| `bcms_web` | ✅ var | `curl -fsS http://localhost/health \|\| exit 1` | 30s/5s/3 | Doğru — `/health` endpoint |
| `bcms_opta_watcher` | ⚠️ **SAHTE** | `pgrep -f opta_smb_watcher.py \|\| exit 1` | (default) + start_period 30s | **(a) naive process check** — process up'ı "healthy" yazar; SMB connection drop / read1 password expire / file system error'da yine "healthy" görünür. Yanıltıcı. |
| `bcms_worker` | 🚫 **explicit disable** | `disable: true` | — | **(e) tanımsız + dokümante** — multi-layer readiness için bilinçli karar. Şu an undokümante, doc'la formalleştirilmeli. |
| `bcms_mailhog` | ❌ yok | — | — | Karar yok; dev-only deployment'ta skip varsayılıyor |
| `bcms_prometheus` | ❌ yok | — | — | Section 8 #6 follow-up — `/-/healthy` built-in, eklenmeli |
| `bcms_grafana` | ❌ yok | — | — | Section 8 #6 follow-up — `/api/health` built-in, eklenmeli |

**Inventory özeti**:
- 6 servis doğru healthcheck'e sahip (postgres, postgres_backup, rabbitmq, keycloak, api, web)
- 1 servis **sahte healthcheck** (opta_watcher, naive `pgrep`)
- 1 servis **explicit disable** (worker, undokümante)
- 3 servis **eksik** (mailhog, prometheus, grafana)

⚠️ **Verify sırasında ortaya çıkan eklenti**: `opta_watcher` hem audit raporunda hem `docker ps`'te "(healthy)" görünüyor — sahte güven üretiyor. Sectoin 8 #6 sadece prometheus + grafana'yı listelemişti; opta_watcher case'i bu doc'la **yeni discovery**.

---

## 2. "Up" vs "Healthy" Tanımları

| Durum | Anlamı |
|---|---|
| Container Up | Process running (PID 1 alive); compose level |
| Healthcheck not defined | Docker hiç sorgu yapmaz; container Up = sufficient signal varsayımı |
| Healthcheck defined, passing | Application-level readiness verified (en azından healthcheck'in test ettiği layer'da) |
| Healthcheck defined, failing | Container Up ama healthcheck pass etmiyor; restart trigger olabilir (eğer compose `unless-stopped` ile autoremove yoksa) |
| Healthcheck `disable: true` | Image'in default healthcheck'i devre dışı — explicit "ben tanımlamak istemiyorum" |

**Sahte healthcheck (anti-pattern)**:
- `pgrep -f process_name` → process up demektir, "ready to do real work" değil
- Örnek failure: opta_watcher process up ama SMB share unmount → "healthy" görünür ama işlev göremez
- Örnek failure: worker process up ama RabbitMQ connection drop → mesajları işlemez ama "healthy" gösterilseydi yanıltıcı olurdu (worker'da disable doğru karar)

**Doğru healthcheck prensipleri**:
1. **App-level readiness**: HTTP `/health` endpoint app'in gerçek state'ini (DB connection, message queue, downstream service'ler) reflect etmeli
2. **Side-effect-free**: Healthcheck DB write, queue publish, audit log yazımı yapmamalı (Heisenberg principle, audit noise)
3. **Idempotent**: 30s interval'da tekrar çalışınca aynı sonuç (state mutation yok)
4. **Cheap**: Subsecond response, expensive query kullanmaz
5. **Layered**: Eğer multi-component readiness gerekirse, en kritik layer'ı temsil et veya ayrı endpoint'lere böl

---

## 3. Per-Service Karar Matrisi

### bcms_prometheus

**Mevcut**: ❌ yok | **Karar**: ✅ HTTP healthcheck add

| Seçenek | Detay |
|---|---|
| `wget --spider http://127.0.0.1:9090/-/healthy` | Prometheus built-in `/-/healthy` endpoint, 200 OK döner |
| `wget --spider http://127.0.0.1:9090/-/ready` | Built-in `/-/ready` — readiness, başlangıç sırasında pending olabilir |

**Default önerim**: `/-/healthy` (basic up check). `/-/ready` start_period sonrası pass eder, `/-/healthy` daha hoşgörülü. Timing: 30s/5s/3 + start_period 10s.

### bcms_grafana

**Mevcut**: ❌ yok | **Karar**: ✅ HTTP healthcheck add

| Seçenek | Detay |
|---|---|
| `curl -fsS http://localhost:3000/api/health` | Grafana built-in, auth gerekmez, JSON response |
| `wget --spider http://localhost:3000/login` | Login page reachable check (alternatif) |

**Default önerim**: `/api/health`. Timing: 30s/5s/3 + start_period 10s.

### bcms_mailhog

**Mevcut**: ❌ yok | **Karar**: **environment-conditional default**

| Senaryo | Default |
|---|---|
| Dev-only deployment (mevcut compose) | **Skip** — mailhog dev SMTP test aracı, prod path'te yok, healthcheck overhead'i değer üretmez |
| Persistent staging/ops deployment | **Add** HTTP healthcheck (`/api/v2/messages` veya `/`) |

**Mevcut setup dev-only kabul edilir** → default skip. Eğer staging'de kalıcı çalıştırılırsa override.

### bcms_worker

**Mevcut**: 🚫 explicit `disable: true` (undokümante) | **Karar**: **(e) korunur + dokümante**

Worker'ın healthcheck'inin `disable: true` ile devre dışı bırakıldığı **bilinçli karar** — ama compose'da rasyonel comment yok. Doc'la formalleştirilir:

| Yaklaşım | Trade-off | Karar |
|---|---|---|
| (a) Process check `pgrep -f` | Sahte güven; RabbitMQ disconnected'da yine "healthy" | ❌ Reddedildi (opta_watcher'da hata) |
| (b) Minimal HTTP endpoint worker'da | API/worker split kuralı (CLAUDE.md) ihlali | ❌ Reddedildi |
| (c) File-based heartbeat | Recent activity check; partial coverage | ❌ Worker scope'u için yetersiz |
| (d) RabbitMQ self-publish + consume + read-only DB ping | Gerçek E2E kanıt; ek queue yönetimi; **side-effect-free, audit yazımı yok** | ⏳ Gelecek upgrade adayı; şu an overkill |
| **(e)** **Tanımsız + dokümante** | Honesty over coverage; sahte healthcheck üretilmez | ✅ **Default — mevcut karar** |

**`docker-compose.yml` worker bloğuna eklenecek comment** (implementation PR'da):
```yaml
worker:
  # Healthcheck explicitly disabled: worker'ın "ready"liği multi-layer
  # (RabbitMQ consumer registration + DB pool + ALS init + background
  # services). Naive process check (pgrep) sahte "healthy" üretir
  # (RabbitMQ disconnected'da yine pass). Gerçek E2E healthcheck için
  # ayrı tasarım gerekir (ops/REQUIREMENTS-HEALTHCHECK.md (d) seçeneği).
  # Şimdilik "Up" yeterli sinyal — sahte coverage yerine honest no-check.
  healthcheck:
    disable: true
```

### bcms_opta_watcher

**Mevcut**: ⚠️ sahte `pgrep -f opta_smb_watcher.py` | **Karar**: **iki yön — kullanıcı seçimi**

Bu sahte healthcheck mevcut: process up ama Python script SMB unmount sonrası retry loop'ta sıkışsa veya read1 password expire'sa yine "healthy" görünür.

| Seçenek | Detay | Trade-off |
|---|---|---|
| (i) `disable: true` + dokümante | Worker pattern'ine uyum, honest reporting | Güveni azaltır ama sahte sinyali kaldırır |
| (ii) Python script'e SMB connection check + last-poll-success file | Real readiness | Python kod değişikliği — ayrı kapsam |
| (iii) Mevcut sahte check'i koru | "Up = good enough" varsayımı | Yanıltıcı, audit raporu Section 6 false-positive listesinde "false positive değil, gerçekten sahte" olarak güncellenmeli |

**Default önerim**: **(i) disable + dokümante** — worker pattern'iyle tutarlı; (ii) gelecek upgrade adayı (Python kod değişikliği gerektirir). Eğer kullanıcı (ii)'yi tercih ederse ayrı kapsam.

---

## 4. Default Healthcheck Timing (uniform)

Yeni eklenen HTTP healthcheck'ler için (Prometheus, Grafana, opsiyonel mailhog):

| Parametre | Değer | Gerekçe |
|---|---|---|
| `interval` | 30s | API/web ile uyumlu; gözlemleme overhead'i düşük |
| `timeout` | 5s | HTTP roundtrip çok daha az olur; 5s defansif tampon |
| `retries` | 3 | Geçici network jitter'a hoşgörü; yine de 90s içinde fail eder |
| `start_period` | 10s | Prometheus/Grafana hızlı boot; api/keycloak gibi 30s/60s gerekmez |

**Override**: Eğer servis bazlı farklılık gerekirse (örn. Grafana plugins/datasources init uzun sürerse), per-service override edilir.

---

## 5. `depends_on` Conditional Health Inventory

Mevcut compose'da `depends_on` ile `condition: service_healthy` kullanan blok'lar:

| Service | Depends on | Condition |
|---|---|---|
| bcms_postgres_backup | postgres | service_healthy |
| bcms_keycloak | postgres | service_healthy |
| bcms_api | postgres + rabbitmq + keycloak | service_healthy (her biri) |
| bcms_worker | postgres + rabbitmq | service_healthy; api → service_started |
| bcms_web | api → service_healthy |
| bcms_opta_watcher | api + postgres → service_healthy |

**Gözlem**: Mevcut topology sound — kritik downstream'ler healthy beklenir. Yeni eklenen healthcheck'ler (Prometheus, Grafana) downstream'i değil — onları depend eden servis yok (Prometheus tüm sistemleri scrape eder, ama compose level dependency yok), bu yüzden dependency graph'a etkisi yok.

---

## 6. Implementation PR Sıralaması

### PR-1: Prometheus + Grafana healthcheck add (trivial, küçük)
- `docker-compose.yml` 2 servis bloğuna `healthcheck:` ekle
- Default timing
- Verify: `docker compose up -d --force-recreate prometheus grafana` sonrası `docker ps` ile "(healthy)" doğrula
- Audit raporu Appendix A #6 partial closure (Prometheus + Grafana)

### PR-2: Worker healthcheck disable comment + opta_watcher karar
- Worker compose bloğuna gerekçe comment'i ekle (yukarıdaki örnek)
- opta_watcher: kullanıcı kararına göre
  - (i) seçilirse: `pgrep` healthcheck → `disable: true` + comment
  - (ii) seçilirse: ayrı kapsam, Python kod değişikliği PR'ı
- Audit raporu Appendix A #6 closure (4 servis: prometheus, grafana, worker, opta_watcher)

### PR-3 (opsiyonel, deployment-conditional): Mailhog healthcheck
- Sadece persistent staging deployment'ta gerekirse
- Dev-only kabul edilirse skip

### PR-4 (gelecek, ayrı kapsam): Worker (d) RabbitMQ heartbeat e2e healthcheck
- Eğer (e) yetersiz olursa, ayrı tasarım turunda ele alınır
- Bu doc'un kapsamı değil

---

## 7. Test Prosedürü

### (1) Pre-test state
```bash
docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "bcms_(prometheus|grafana|mailhog|worker|opta_watcher)"
# Beklenen: prometheus/grafana "Up X (no health)", worker/mailhog "Up", opta_watcher "Up X (healthy)"
```

### (2) PR-1 sonrası
```bash
docker compose up -d --force-recreate prometheus grafana
sleep 35  # interval + start_period geçsin
docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "bcms_(prometheus|grafana)"
# Beklenen: ikisi de "Up X (healthy)"
```

### (3) PR-2 sonrası (opta_watcher (i) seçimi varsayalım)
```bash
docker compose up -d --force-recreate opta_watcher
docker ps --format "table {{.Names}}\t{{.Status}}" | grep bcms_opta_watcher
# Beklenen: "Up X" (healthy ifadesi yok — sahte healthcheck kaldırıldı)
```

### (4) Verify negative case (sahte healthcheck eski hâli ile karşılaştırma)
```bash
# (eğer reproduce etmek istersen) opta_smb_watcher.py'i kill et ama process'ler için ayrı bir worker process'i ile yer değiştirmeden bekleterek deneyebilirsin.
# Eski sahte (a) check: bu durumda yine "healthy" gösterirdi
# Yeni (i) disable: "Up" gösterir, "healthy" iddiası yok — drift dürüst
```

---

## 8. Implementation Trigger

PR-1 hazır:
- ✅ Prerequisite yok (Prometheus/Grafana endpoint'leri built-in)
- 🟢 Kullanıcı onayı yeterli

PR-2 için karar:
- 🔴 opta_watcher (i) vs (ii) seçimi (default: (i) disable + dokümante)
- 🔴 Worker comment dili onayı

PR-3 için:
- 🔴 Mailhog: dev-only mu persistent mi (default: dev-only → skip)

PR-4 (gelecek):
- Worker (d) heartbeat tasarımı — ayrı kapsam

---

## 9. Audit & Risk Etkisi

| Senaryo | Şimdiki durum | Pattern kurulduktan sonra |
|---|---|---|
| Section 8 #6 follow-up (prometheus, grafana healthcheck eksik) | 🔴 açık | ✅ kapatıldı (PR-1) |
| opta_watcher sahte healthcheck | ⚠️ "healthy" gösteriyor ama gerçek değil; audit raporu false-positive listesinde olmamalı | ✅ honest reporting (PR-2) |
| Worker disable kararı undokümante | ⚠️ rasyonel kayıp; gelecekte "neden disable?" soru doğar | ✅ comment + bu doc referansıyla netleşir |
| Mailhog dev-only doc'u | — | ✅ explicit decision: skip-default-if-dev-only |
| Sahte güven (genel) | ⚠️ pattern (`pgrep`) tekrar üretilebilir | ✅ doc anti-pattern'i belgeler |

**Toplam etki**: Section 8 #6 closure + Section 6 false-positive listesinde "opta_watcher Node service kalıntısı" item'ı zaten doğru ama "opta_watcher healthcheck sahte" yeni info — audit raporuna eklenebilir (ayrı küçük commit, bu doc kapsamı dışı veya ileride state-sync turunda).

---

## 10. Out of Scope

- Implementation (PR-1, PR-2, PR-3, PR-4)
- Worker (d) RabbitMQ heartbeat tasarımı (ayrı kapsam, gelecek upgrade adayı)
- opta_watcher Python script (ii) modification (ayrı kapsam, kullanıcı kararına bağlı)
- Alertmanager healthcheck (notification implementation `9be627a` ile gelir)
- Audit raporu Appendix A #6 status update (state sync ayrı tur, PR-1+PR-2 sonrası)
- Image-inherited healthcheck'lerin (postgres_backup) verify'ı (low-priority, current "(healthy)" yeterli)
