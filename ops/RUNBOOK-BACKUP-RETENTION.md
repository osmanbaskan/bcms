# Backup Retention Runbook

**Konum**: `infra/postgres/backups/`
**Sidecar**: `bcms_postgres_backup` (`prodrigestivill/postgres-backup-local:16`)
**Format**: Plain SQL (`.sql`) — MED-INF-002 fix (2026-05-05) ile `.sql.gz`'den geçildi

## Rotation Policy (sidecar otomatik)

| Klasör | Politika | Env değişkeni |
|---|---|---|
| `daily/` | Son 7 gün + bugün = 8 dosya | `BACKUP_KEEP_DAYS=7` |
| `weekly/` | Son 4 hafta | `BACKUP_KEEP_WEEKS=4` |
| `monthly/` | Son 6 ay | `BACKUP_KEEP_MONTHS=6` |
| `manual/` | Manuel — operatör sorumlu | — |
| `last/` | En son alınan (rolling) | — |

**Schedule**: `0 3 * * *` (her gün 03:00 TR)
**TZ**: `Europe/Istanbul`
**Beklenen günlük boyut**: ~180 MB (bcms) + ~320 KB (keycloak)

## Beklenen Disk Kullanımı (steady-state)

- daily: 8 × ~180 MB = 1.4 GB
- weekly: 4 × ~180 MB = 720 MB
- monthly: 6 × ~180 MB = 1.1 GB
- last: 2 × ~180 MB = 360 MB
- manual: değişken (forensic dump'lar)

**Steady-state toplam tahmini**: ~3.6 GB (manuel hariç)

## Alarm Eşiği

- Sidecar log: backup başarısız mı (`docker compose logs postgres_backup --since=24h | grep -i error`)
- Disk free: < 10 GB → manuel araştırma (host'ta `df -h /home`)
- Manual backup: 1 GB'tan büyükse temizlik aday

## Manuel Cleanup (acil durum)

```bash
# Eski .sql.gz formatları (varsa, format geçişi sonrası kalmış)
docker compose exec -T --user root postgres_backup sh -c '
  find /backups -name "*.sql.gz" -type f -delete
  find /backups -name "*-latest.sql.gz" -type l -delete
'

# 30+ gün eski daily dosyaları (sidecar 7 gün politikasını ihlal eden manuel artıklar)
docker compose exec -T --user root postgres_backup sh -c '
  find /backups/daily -name "bcms-*.sql" -mtime +30 -delete
'
```

## Restore

Bkz: `infra/postgres/RESTORE.md`

Aktif latest:
- `daily/bcms-latest.sql` → en son daily
- `last/bcms-latest.sql` → rolling last
- `weekly/bcms-latest.sql` → hafta sonu
- `monthly/bcms-latest.sql` → ay sonu

## Off-host Backup (önerilir, henüz aktif değil)

```bash
# Örnek: AWS S3 sync (cron daily)
aws s3 sync /home/ubuntu/Desktop/bcms/infra/postgres/backups/ \
  s3://bcms-backups/ --delete --storage-class STANDARD_IA
```

Yapılandırma için ayrı PR + IAM credentials gerekir. Şu an: yalnız host-içi backup.

## 2026-05-29 Cleanup Kaydı

K12 fix (2026-05-29 03:30 TR) ile yapılan temizlik:
- Tüm `.sql.gz` format dosyaları silindi (sidecar 2026-05-05 sonrası `.sql` üretiyor)
- Stale `*-latest.sql.gz` symlink'leri silindi (5 May tarihinden kalmıştı, yanıltıcı)
- Disk serbest: ~300 MB (hardlink referansları paylaşıyordu)
- Pre-cleanup boyut: 1.9 GB → 1.6 GB
