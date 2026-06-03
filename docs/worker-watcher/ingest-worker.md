# ingest-worker

## Özet
RabbitMQ'dan gelen ingest işlerini işleyen worker: medya dosyası üzerinde **QC** (ffprobe ile loudness/codec/süre)
ve gerektiğinde transcode (ffmpeg) yapar, sonuçları `qc_reports`'a yazar.

## Nerede çalışır
- **Container:** worker (`ingest-worker`) — event-driven RabbitMQ consumer
- Başlatma: `app.ts` → `startIngestWorker(app)`
- Heartbeat: `ingest-worker` (event-driven; boot'ta + her mesajda, stale 10dk)

## Ne iş yapıyor
- `queue.ingest.new` mesajını tüketir.
- **QC eşikleri:** loudness max **-16 LUFS** (min -30), min süre **60sn**, codec allow-list
  (`h264, h265/hevc, prores, dnxhd`).
- ffprobe ile analiz, ffmpeg ile (gerekirse) transcode; `qc_reports` + `ingest_jobs` durum güncelleme.

## Neye bağlı
- **RabbitMQ:** `queue.ingest.new` (tüketir), `queue.ingest.completed` (yayınlar).
- **DB:** `ingest_jobs`, `qc_reports`, `ingest_plan_items`.
- **Araçlar:** ffmpeg/ffprobe (`FFMPEG_PATH`/`FFPROBE_PATH` env ya da paket).
- **Dosya:** medya `WATCH_FOLDER`'dan (ingest-watcher yakalar).

## Hata yönetimi
- QC fail → ingest job `ISSUE`/`FAILED`, incident kaydedilebilir. Event-driven; idle iken heartbeat ticker.

## İlgili kod
`apps/api/src/modules/ingest/ingest.worker.ts`, `ingest.service.ts`
