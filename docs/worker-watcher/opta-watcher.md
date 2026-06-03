# opta-watcher (OPTA sync)

## Özet
OPTA maç/lig verisinin sisteme alınması. **İki parça** vardır:
1. **Python container `bcms_opta_watcher`** — asıl iş: OPTA SMB klasöründen veriyi okuyup API'ye gönderir.
2. **Node `opta-watcher`** (api/worker içinde) — yalnız **cache yenileme + dizin sağlık kontrolü** shim'i (gerçek
   dosya izleme değil).

## Neden iki parça
OPTA dizini FUSE/SMB mount'unda **448K+ dosya** içerir; Node'da chokidar ile izlemek süreci D-state'e sokar.
Bu yüzden gerçek tarama **Python** container'da (polling), Node tarafı sadece dizin erişimini doğrular +
5 dakikada bir cache sıfırlar (`getOptaWatcherStatus` → connected/dir).

## Python container (asıl sync)
- **Container:** `bcms_opta_watcher` (`infra/docker/opta-watcher.Dockerfile`)
- **Okur:** OPTA SMB — `OPTA_SMB_SHARE/SUBDIR/USERNAME/PASSWORD/DOMAIN` (kalıcı yol
  `//beinfilesrv/BACKUPS/OPTAfromFTP20511`). Bu bilgiler **Ayarlar > OPTA SMB Bağlantısı**'ndan da gelir
  (`~/.bcms-opta.cred`).
- **Polling:** `OPTA_POLL_INTERVAL` (default **3600 sn / 1 saat**).
- **API'ye gönderir:** `POST /api/v1/opta/sync` — Bearer `OPTA_WATCHER_API_TOKEN` (= `OPTA_SYNC_SECRET`).
  Bu endpoint **rate-limit muaf** ve **batch sync**.

## Node shim (sağlık/cache)
- **Container:** api ve worker (`opta-watcher` heartbeat)
- Başlatma: `app.ts` → `startOptaWatcher(app)`
- `CACHE_REFRESH_MS` 5dk (cache sıfırla), `HEALTH_CHECK_MS` 30sn (dizin `fs.stat`).

## Neye bağlı / sonuç
- **DB:** `matches`, `leagues` (OPTA sync doldurur), dolaylı `live_plan_entries`/`schedules` (cascade güncelleme).
- **OPTA cascade** (`opta-cascade.service`) → mevcut live_plan_entries + schedules'ı (eventKey `opta:<uid>`)
  saat/takım/title günceller.
- **OPTA Lig Görünürlüğü / Manuel Lig Yönetimi** → çekilen liglerin görünürlük filtreleri.

## İlgili kod
- Python: `infra/docker/opta-watcher.Dockerfile` (+ watcher script)
- Node shim: `apps/api/src/modules/opta/opta.watcher.ts`
- Sync/cascade: `apps/api/src/modules/opta/` (routes, opta-cascade.service.ts)
