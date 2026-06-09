# Transfer Durum Takibi — Gerçek RUNNING→COMPLETED (Plan)

> **TASLAK.** Kod yazılmadan tasarım. Tarih: 2026-06-09.
> İlgili: Restore sekmesi K3 transfer · `apps/api/src/modules/avid/avid.ctms.ts` · `transfer.worker.ts`.

---

## 1. Mevcut durum (V1 — "fire-and-forget")

- K3 transfer = Avid **Cloud UX / CTMS `submitSTPJob`** (HTTPS REST), hedef artık **cluster VIP `172.26.33.56`**.
- `submitSTPJob` 200 → `{ jobId, mcdsStatusURL }` döner; `jobId` → `transfer_jobs.avid_job_id`.
- **`ctmsPollTransferStatus` her zaman `done` döndürüyor** → submit kabul = BCMS'te DONE. Avid'deki **gerçek** sonuç izlenmiyor.
- Bilinen sınır (2026-06-01 keşif): CTMS'te per-job REST status rel'i yok; `mcds-host:8443` erişilemedi; Cloud UX UI canlı güncellemeyi **WebSocket** ile alıyor.

→ Sonuç: BCMS, transfer'i submit eder etmez "bitti" sayıyor; gerçek RUNNING→COMPLETED/FAILED'ı **operatör Cloud UX Process ekranından** görüyor.

## 2. Hedef
BCMS transfer'in gerçek durumunu yansıtsın: **kuyrukta → işleniyor (mixdown/encode) → tamamlandı / başarısız.** Operatör ayrı ekrana bakmak zorunda kalmasın; başarısızlıkta bildirim alsın.

## 3. Durum kaynağı seçenekleri (canlı keşif şart — `.56` cluster)
| # | Kaynak | Not |
|---|---|---|
| 1 | **`mcdsStatusURL`** (submitSTPJob yanıtında zaten dönüyor) | En doğrudan. Daha önce `mcds-host:8443` erişilemedi → **.56 cluster'da tekrar denenmeli** (VIP üzerinden erişilebilir olabilir). |
| 2 | **CTMS Process job-list REST** | `avid.pam.stp` / process servisinde job durumu sorgusu varsa. |
| 3 | **Cloud UX WebSocket `broadcastNotifications`** | UI'nin kullandığı canlı kanal; en güvenilir ama en karmaşık (WS auth + abonelik). |

**Öncelik:** 1 > 2 > 3 (erişilebilirliğe göre). Faz-0 keşfi hangisinin çalıştığını belirler.

## 4. Tasarım
- **`ctmsPollTransferStatus(avidJobId, mcdsStatusURL)`** stub'ı gerçek implementasyonla değiştir:
  - Seçilen kaynaktan durum çek → map: `queued|running|processing → 'running'`, `completed → 'done'`, `failed|error|cancelled → 'failed'`.
  - `avidAccessToken` cookie (mevcut ROPC token manager) ile auth; TLS insecure paterni aynen.
- **Worker hazır:** `transfer.worker.ts`'de `status==='RUNNING' && avidJobId` → `pollTransferStatus` → `done/failed/running` dalı zaten var (bkz. düzeltilen avidJobId akışı). Sadece **stub'ı doldurmak** yeterli.
- **`mcdsStatusURL` sakla:** `transfer_jobs`'a additive alan `mcds_status_url` (poll hedefi; `avid_job_id` yanında).
- **Terminal/timeout:** belirli süre `running` kalırsa (profil süresi × faktör) → FAILED + bildirim (sonsuz running olmasın).

## 5. Veri değişikliği (additive, `migrate deploy`)
- `transfer_jobs.mcds_status_url` (nullable)
- (ops.) `transfer_jobs.status_detail` (Avid'in ham durum metni — UI tooltip)

## 6. Fazlama
| Faz | İş |
|---|---|
| **0 — Canlı keşif** | `.56`'da submitSTPJob → dönen `mcdsStatusURL`'e GET dene; Process REST var mı; WS endpoint'i. Hangisi çalışıyor netleşsin. (Tek gerçek belirsizlik bu.) |
| **1** | Çalışan kaynakla `ctmsPollTransferStatus` gerçek implementasyon + `mcds_status_url` alanı |
| **2** | Worker poll → gerçek `done/failed/running`; UI'da canlı durum kolonu |
| **3** | Terminal/timeout + başarısızlıkta bildirim |

## 7. Capture planıyla örtüşme
Bu "Avid durum ingestion" altyapısı, **capture entegrasyon planındaki §9 durum izleme** ihtiyacıyla aynı kapıya çıkıyor. Tek bir **"Avid notification/poll" katmanı** hem transfer (CTMS job) hem capture (recording) durumlarını besleyebilir → ortak worker olarak tasarlanmalı.

## 8. Riskler / açık noktalar
- **En büyük belirsizlik:** hangi status API'si gerçekten erişilebilir/çalışıyor — Faz-0 canlı keşfine bağlı. `.56` cluster VIP `mcds-host`'a erişim sağlayabilir (tek-node `.57`'de sağlamıyordu).
- WS yolu auth/abonelik karmaşık; REST/`mcdsStatusURL` varsa tercih edilir.
- Mevcut yanlış-`done` (V1) bazı operasyonel kararları etkiliyor olabilir; gerçek durum gelince akış daha doğru olur.
- Token: poll çağrıları da `avidAccessToken` ister → self-healing token manager yeniden kullanılır (ekstra iş yok).

---

## Kaynaklar
- `apps/api/src/modules/avid/avid.ctms.ts` (`postSubmitStpJob` → `mcdsStatusURL`), `avid.client.ts` (`ctmsPollTransferStatus` stub)
- `apps/api/src/modules/transfer/transfer.worker.ts` (poll dalı)
- Capture planı: `docs/capture-entegrasyon-plani-2026-06-09.md` §9
