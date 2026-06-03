# provys-watcher

## Özet
Provys playout **BXF playlist** (`.bxf`) dosyalarını izleyip içeriği `provys_items` tablosuna sync eden dosya
izleyici. Provys sekmesinin ve SSDB çözümlemenin veri kaynağı.

## Nerede çalışır
- **Container:** worker (`BCMS_BACKGROUND_SERVICES` listesinde `provys-watcher`)
- Başlatma: `app.ts` → `startProvysWatcher(app)`
- Heartbeat: `service-heartbeat` (`provys-watcher`, beklenen 30sn, stale 3dk)

## Ne iş yapıyor
- chokidar ile izlenen klasördeki `.bxf` dosyalarını yakalar (add/change/unlink).
- `extractFileCode` + `resolveChannel` → kanal; `extractScheduleDate` → tarih.
- Debounce (`fileCode + scheduleDate`) + ConcurrencyLimiter ile `syncChannelDate` çalıştırır →
  composed snapshot merge (target gün + önceki gün, latest-wins) → `provys_items` upsert.
- Audit actor: `system:provys-watcher` (ALS context).

## Neye bağlı
- **Klasör/mount:** `PROVYS_WATCH_FOLDER` (container `/app/tmp/provys`) ← host `PROVYS_HOST_MOUNT` (CIFS, ro).
  İzlenen klasör artık **DB override** (`watcher_settings.provys_watch_folder`) ile **canlı** değişebilir
  (supervisor ~30sn'de bir DB okur, klasör değişince yeniden izler — restart yok).
- **DB:** `provys_items` (yazar), `channels` (kanal eşleme), `watcher_settings` (klasör).
- **Tetikleyici:** dosya filesystem event'i (SMB'de `PROVYS_WATCHER_USE_POLLING=true` ile polling).

## Hata yönetimi / dayanıklılık
- Klasör yok/dizin değil → kontrollü warn, container çökmez (`folderExists=false` raporlanır).
- CONCURRENCY (default 3) ile Prisma connection pool koruması (P2024 önleme).
- `awaitWriteFinish` (3sn stabilite) — yarım yazılan dosya işlenmez.

## İlgili kod
`apps/api/src/modules/provys/provys.watcher.ts`, `provys.parser.ts`, `provys.channel-mapping.ts`,
`provys.service.ts`; supervisor: `apps/api/src/lib/watcher-supervisor.ts`; ayar: `modules/watchers/watcher.settings.ts`
