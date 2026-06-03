# restore-worker (Restore Kademe 2 — Restore)

## Özet
Restore akışının **2. kademesi**: bulunan asset'i Avid arşivinde **offline → online** geri yükler
(`SubmitJobUsingProfile` + `GetJobStatus`). `restore_jobs` kuyruğunu işler.

## Nerede çalışır
- **Container:** worker (`restore-worker`)
- Başlatma: `app.ts` → `startRestoreWorker(app)`
- Heartbeat: `restore-worker` (5sn / 60sn)

## Ne iş yapıyor
- `restore_jobs` (Kademe 2) bekleyen işleri alır.
- Avid IPWS `SubmitJobUsingProfile` ile restore başlatır, `GetJobStatus` ile durum poll eder (offline→online).
- Tamamlanınca transfer (Kademe 3) için hazır hale getirir; `restore.completed` event.

## Neye bağlı
- **Avid IPWS:** Interplay bağlantısı (Ayarlar > Avid / `AVID_*`). `getAvidAdapter(prisma)` her tick'te DB ayarını okur.
- **DB:** `restore_jobs` (okur/yazar).
- **RabbitMQ:** `queue.restore.completed` (yayınlar).
- **Tetikleyici:** Kademe 1 (search) sonrası / kullanıcı tetiklemesi.

## Hata yönetimi
- Avid job fail → restore_job durum/attempt güncelleme. Mock mode default ON.

## İlgili kod
`apps/api/src/modules/restore/restore.worker.ts`, `modules/avid/avid.client.ts`
