# transfer-worker (Restore Kademe 3 — Transfer)

## Özet
Restore akışının **3. kademesi**: online'a alınan materyali **MediaCentral Cloud UX / CTMS** üzerinden playout'a
transfer eder (`submitSTPJob` / SendToPlayback). `transfer_jobs` kuyruğunu işler.

## Nerede çalışır
- **Container:** worker (`transfer-worker`)
- Başlatma: `app.ts` → `startTransferWorker(app)`
- Heartbeat: `transfer-worker` (5sn / 60sn)

## Ne iş yapıyor
- `transfer_jobs` (Kademe 3) bekleyen işleri alır.
- Avid Cloud UX/CTMS `submitSTPJob` ile transfer başlatır (hedef cihaz/profil: `AVID_STP_DEVICE/PROFILE`, primary
  MCR + failover yedek).
- Tamamlanınca `transfer.completed` event.

## Neye bağlı
- **Avid Cloud UX/CTMS:** URL + realm + **token** (Ayarlar > Avid Cloud UX / `AVID_CLOUDUX_*`).
  `getAvidAdapter(app.prisma)` her tick'te DB ayarını okur (Ayarlar'dan kaydet → bir sonraki tick'te etkili).
- **DB:** `transfer_jobs` (okur/yazar), `restore_jobs`.
- **RabbitMQ:** `queue.transfer.completed`.
- TLS: `AVID_CLOUDUX_INSECURE_TLS=true` (iç CA). Mock mode default ON.

## İlgili kod
`apps/api/src/modules/transfer/transfer.worker.ts`, `modules/avid/avid.client.ts` (CTMS/STP)
