# Ayarlar (Sistem Ayarları)

## Özet
Sistem entegrasyon/bağlantı ayarlarının tek yeri. Sol-menülü 3 bölüm: **Bağlantılar** (OPTA SMB + Avid + izleyiciler),
**Kayıt Portları**, **Lig / İçerik**.

## Erişim
- **Nav:** YÖNETİM > Ayarlar (ikon `settings`)
- **Route:** `/settings` → `SettingsComponent`
- **Yetki:** `SystemEng`

## Bölümler ve işlevler

### Bağlantılar
- **OPTA SMB Bağlantısı** — dosya sunucusu share/mount/credential. Kayıt sonrası `~/.bcms-opta.cred` güncellenir
  (OPTA Python watcher kullanır). `GET/POST /api/v1/opta/smb-config`.
- **Avid Bağlantı Ayarları** — IPWS (Ara+Restore: Interplay URL + kullanıcı/şifre + workspace) ve Cloud UX
  (Transfer: URL + realm + token). Sır alanlar GET'te maskeli. `GET/PUT /api/v1/avid/settings` → DB `avid_settings`;
  worker her tick'te okur. Boş alan env'e (`AVID_*`) düşer.
- **İzleyiciler — bilgi & durum** — BXF/Provys + ASRUN watcher: izlenen klasör (**editable**, canlı re-watch) +
  polling/debounce/eşzamanlılık (env, salt-okur) + **canlı durum rozeti** (worker `/health/live`'dan proxy).
  `GET /api/v1/watchers`, `PUT /api/v1/watchers/folder` → DB `watcher_settings`.

### Kayıt Portları
- Ingest kayıt portu seçenekleri (chip-ızgarası). `GET/PUT /api/v1/ingest/recording-ports` → `recording_ports`.

### Lig / İçerik
- "OPTA Lig Görünürlüğü" ve "Manuel Lig Yönetimi" admin ekranlarına link kartları.

## Veri kaynağı / API (özet)
`/opta/smb-config`, `/avid/settings`, `/watchers`, `/watchers/folder`, `/ingest/recording-ports`.
**DB:** `avid_settings`, `watcher_settings`, `recording_ports` (+ cred dosyası `~/.bcms-opta.cred`).
**Yetki (backend):** `PERMISSIONS.avidSettings` (SystemEng r/w), `PERMISSIONS.watchers` (SystemEng r/w).

## Bağlantılar (neye bağlı)
- **OPTA watcher** (Python) ← SMB cred. **Avid worker'ları** (search/restore/transfer) ← Avid ayarları.
- **provys/asrun-watcher** ← izlenen klasör (DB override, canlı). **Ingest** ← kayıt portları.

## İlgili kod
- Frontend: `apps/web/src/app/features/settings/settings.component.ts`
- Backend: `apps/api/src/modules/avid/avid.settings.ts`, `modules/watchers/`, `modules/opta/`, `modules/ingest/`
