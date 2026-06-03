# search-worker (Restore Kademe 1 — Ara)

## Özet
Restore akışının **1. kademesi**: eksik materyali **Avid Interplay (IPWS)** arşivinde arar. `search_jobs`
kuyruğunu işler; bulunan asset'i restore'a hazır hale getirir.

## Nerede çalışır
- **Container:** worker (`search-worker`)
- Başlatma: `app.ts` → `startSearchWorker(app)`
- Heartbeat: `search-worker` (5sn / 60sn)

## Ne iş yapıyor
- `search_jobs` tablosundaki bekleyen işleri (poll) alır.
- Avid IPWS araması yapar (asset/material bulma); sonucu (asset bulundu/BULUNAMADI) job'a yazar.
- Bulunursa restore (Kademe 2) için zemin hazırlar.

## Neye bağlı
- **Avid IPWS:** Interplay URL + kullanıcı/şifre + workspace (Ayarlar > Avid ya da `AVID_*` env).
- **DB:** `search_jobs` (okur/yazar), `restore_jobs`.
- **Tetikleyici:** kullanıcı Restore ekranından arama tetikler → kuyruk → worker.
- Mock mode: `RESTORE_AVID_MOCK=true` (default) → gerçek Avid'e gitmez.

## İlgili kod
`apps/api/src/modules/search/search.worker.ts`, `modules/avid/avid.client.ts`
