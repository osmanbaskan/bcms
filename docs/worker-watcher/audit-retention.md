# audit-retention

## Özet
`audit_logs` tablosundaki **eski denetim kayıtlarını** periyodik olarak silen temizlik job'ı (retention).
Tablonun sınırsız büyümesini önler.

## Nerede çalışır
- **Container:** worker (`audit-retention`)
- Başlatma: `app.ts` (background services)
- Heartbeat: `audit-retention` (günlük; expected 24h, stale 25h)

## Ne iş yapıyor
- `AUDIT_RETENTION_DAYS` (default **90**) gününden eski audit kayıtlarını **batch** (10.000) halinde siler.
- Cutoff TR gün başı (İstanbul TZ; `istanbulTodayDate()` + `+03:00`, CLAUDE.md TZ lock'a uygun).
- **Dry-run:** `AUDIT_RETENTION_DRY_RUN=true` → sadece kaç satır silineceğini loglar, silmez.

## Neye bağlı
- **DB:** `audit_logs` (siler).
- **Tetikleyici:** günde bir tick.

## Hata yönetimi
- Batch silme (delete_many, cutoff WHERE). Dry-run ile güvenli önizleme.

## İlgili kod
`apps/api/src/modules/audit/audit-retention.job.ts`
