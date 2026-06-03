# ingest-watcher

## Özet
Ingest için izlenen klasöre (`WATCH_FOLDER`) düşen **medya dosyalarını** yakalayıp ingest akışını (QC/transcode)
tetikleyen dosya izleyici.

## Nerede çalışır
- **Container:** worker (`ingest-watcher`)
- Başlatma: `app.ts` → `startIngestWatcher(app)`
- Heartbeat: `ingest-watcher` (30sn / 3dk)

## Ne iş yapıyor
- chokidar ile `WATCH_FOLDER`'a eklenen dosyaları (`add`) yakalar.
- Dosyayı ingest pipeline'ına sokar → RabbitMQ üzerinden **ingest-worker** QC/transcode yapar.
- `ignoreInitial: false` → başlangıçta mevcut dosyalar da işlenir.

## Neye bağlı
- **Klasör:** `WATCH_FOLDER` (container `/app/tmp/watch`, docker volume `ingest_watch`).
- **RabbitMQ:** ingest job kuyruğuna mesaj (`queue.ingest.new`).
- **DB:** `ingest_jobs` (dolaylı, worker üzerinden).
- **Tetikleyici:** filesystem event (`awaitWriteFinish` 3sn stabilite).

## Hata yönetimi
- awaitWriteFinish ile yarım dosya işlenmez. Heartbeat ile izlenir.

## İlgili kod
`apps/api/src/modules/ingest/ingest.watcher.ts`
