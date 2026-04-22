# BCMS Local Services

Bu klasor, BCMS API ve Web servislerini terminale bagli kalmadan calistirmak icindir.

## Onerilen Kurulum

```bash
sudo ./ops/scripts/bcms-install-system-services.sh
```

Kurulumdan sonra servisler otomatik baslar. PC restart oldugunda API ve Web yine otomatik ayaga kalkar.

User-level systemd kullanmak istersen:

```bash
./ops/scripts/bcms-install-user-services.sh
```

Sudo yoksa fallback kurulum:

```bash
./ops/scripts/bcms-install-cron-fallback.sh
```

Bu kurulum `crontab @reboot` ile supervisor baslatir. Supervisor API veya Web kapanirsa tekrar baslatir.

## Gunluk kullanim

```bash
./ops/scripts/bcms-status.sh
./ops/scripts/bcms-restart.sh
./ops/scripts/bcms-logs.sh
./ops/scripts/bcms-logs.sh api
./ops/scripts/bcms-logs.sh web
./ops/scripts/bcms-opta-status.sh
```

`bcms-start.sh`, `bcms-restart.sh` ve kurulum scriptleri once `packages/shared`, `apps/api` ve `apps/web` build eder; sonra servisleri baslatir.

## Adresler

- Web: http://172.28.204.133:4200
- API: http://172.28.204.133:3000

## Systemd servisleri

- `bcms-opta-mount.service`
- `bcms-api-dev.service`
- `bcms-web-dev.service`

API servisi `/mnt/opta-backups` mount hazir olmadan baslamayacak sekilde ayarlanmistir.

## Canli Yayin Plani Kapsami

Canli yayin plani ekranindan eklenen kayitlar genel yayin plani kaydi olarak
kullanilmaz. Bu kayitlar sadece Raporlama ve Ingest akislarinda kullanilir.

Teknik kolon:

```text
schedules.usage_scope = 'live-plan'
```

Varsayilan normal yayin kayitlari:

```text
schedules.usage_scope = 'broadcast'
```

Karar mekanizmasi metadata degil bu DB kolonudur. Eski kayitlarda metadata
icinde kalmis `usageScope` alanlari temizlenmistir, filtreleme icin
kullanilmamalidir.

DB constraint:

```text
schedules_usage_scope_check -> broadcast | live-plan
```

Ilgili kontroller:

```bash
curl -fsS 'http://127.0.0.1:3000/api/v1/schedules?usage=live-plan&pageSize=1'
curl -fsS 'http://127.0.0.1:3000/api/v1/schedules/ingest-candidates?pageSize=1'
curl -fsS 'http://127.0.0.1:3000/api/v1/schedules/reports/live-plan?pageSize=1'
```
