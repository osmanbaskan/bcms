# Off-Host Backup — S3-Compatible Gereksinimleri

> **Status**: 📋 Requirements doc (implement edilmedi). Implement ayrı tur, credential gelene kadar bekliyor.
> **Audit referansı**: `BCMS_AUDIT_REPORT_2026-05-01.md` Section 2 — OPS-CRITICAL aday: off-host backup eksikliği.

## Amaç

Mevcut `postgres_backup` sidecar local Docker volume'a (`infra/postgres/backups/`) günlük 03:00'te pg_dump alıyor. Disk arızası / host kaybı / dosya sistemi corruption senaryolarında **hem production data hem backup birlikte kaybolur**. Off-host kopya ile bu blast radius'u kapat.

## Karar — S3-Compatible

Seçilen yaklaşım: **S3-compatible object storage** (MinIO / Backblaze B2 / AWS S3 / Wasabi / Cloudflare R2).

**Niye S3-compatible** (rsync, borg yerine):
- Standartlaştırılmış API (boto3, AWS CLI, mc, rclone hepsi destekler)
- Retention/lifecycle policy native (otomatik eski-versiyon silme)
- Versioning native (yanlışlıkla overwrite koruma)
- Encryption-at-rest sağlayıcılar tarafından default veya yapılabilir
- Restore yeri sadece bcms host'una bağlı değil — başka host'tan da indirilebilir

## Karar Verilmesi Gerekenler (kullanıcı input)

| Karar | Seçenekler | Default önerim |
|---|---|---|
| **Provider** | MinIO (self-host) / B2 / AWS S3 / Wasabi / R2 | B2 (en ucuz, S3-compatible API, native versioning) |
| **Bucket adı** | tek bucket / env-bazlı (`bcms-backup-prod`, `bcms-backup-staging`) | `bcms-backup-prod` |
| **Region** | provider'a göre (B2: us-west-002, AWS: eu-central-1, vb.) | provider'ın TR'ye en yakın region'u |
| **Retention** | 30 / 60 / 90 / 365 gün | **90 gün** (mevcut local retention 7 günlük + 4 hafta + 6 ay; off-host orta-vadeli sigorta) |
| **Encryption** | server-side (SSE-S3) / client-side (`age`/`gpg`) | server-side (basit, provider-managed key) — eğer compliance gerekirse client-side |
| **Sync sıklık** | Her local backup sonrası / saatlik / günlük 1 kez | **Günlük 1 kez** (local backup tamamlandıktan sonra ~04:00) |
| **Sync tool** | `mc` (MinIO client) / `rclone` / `aws-cli` / `restic` | **`rclone`** (universal, S3-compatible + provider-specific optimizations) |

## Gerekli Env Değişkenleri (`.env` ekleme şablonu)

```bash
# S3-Compatible Backup
S3_BACKUP_ENDPOINT=https://s3.us-west-002.backblazeb2.com    # provider endpoint
S3_BACKUP_BUCKET=bcms-backup-prod
S3_BACKUP_ACCESS_KEY=__set_via_secret_manager__
S3_BACKUP_SECRET_KEY=__set_via_secret_manager__
S3_BACKUP_REGION=us-west-002                                 # provider region
S3_BACKUP_PREFIX=postgres/                                    # bucket içinde path prefix
S3_BACKUP_RETENTION_DAYS=90
S3_BACKUP_SYNC_HOUR=4                                         # local backup sonrası
```

**Secret yönetimi**: `S3_BACKUP_ACCESS_KEY` ve `S3_BACKUP_SECRET_KEY` `.env` dosyasına yazılmamalı (git'e gitmesin). Önerilen: Docker secret veya host-level env.

## Implementation Çerçevesi (henüz yapılmadı)

İki olası implementasyon:

### Seçenek A — Yeni sidecar container (`bcms_s3_sync`)

```yaml
# docker-compose.yml ek servis
s3_sync:
  image: rclone/rclone:latest
  container_name: bcms_s3_sync
  restart: unless-stopped
  environment:
    RCLONE_CONFIG_S3_TYPE: s3
    RCLONE_CONFIG_S3_PROVIDER: ${S3_BACKUP_PROVIDER:-Backblaze}
    RCLONE_CONFIG_S3_ACCESS_KEY_ID: ${S3_BACKUP_ACCESS_KEY}
    RCLONE_CONFIG_S3_SECRET_ACCESS_KEY: ${S3_BACKUP_SECRET_KEY}
    RCLONE_CONFIG_S3_ENDPOINT: ${S3_BACKUP_ENDPOINT}
    RCLONE_CONFIG_S3_REGION: ${S3_BACKUP_REGION}
  volumes:
    - ./infra/postgres/backups:/backups:ro
  entrypoint: |
    sh -c '
      while true; do
        sleep $((($(date -d "tomorrow 04:00" +%s) - $(date +%s)) % 86400))
        rclone sync /backups s3:${S3_BACKUP_BUCKET}/${S3_BACKUP_PREFIX} \
          --transfers 4 --checkers 8 --log-level INFO
      done
    '
```

### Seçenek B — Existing `postgres_backup` post-hook

`prodrigestivill/postgres-backup-local` image'inin `POSTBACKUP_COMMAND` env'ini kullan — backup tamamlandıktan sonra rclone çağrı.

```yaml
postgres_backup:
  environment:
    POSTBACKUP_COMMAND: |
      rclone sync /backups s3:${S3_BACKUP_BUCKET}/${S3_BACKUP_PREFIX} \
        --transfers 4 --log-level INFO || echo "S3 sync failed (warn)"
```

**Önerim Seçenek A** — sidecar daha temiz ayrım, postgres_backup downtime'ı S3 sync gecikmesinden etkilenmez.

## Restore Drill — S3'ten Restore (ileride)

```bash
# 1. S3'ten en son dump'ı çek
rclone copy s3:bcms-backup-prod/postgres/last/bcms-latest.sql.gz /tmp/

# 2. Local restore (RESTORE.md'deki standart prosedür)
cat /tmp/bcms-latest.sql.gz | docker exec -i bcms_postgres psql -U bcms_user -d bcms
```

Quarter'lık restore drill: scratch DB'ye S3'ten restore + smoke test (`infra/postgres/RESTORE.md` "Recovery drill" bölümüne off-host varyant eklenecek).

## Implementation Trigger

Bu doküman tamamlanmış değil — **kullanıcı kararları + credential bekliyor**:

1. Provider seçimi (default: B2)
2. Bucket adı + region (default: `bcms-backup-prod`, en yakın region)
3. Retention süresi (default: 90 gün)
4. Encryption (default: server-side)
5. Access key / secret key (host secret manager'a gelecek)
6. Implementation seçeneği (A veya B; default: A — sidecar)

Yukarıdaki kararlar verilir verilmez `docker-compose.yml` ek servis + `.env` template + restore drill update + `ops/RESTORE.md` off-host varyant tek PR olarak gelir.

## Audit & DR Etkisi (mevcut durum vs hedef)

| Senaryo | Şimdiki durum | S3-Backup sonrası |
|---|---|---|
| Yanlışlıkla DROP TABLE | ✅ Local backup'tan restore (7 gün) | ✅ Aynı + S3'ten 90 gün |
| Disk arızası | ❌ **Hem prod hem backup kayıp** | ✅ S3'ten restore (off-host) |
| Host kaybı (fire/theft) | ❌ Tüm veri kayıp | ✅ S3'ten restore (off-host) |
| Ransomware (host'a şifrelenir) | ❌ Backup da şifrelenir | ✅ S3 versioning ile pre-encrypt versiyon recover |
| DB corruption | ✅ Local backup yeterli | ✅ Aynı |

OPS-CRITICAL aday durumu, S3-backup implement edildiğinde **kapanır**.
