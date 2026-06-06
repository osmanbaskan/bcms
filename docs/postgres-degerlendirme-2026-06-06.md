# PostgreSQL Değerlendirme ve Öneri Raporu

**Sistem:** BCMS · `bcms_postgres` (Docker)
**Tarih:** 2026-06-06
**Kapsam:** Mevcut limitler + kaynak durumu + tuning/operasyon önerileri
**Not:** Bu rapor yalnız tespit ve öneridir — **hiçbir yapılandırma değişikliği uygulanmamıştır.**

---

## 1. Yönetici Özeti

PostgreSQL **16.13**, **stok-default** ayarlarla çalışıyor. Veritabanı **119 MB** (çok küçük),
host'ta **15.5 GiB RAM** ve **~800 GB boş disk** var; cache hit oranı **%99.46**. Yani
performans/kapasite açısından **acil bir sorun yok**. Asıl iyileştirme alanları **güvenlik
(timeout'lar), izolasyon (container kaynak limiti) ve gözlemlenebilirlik (slow-query + metrik)**.

Bellek tuning'i şu an **gereksiz** (kanıt: cache hit %99.46, DB tamamen RAM'e sığıyor).

---

## 2. Mevcut Durum (ölçülen gerçek değerler)

### 2.1 Yapılandırma limitleri (PostgreSQL 16.13)

| Parametre | Değer | Açıklama |
|-----------|-------|----------|
| max_connections | **100** (−3 superuser ⇒ ~97 kullanılabilir) | Şu an **22/100** kullanımda (18 idle pool + aktif) |
| shared_buffers | **128 MB** | PG default |
| effective_cache_size | **4 GB** | default |
| work_mem | **4 MB** | default (sıralama/hash başına) |
| maintenance_work_mem | **64 MB** | default |
| max_wal_size / min_wal_size | **1 GB / 80 MB** | default |
| max_worker_processes | 8 · paralel 8 · gather başına 2 | default |
| wal_level | replica | |
| **statement_timeout** | **0 (sınırsız)** | ⚠️ Sorgu süresiz koşabilir |
| **idle_in_transaction_session_timeout** | **0 (sınırsız)** | ⚠️ Açık transaction süresiz tutabilir |
| temp_file_limit | -1 (sınırsız) | |

### 2.2 Kaynak ve kapasite

- **DB boyutu:** 119 MB. En büyük tablolar: `provys_items` 50 MB · `asrun_items` 38 MB ·
  `audit_logs_2026_06` 7.6 MB · `matches` 1.7 MB.
- **Disk:** 916 GB toplam, **801 GB boş (%8 dolu)**.
- **Host RAM:** 15.5 GiB. Postgres anlık kullanım: **~200 MiB (%1.3)**.
- **Cache hit oranı:** **%99.46** (bellek fazlasıyla yeterli).
- **Container kaynak limiti:** **YOK** (mem/cpu cap = 0 ⇒ host'un tamamını kullanabilir).
- **Yedek:** `bcms_postgres_backup` healthy; günlük 03:00 + aylık (`infra/postgres/backups/{daily,monthly}`) — **çalışıyor**.
- **Eklenti:** `pg_stat_statements` **yüklü değil**.
- **İzleme:** Prometheus + Grafana var ama **postgres_exporter yok** (PG metriği toplanmıyor).

---

## 3. Öneriler (önem sırasıyla)

### Öncelik 1 — Güvenlik timeout'ları · YÜKSEK / düşük risk
Kaçak sorgu veya açık transaction'ın süresiz takılıp bağlantı tüketmesini engeller
(restore-loop benzeri olaylara karşı koruma).
- `idle_in_transaction_session_timeout = 60s` (global — güvenli).
- `statement_timeout = 60s` **yalnız uygulama rolünde**
  (`ALTER ROLE bcms_user SET statement_timeout = '60s';`) — migration / superuser /
  uzun raporlar etkilenmesin diye **global verilmez**.

### Öncelik 2 — Container kaynak limiti · YÜKSEK
Postgres'in cap'i yok; yük altında host belleğini çekip diğer servisleri (api/keycloak/grafana)
aç bırakabilir. 119 MB DB için fazlasıyla güvenli sınır:
- `deploy.resources`: **limit mem 2 GB / cpu 2**, **reservation mem 512 MB**.
- Aynı yaklaşım diğer ağır container'lara da önerilir.
- Uygulama: `docker-compose.yml` + `docker compose up -d` (recreate gerekir).

### Öncelik 3 — pg_stat_statements · ORTA / yüksek teşhis değeri
En yavaş ve en çok çağrılan sorguları görünür kılar (örn. restore'un tekrarlı submit'i
anında fark edilirdi).
- `shared_preload_libraries = 'pg_stat_statements'` (restart gerekir) + `CREATE EXTENSION pg_stat_statements;`

### Öncelik 4 — Postgres monitoring · ORTA
Mevcut Grafana'ya **postgres_exporter** eklenip dashboard bağlanmalı: bağlantı (×/100),
cache hit, deadlock, yavaş sorgu, WAL, replication. Sorunları erken yakalar.

### Öncelik 5 — Yedek geri-yükleme tatbikatı · ORTA
Yedekler alınıyor ✅ ama **test edilmemiş yedek = yedek değil**. Periyodik olarak bir yedek
boş bir DB'ye restore edilip RPO/RTO doğrulanmalı, sonuç belgelenmeli.

---

## 4. Bilinçli Olarak ÖNERİLMEYENLER (kanıta dayalı)

- **shared_buffers / work_mem büyütmek** — cache hit %99.46, DB 119 MB; şu an **sıfır fayda**.
  DB birkaç GB'a ulaşırsa yeniden değerlendirilir.
- **PgBouncer / max_connections artışı** — 22/100 kullanımda, geniş pay var. Replika
  sayısı arttıkça izlenir; şimdilik gereksiz.
- *(Küçük istisna: ağır Provys/asrun rapor sorguları diske taşarsa `work_mem` 16–32 MB'a
  çekilebilir — önce pg_stat_statements ölçümüne bakılmalı.)*

---

## 5. Önerilen Uygulama Sırası (yapılırsa)

1. Timeout'lar (Öncelik 1) — anlık, en güvenli, en yüksek değer.
2. pg_stat_statements (Öncelik 3) — bir restart penceresinde.
3. postgres_exporter + dashboard (Öncelik 4).
4. Container limitleri (Öncelik 2) — bakım penceresinde recreate ile.
5. Yedek restore tatbikatı (Öncelik 5) — periyodik rutin.

> Tüm öneriler düşük-orta riskli ve geri alınabilirdir. Bu rapor kapsamında **hiçbiri
> uygulanmamıştır**; uygulama ayrı bir onay/iş emriyle yapılmalıdır.
