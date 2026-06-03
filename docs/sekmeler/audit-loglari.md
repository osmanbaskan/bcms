# Audit Logları

## Özet
Sistemdeki tüm yazma işlemlerinin (CREATE/UPDATE/DELETE/UPSERT) **denetim kaydı**. Kim, ne zaman, hangi varlığı,
ne değiştirdi (before/after payload). Prisma audit extension üzerinden otomatik yakalanır.

## Erişim
- **Nav:** YÖNETİM > Audit Logları (ikon `history`)
- **Route:** `/audit-logs` → `AuditLogComponent`
- **Yetki:** `SystemEng`

## Ne yapıyor
- Audit kayıtlarını listeler/filtreler (entity_type, action, kullanıcı, tarih, ID).
- Satır genişletilince before/after payload görülür.

## Veri kaynağı / API
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| Audit listesi | `GET /api/v1/audit` | `audit` |

**DB tablosu:** `audit_logs` (kolonlar: `entity_type, entity_id, action, before_payload, after_payload, user, ip_address, timestamp`). Production'da **aylık partition**.

## Bağlantılar (neye bağlı)
- **Tüm modüller** → Prisma `$extends` audit plugin (`apps/api/src/plugins/audit.ts`) her yazmada kayıt üretir.
- **audit-retention** (worker) → 90 günden eski kayıtları temizler (`AUDIT_RETENTION_DAYS`).
- **audit-partition** (worker) → aylık partition'ları önceden oluşturur.
- ⚠️ **Raw SQL (TRUNCATE/migration) audit'i atlar** — bu yolla yapılan silmeler kayda girmez (bkz 2026-06-01 incident).

## İlgili kod
- Frontend: `apps/web/src/app/features/audit/`
- Backend: `apps/api/src/modules/audit/`, `apps/api/src/plugins/audit.ts`
