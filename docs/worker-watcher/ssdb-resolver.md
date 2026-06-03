# ssdb-resolver

## Özet
`provys_items`'taki materyalleri (DC kod) **SSDB**'de (medya veritabanı) çözüp medya GUID/ad/süre bilgisini
`ssdb_material_cache`'e yazan periyodik worker. "Eksik materyal" tespitinin temeli (Restore akışını besler).

## Nerede çalışır
- **Container:** worker (`ssdb-resolver`)
- Başlatma: `app.ts` → `startSsdbResolverWorker(app)` (yalnız `PROVYS_SSDB_RESOLVER=on` iken aktif)
- Heartbeat: `ssdb-resolver` (60sn / 3dk)

## Ne iş yapıyor
- Cache'i okuyup TTL dolmuş/çözülmemiş materyalleri SSDB'de sorgular (batch, concurrency limitli).
- Sonuç: `found` (medya GUID/ad/SOM/EOM/süre/frame-rate) ya da `missing_material`.
- Provys BXF sync sonrası **trigger** ile de tetiklenir (manuel "SSDB Toplu Yenile" + debounce).

## Neye bağlı
- **SSDB:** `SSDB_HOST/PORT/DATABASE/USER/PASSWORD` (harici medya DB). `PROVYS_SSDB_RESOLVER=on` flag.
- **DB:** `provys_items` (okur), `ssdb_material_cache` (yazar).
- **Tetikleyici:** periyodik tick + Provys sync sonrası event-trigger (debounce coalesce).
- TTL'ler: found 60dk, duration-unknown 120dk, missing 30dk, error 5dk (`SSDB_TTL_*`).

## Hata yönetimi
- Concurrency (`SSDB_LOOKUP_CONCURRENCY` default 5), batch size, error TTL ile geri-çekilme.

## İlgili kod
`apps/api/src/modules/ssdb/ssdb-resolver.worker.ts`, `ssdb.client.ts`, `ssdb-status.ts`, `ssdb-duration.ts`
