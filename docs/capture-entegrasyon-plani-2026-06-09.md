# BCMS — Avid Capture Entegrasyonu & "Capture Planlama" Sekmesi (Plan)

> **TASLAK.** Kod yazılmadan hazırlanan tasarım planı. Tarih: 2026-06-09.
> İlgili: Ingest sekmesi (`/ingest`), Avid MediaCentral Capture, Capture Web Service (Remote API).

---

## 1. Bağlam ve mevcut durum

Bugün BCMS'te ingest **birbirinden kopuk üç katman**:

1. **Plan katmanı (var, kalacak):** Canlı Yayın Plan (`live_plan_entries`) ve Stüdyo Plan,
   Ingest sekmesine düşer. Operatör satıra **kayıt portu + saat** atar →
   `ingest_plan_items` + `ingest_plan_item_ports`. Port çakışması DB'de GiST exclusion ile
   engellenir. **Bu sadece plan metadata'sı; hiçbir donanımı tetiklemez.**
2. **Dosya-tabanlı ingest (var, KALDIRILACAK):** Watch-folder / manuel dosya yolu → `ingest_jobs` →
   worker: checksum + ffprobe + 720p proxy + QC (`qc_reports`).
3. **Capture köprüsü (YOK):** Seçilen port + saat ile gerçek kayıt cihazını (Avid Capture/AirSpeed)
   çalıştıran bileşen yok. Port seçimi operasyonel olarak ölü.

**Bu doküman 2. katmanı kaldırıp 3. katmanı (Capture kontrolü) kuran planı tanımlar.**

## 2. "Capture" nedir (tespit edildi)

Sahadaki sistem (ekran görüntüsü + Programs & Features ile doğrulandı):
- **Avid MediaCentral | Capture v4.0.15.281** (Administrator + Client + Service) — Interplay Capture'ın yeni adı.
- Kayıt cihazları **Avid AirSpeed** (AirSpeed/AMS API Device Service), kaynak yönlendirme **Router**,
  depolama **NEXIS**, kayıt metadata'sı **Interplay** DB.
- Schedule uygulamasıyla önceden/yinelemeli kayıt; server başına 120 kanal.

## 3. Entegrasyon yüzeyi: Capture Web Service (Remote API)

Capture'a **programatik** kayıt yaptırmanın tek desteklenen yolu. (Manuel alternatif: operatörün
Capture Client'ta elle kayıt açması — otomasyon yok.)

| Konu | Değer | Kaynak |
|---|---|---|
| Protokol | **SOAP** — endpoint `http://<capture-host>:8080/ScheduleClient` (`ScheduleClientService`) | *interplay capture install.pdf* s.23 (.config örneği) |
| Yetenek | *"create, modify, and delete recordings"* + *"notifications of updates to recordings"* | *Capture_UG_v3_7.pdf* "Capture Web Service" |
| Port | **8080** (varsayılan), `Workgroup.Properties → com.avid.ingest.sdk.webservice.Port` ile değişir | *Capture_IA_3_6.pdf* s.115 |
| Lisans | **Ayrı, ücretsiz (non-charge)**; kurulumdan ÖNCE şart (yoksa boot loop) | *interplay capture install.pdf* s.8 · *Capture_IA_3_6.pdf* s.113 |
| Kurulum | Capture installer'da yalnız "Avid Interplay Capture Web Service" seçilir; Capture sunucusuna veya ayrı sunucuya (ASF + aynı Interplay workgroup) | *Capture_IA_3_6.pdf* s.113 |

**🔴 Ön-koşul (blokeli):** Bu Web Service şu an makinede **kurulu/lisanslı değil**. Avid Customer Care'e
lisans/kurulum talebi gönderildi (System ID 10577697412). Faz 2-3 buna bağlı.

## 4. Kilitlenen kararlar

| # | Karar |
|---|---|
| K1 | **Sadece ileri-tarihli planlama** (scheduled). "Şimdi başlat/durdur" (instant) YOK. |
| K2 | **Dosya-tabanlı ingest/QC tamamen kaldırılacak** (proxy/QC yeteneği bilinçli olarak gider). |
| K3 | **Mevcut `recording_ports` → Capture kanallarına eşlenecek** (yeni cihaz kataloğu değil). |
| K4 | Capture'a iki giriş: **plan-tabanlı** (port seçim hook'u) + **manuel** (bu sekme); ikisi de aynı Remote API. |
| K5 | Çıkış (BCMS→Capture) yalnız **plan mutasyon noktalarında** (port seçim endpoint'i + manuel form). Capture kendi zamanlayıcısıyla kaydı yürütür — gerçek-zamanlı timer YOK. |

## 5. Kapsam değişimi

| | Bileşen |
|---|---|
| ❌ **Kalkar** | dosya-tabanlı ingest worker (checksum/ffprobe/**720p proxy**/QC) · watch-folder watcher · `qc_reports` · `ingest_jobs`'un dosya anlamı · `/callback` proxy-QC kısmı · "Manuel Ingest (dosya yolu)" · ffmpeg bağımlılıkları |
| ✅ **Kalır** | `ingest_plan_items` · `ingest_plan_item_ports` · `recording_ports` · **Port Görünümü** (GiST çakışma) · live-plan + studio-plan projeksiyonu |
| ➕ **Gelir** | Capture Remote API (SOAP) istemcisi · **port ↔ Capture kanal eşlemesi** · **Manuel Capture Planlama** formu · kayıt durumu izleme (notification/poll) · mock/dry-run modu |

> "Ingest Planlama" sekmesi fiilen **"Capture Planlama"** olur (sekme adı değişimi — K-açık-3).

## 6. Port ↔ Capture kanal eşlemesi (K3)

- `recording_ports` kataloğuna **additive alan**: `capture_channel` (gerekiyorsa `capture_device_id`/server).
- Admin her BCMS portunu bir **Capture/AirSpeed kanalına** bağlar (tek seferlik konfig).
- Remote API kanal listesi sağlıyorsa dropdown oradan beslenir; yoksa elle string.
- Plan satırında port seçilince BCMS **hangi Capture kanalında** kayıt yapılacağını bilir.

## 7. Manuel Capture Planlama (bu sekme — K1)

**Form alanları:** Kaynak/Port (→Capture kanalı) · Başlangıç (tarih+saat) · Bitiş (tarih+saat) ·
Kayıt adı · (ops.) açıklama/metadata.

**Doğrulama:**
- bitiş > başlangıç
- **yalnız ileri tarih** (geçmiş/şimdi reddedilir — K1)
- port aktif + Capture kanalına eşli
- **çakışma:** aynı kanal + zaman penceresi başka kayıtta mı (mevcut GiST overlap mantığı yeniden kullanılır)

**Akış:** Submit → Remote API **create recording** → dönen **recording id** `capture_recordings`'e saklanır
(sonra modify/delete hedeflemek için).

## 8. Plan-tabanlı capture (port seçim hook'u — K4/K5)

- live-plan/studio-plan satırına **port+saat** atanınca (`PUT /api/v1/ingest/plan/:sourceKey`) →
  Capture **create** (ilk) / **modify** (saat/port değişince).
- Port boşaltılınca veya `DELETE /plan/:sourceKey` → Capture **delete**.
- Tek çıkış kancası; SOAP çağrısı **transaction commit sonrası** (DB tx içinde dış ağ çağrısı yok),
  best-effort + kendi senkron durumu (outbox paterni).

## 9. Durum izleme (inbound — sürekli)

- Capture "recording update notifications" → **dinleyici/poller worker** → kayıt durumunu
  (planlandı → kaydediyor → bitti/başarısız) `capture_recordings`'te güncelle → sekmede **Durum** kolonu canlı.
- Port seçim anına bağlı değil; sürekli akış.

## 10. Backend mimarisi

- **Yeni `apps/api/src/modules/capture/` modülü:**
  - `capture.soap.ts` — SOAP istemci (mevcut `avid.soap.ts` / IPWS paterni birebir).
  - `capture.config.ts` — host/port/kimlik (**Ayarlar**'dan; `avid.config.ts` + `avid_settings` paterni).
  - `capture.client.ts` — `createRecording / modifyRecording / deleteRecording / getStatus`; **mock adapter** (Remote API yokken `CAPTURE_MOCK=true`).
  - `capture.routes.ts` — manuel form endpoint'leri + liste.
  - `capture.service.ts` — saf iş mantığı; tüm yazımlar **audit extension** üzerinden.
- **Worker:** `capture-status-sync.service.ts` (notification veya periyodik poll; tek-replica singleton).
- **Settings:** Capture bağlantı ayarları (host/port/kullanıcı) — `avid_settings` benzeri tek-satır tablo veya mevcut Ayarlar'a alan.

## 11. Veritabanı değişiklikleri (hepsi `migrate deploy` — `migrate dev` YASAK)

- **DROP/deprecate:** `ingest_jobs` (file semantiği), `qc_reports`
- **ADD:** `recording_ports.capture_channel` · yeni **`capture_recordings`** tablosu
  (`planItemId?`, `captureChannel`, `name`, `plannedStart`, `plannedEnd`, `captureRecordingId`,
  `status`, `requestedBy`, `version`, timestamps, soft-delete)
- **DOKUNULMAZ:** `ingest_plan_items`, `ingest_plan_item_ports` (port alanları korunur)

> Not: Temiz yeni tablo (`capture_recordings`) tercih edildi — eski file-ingest semantiğiyle karışmasın.

## 12. Fazlama

| Faz | İş | Remote API gerekir mi? |
|---|---|---|
| **0** | port↔kanal alanı + Ayarlar'da Capture config + SOAP iskelet + **mock mod** | ❌ |
| **1** | Manuel Capture Planlama formu (mock create) + çakışma + Port Görünümü | ❌ |
| **2** | Gerçek create/modify/delete (plan-hook + manuel) | ✅ lisans/kurulum |
| **3** | Durum izleme (notification/poll) → canlı Durum kolonu | ✅ |
| **4** | Dosya ingest/QC **kaldırma** (worker/watcher/qc_reports/ffmpeg temizliği) | ❌ |

→ **Faz 0-1-4 hemen yapılabilir.** Faz 2-3 Avid Remote API lisans/kurulumuna bağlı; mock mod sayesinde
API gelmeden UI uçtan uca denenebilir.

## 13. Etkilenecek dosyalar (kod haritası)

**Kaldırılacak:**
- `apps/api/src/modules/ingest/ingest.worker.ts` (ffmpeg pipeline)
- `apps/api/src/modules/ingest/ingest.watcher.ts` (watch-folder)
- `qc_reports` kullanımı + ffmpeg/ffprobe bağımlılıkları

**Değişecek:**
- `apps/api/src/modules/ingest/ingest.routes.ts` — `PUT /plan/:sourceKey` + `DELETE` → Capture hook;
  `POST /` (file ingest) ve proxy/QC `/callback` kaldır
- `apps/api/src/modules/ingest/ingest.service.ts` — `triggerManualIngest` / `finalizeIngestJob` / `processIngestCallback` kaldır/yeniden tanımla
- `apps/api/prisma/schema.prisma` — `recording_ports.capture_channel`, `capture_recordings`; `ingest_jobs`/`qc_reports` drop
- `apps/web/src/app/features/ingest/ingest-list/ingest-list.component.ts` — "Manuel Ingest" → **Manuel Capture Planlama** formu
- `apps/web/src/app/features/ingest/ingest-port-board/` — Capture kanal etiketleri

**Yeni:**
- `apps/api/src/modules/capture/` (soap/client/config/routes/service + status-sync worker)
- Capture bağlantı ayarları (Ayarlar)

## 14. Açık teyitler / riskler

1. **TZ/format:** başlangıç/bitiş Europe/Istanbul; Remote API'nin (WSDL) beklediği zaman/kanal formatı kurulum sonrası netleşecek.
2. **Sekme adı** "Ingest Planlama" → "Capture Planlama" olsun mu (kozmetik).
3. **Proxy/QC kaybı:** dosya ingest kalkınca proxy/QC yeteneği gider (K2 ile kabul); başka yerde gerekirse ayrı ele alınmalı.
4. **Remote API bağımlılığı:** Faz 2-3 lisans/kuruluma bloke; o ana kadar mock.
5. **WSDL detayı:** create/modify/delete metod imzaları ve kanal/source isimlendirmesi Remote API kurulduktan sonra `ScheduleClient` WSDL'inden çıkarılacak (SDK + örnek client `TestCaptureWebClient` talep edildi).

---

## Kaynaklar
- Kod: `apps/api/src/modules/ingest/*`, `apps/web/src/app/features/ingest/*`, `apps/api/prisma/schema.prisma`
- Avid: *Capture_UG_v3_7.pdf*, *Capture_IA_3_6.pdf*, *interplay capture install.pdf* (`/home/ubuntu/Desktop/capture/`)
- Sistem: MediaCentral | Capture 4.0.15.281 · System ID 10577697412
