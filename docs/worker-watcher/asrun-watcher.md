# asrun-watcher

## Özet
Playout **sonrası** as-run log (`.bxf`) dosyalarını SMB Outbox/Ok mount'undan izleyip `asrun_items` tablosuna
yazan dosya izleyici. Asrun sekmesinin veri kaynağı. Provys watcher'dan tamamen ayrı.

## Nerede çalışır
- **Container:** worker (`asrun-watcher`)
- Başlatma: `app.ts` → `startAsrunWatcher(app)`
- Heartbeat: `asrun-watcher` (30sn / 3dk)

## Ne iş yapıyor
- chokidar ile `.bxf` as-run dosyalarını yakalar; `parseAsrunFilename` ile kanal/şema çözer.
- Dosya başına **idempotent upsert** (`ingestAsrunFile`) — composed merge YOK (Provys'ten farkı).
- Audit actor: `system:asrun-watcher`.

## Neye bağlı
- **Klasör/mount:** `ASRUN_WATCH_FOLDER` (container `/app/tmp/asrun`) ← host `ASRUN_HOST_MOUNT` (CIFS, ro).
  İzlenen klasör **DB override** (`watcher_settings.asrun_watch_folder`) ile **canlı** değişebilir (supervisor).
- **DB:** `asrun_items` (yazar), `channels`, `watcher_settings`.
- **Tetikleyici:** filesystem event (`ASRUN_WATCHER_USE_POLLING=true` ile polling).

## Hata yönetimi / dayanıklılık
- **DELETE yapılmaz** — dosya silinmesi geçmiş as-run kaydını düşürmez.
- Mount yoksa kontrollü warn, container çökmez. CONCURRENCY (default 3), debounce (1500ms), awaitWriteFinish.
- Dosya adı çözülemezse (non-asrun) sessizce skip.

## İlgili kod
`apps/api/src/modules/asrun/asrun.watcher.ts`, `asrun.filename.ts`, `asrun.service.ts`;
supervisor: `apps/api/src/lib/watcher-supervisor.ts`
