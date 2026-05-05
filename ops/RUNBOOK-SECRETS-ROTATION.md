# BCMS — Secrets Rotation Runbook

**Sahip:** SystemEng / Ops
**Periyot:** 90 gün (quarterly), production deploy ve incident sonrası ad-hoc.
**Son rotate:** _(buraya tarih yaz)_

Bu doküman BCMS production deployment'ının tüm "rotate-edilmeli" credential'larını
ve nasıl rotate edileceğini listeler. Audit raporu **Madde 10** (skip listesi) +
GitGuardian alarmı (2026-05-04) kapsamında oluşturuldu.

> **Hızlı kural:** Bir secret tek bir yerde değil; **en az iki yerde** birbirine
> bağımlıdır (örn. plaintext + hash, plaintext + base64). Rotate ederken hepsini
> aynı anda yenile, kısmen güncelleme = downtime.

---

## 0. Secret İnventeri

| Secret | Yer | Tür | Bağımlılık |
|--------|-----|-----|------------|
| `POSTGRES_PASSWORD` | `.env` | random | DATABASE_URL ile aynı plaintext |
| `RABBITMQ_PASSWORD` | `.env` | random | RABBITMQ_URL ile aynı plaintext |
| `KEYCLOAK_ADMIN_PASSWORD` | `.env` | random | Keycloak admin UI giriş |
| `INGEST_CALLBACK_SECRET` | `.env` | hex 32 | Ingest worker HMAC |
| `OPTA_SYNC_SECRET` | `.env` | hex 32 | OPTA watcher Bearer |
| `OPTA_WATCHER_API_TOKEN` | `.env` | hex 32 | OPTA watcher → API auth (= OPTA_SYNC_SECRET değeri) |
| `METRICS_TOKEN` | `.env` | hex 32 | API `/metrics` Bearer auth |
| `GRAFANA_PASSWORD` | `.env` | random | Grafana admin UI |
| `PROMETHEUS_HEALTHCHECK_AUTH_B64` | `.env` | base64 | Healthcheck (= base64(admin:plaintext)) |
| `PROMETHEUS_BASIC_AUTH_HASH` | `.env` + `infra/prometheus/web-config.yml` | bcrypt | UI/API basic auth (= htpasswd(plaintext)) |
| `OPTA_SMB_PASSWORD` | `.env` | external | SMB share credential |
| TLS server private key | `infra/tls/server/server.key` | RSA | nginx TLS termination (.gitignore'da, repo dışı) |

`changeme_*`, `<GENERATE_ME_*>` placeholder'ları **production'da kabul edilmez**.
İlk deploy + her rotate'ta hepsini gerçek değerle doldur.

---

## 1. Prometheus Basic Auth Rotate (en sık)

GitGuardian alarmı tam burayı işaret etti — placeholder hash repo'daydı.

### Adımlar

```bash
# 1. Yeni plaintext password üret
NEW_PROM_PASS=$(openssl rand -base64 24)
echo "New password: $NEW_PROM_PASS"   # bir kerelik kaydet (1Password / Vault / vb.)

# 2. bcrypt hash hesapla
NEW_PROM_HASH=$(htpasswd -nbBC 10 admin "$NEW_PROM_PASS" | cut -d: -f2)
echo "New hash: $NEW_PROM_HASH"

# 3. Healthcheck base64 hesapla
NEW_PROM_B64=$(echo -n "admin:$NEW_PROM_PASS" | base64)
echo "New healthcheck b64: $NEW_PROM_B64"

# 4. .env güncelle
#    PROMETHEUS_HEALTHCHECK_AUTH_B64=$NEW_PROM_B64
#    PROMETHEUS_BASIC_AUTH_HASH=$NEW_PROM_HASH

# 5. infra/prometheus/web-config.yml içindeki bcrypt'i değiştir:
#    basic_auth_users:
#      admin: $NEW_PROM_HASH
sed -i.bak "s|admin: \\\$2b\\\$10\\\$.*|admin: $NEW_PROM_HASH|" infra/prometheus/web-config.yml

# 6. Restart
docker compose up -d prometheus

# 7. Doğrula
curl -fsSk -u "admin:$NEW_PROM_PASS" http://127.0.0.1:9090/-/ready
docker inspect bcms_prometheus --format='{{json .State.Health}}' | jq

# 8. Eski password'le 401 al
curl -sSk -u "admin:OLD_PASSWORD" -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9090/-/ready
# → 401 beklenen
```

### Doğrulama

- Container healthy: `docker compose ps` → `bcms_prometheus (healthy)`
- Yeni password ile login: `curl -fsS -u admin:<new>` → 200
- Eski password ile login: `curl -u admin:<old>` → 401

---

## 2. Grafana Admin Password

```bash
NEW_GRAFANA_PASS=$(openssl rand -base64 24)
# .env: GRAFANA_PASSWORD=$NEW_GRAFANA_PASS
docker compose up -d grafana
# Grafana UI'da yeni password ile login dene.
```

> **Not:** Grafana ilk boot'ta admin user'ı oluşturur. Sonradan değişen
> `GF_SECURITY_ADMIN_PASSWORD` env'i bazı sürümlerde mevcut user'ı update etmez
> — gerekirse `grafana-cli admin reset-admin-password` ile manuel reset.

---

## 3. PostgreSQL / RabbitMQ Password

**DİKKAT:** Bu rotation `DATABASE_URL` / `RABBITMQ_URL` ile birden fazla container'da
referans edilen plaintext'i değiştirir. Tüm bağımlı container'ları aynı anda restart.

```bash
NEW_PG_PASS=$(openssl rand -base64 24)
# .env: POSTGRES_PASSWORD ve DATABASE_URL içindeki password aynı olmalı

# Postgres user password'ünü DB'de güncelle
docker compose exec postgres psql -U postgres -c \
  "ALTER USER bcms_user PASSWORD '$NEW_PG_PASS';"

# .env güncelle, sonra:
docker compose up -d api worker postgres_backup keycloak
```

`KEYCLOAK_DB` aynı user'a bağlı; Keycloak da restart edilmeli.

RabbitMQ: kullanıcı password değişikliği için `rabbitmqctl change_password`.
Ya da daha basit: RabbitMQ container restart, env'den okur.

---

## 4. INGEST_CALLBACK_SECRET / OPTA_SYNC_SECRET / METRICS_TOKEN

```bash
NEW_TOKEN=$(openssl rand -hex 32)
# .env'i güncelle, sonra:
docker compose up -d api worker opta-watcher prometheus
```

OPTA_SYNC_SECRET = OPTA_WATCHER_API_TOKEN — ikisi aynı değer (docker-compose.yml).
İngest callback secret yalnızca worker → API çağrısında kullanılır.

---

## 5. KEYCLOAK_ADMIN_PASSWORD

Keycloak admin user'ı UI'da reset edilmeli **veya** Keycloak boot'unda env okunur.
Keycloak 23'te ilk boot'ta env'i kullanır; sonradan UI'dan değiştirilirse env DB ile
çakışmaz (env priority değil). Production'da:

1. Keycloak admin UI'dan password reset (`Manage Account → Account Security`).
2. `.env`'de `KEYCLOAK_ADMIN_PASSWORD`'ü aynı yeni değerle güncelle (kayıt için).
3. Container restart şart değil; env sadece ilk-boot bootstrap için.

---

## 6. TLS Server Cert/Key

Detay: `ops/REQUIREMENTS-TLS-INTERNAL-CA.md`. Server cert expiry: 2028-05-03.

```bash
# CA generate script:
./infra/tls/scripts/generate-ca.sh
# Output: infra/tls/server/server.key + server-fullchain.crt
docker compose up -d web   # nginx volume mount restart
```

---

## 7. Rotation Çek-Listesi (Quarterly)

- [ ] PROMETHEUS_HEALTHCHECK_AUTH_B64 + PROMETHEUS_BASIC_AUTH_HASH (web-config.yml)
- [ ] GRAFANA_PASSWORD
- [ ] METRICS_TOKEN
- [ ] INGEST_CALLBACK_SECRET
- [ ] OPTA_SYNC_SECRET / OPTA_WATCHER_API_TOKEN
- [ ] KEYCLOAK_ADMIN_PASSWORD (UI reset + .env sync)
- [ ] POSTGRES_PASSWORD (annual; DB user ALTER + tüm bağımlı container restart)
- [ ] RABBITMQ_PASSWORD (annual; üstte aynı pattern)
- [ ] TLS server cert (yıllık 1-2 kez kontrol; expiry < 60 gün ise yenile)
- [ ] OPTA_SMB_PASSWORD (external; SMB owner ile koordineli)

---

## 8. Incident Response

Eğer secret leak şüphesi varsa (GitGuardian alarmı, log leak, vb.):

1. **Hemen rotate** (yukarıdaki ilgili adım).
2. **Audit:** `audit_logs` tablosunda son 24h "system" user'lı access scan.
3. **Network audit:** ilgili container access log (`/api/v1/*`, `/metrics`, Grafana).
4. **Forensic:** placeholder leak ise impact düşük; gerçek password leak ise
   bağımlı tüm sistem owner'lara bilgi (Keycloak admin → realm export sızdı mı?).
5. **Post-mortem:** kayıt; `ops/post-mortems/<date>-<title>.md` formatında.

---

## 9. Audit / Versioning Notları

- `.env` **asla** repo'ya commit edilmez (`.gitignore`'da).
- `.env.example` placeholder içerir; gerçek değer YOK.
- `infra/prometheus/web-config.yml` mevcut hâlinde placeholder bcrypt hash içerir
  (yorum bloğu yapısını uyarır). Production deploy script'i `htpasswd` ile
  yeniden generate etmeli (ileride: init container veya entrypoint envsubst).
- Bu runbook'un kendisi her rotation sonrası **tarih güncellenmesi** içermeli
  (üstteki "Son rotate").

---

## 10. Vault / External Secret Manager (gelecek)

Production scale büyüdüğünde aşağıdaki migration düşünülmeli:

- **HashiCorp Vault**: dynamic DB credentials, TTL'li secret leasing.
- **Docker Swarm secrets** veya **Kubernetes Secrets**: file-mount, rotation
  per-deploy.
- **AWS Secrets Manager / GCP Secret Manager**: cloud-native.

BCMS internal tool olduğu için (~10-50 kullanıcı, on-prem deployment) bu
runbook + manuel rotation şu an yeterli. Vault entegrasyonu ayrı PR.
