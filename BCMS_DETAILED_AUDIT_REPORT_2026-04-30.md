# BCMS Kapsamlı Kod & Altyapı Audit Raporu

> **Tarih:** 2026-04-30  
> **Kapsam:** `apps/api/src` (46 dosya), `apps/web/src` (62 dosya), `packages/shared` (76 dosya), Prisma schema, migrations, Docker/Infra  
> **Mod:** Read-Only (hiçbir dosya değiştirilmemiştir)  
> **Yöntem:** Statik kod analizi, mimari kural denetimi, güvenlik taraması, performans & concurrency incelemesi

---

## ⚠ Triage Notu (2026-04-30, post-rapor)

Bu rapor 138 bulgu içeriyor; severity kalibrasyonu zayıf. **Triage sonrası gerçek aksiyon listesi 4 madde** — uygulanma durumu aşağıda. Detay: `ops/NOTES_FOR_CODEX.md` "4-Madde Audit Triage" bölümü.

| Madde | Rapor sınıfı | Gerçek sınıf | Durum | Commit |
|---|---|---|---|---|
| Auth interceptor refresh failure (CRIT-003) | CRITICAL | CRITICAL | ✅ DONE | `51306ec` |
| RabbitMQ confirm channel (CRIT-001) | CRITICAL | CRITICAL | ✅ DONE | `acde48e` |
| Ingest plan race (CRIT-002) | CRITICAL | **FALSE POSITIVE** | ✅ ANALIZ | DB GiST exclusion (mig `20260426`) zaten korumakta |
| Yedekleme yok (CRIT-011) | CRITICAL | OPS-CRITICAL | ✅ DONE | `5f6e728` |

**Yanlış sınıflandırılan diğer CRITICAL'lar (4 adet false positive):**
- **CRIT-006/007/008/009** afterClosed/onAction "leak" — RxJS auto-complete-once observable, leak değil. Hepsi false positive.

**Severity inflation (4 adet abartılmış):**
- **CRIT-004** Token refresh interval not cleared → LOW (SPA bootstrap)
- **CRIT-005** canEdit non-reactive → MEDIUM
- **CRIT-013** matchId shared type eksik → MEDIUM (compile-time)
- **CRIT-012** statement_timeout yok → MEDIUM (hardening; gözlemlenen kriz yok)

**HIGH backlog** (kalan ~10 madde): trustProxy, Keycloak port 0.0.0.0 → 127.0.0.1, FFmpeg timeout, Excel export error handling, Keycloak N+1 caching, soft-delete unique conflict, hardcoded timezone, OPTA sync transaction concurrency, baseline migration, off-host backup copy. Haftalık 1-2 madde temposu.

---

## 1. Executive Summary

| Önem Derecesi | API | Frontend | DB/Infra | Shared | Toplam |
|---------------|-----|----------|----------|--------|--------|
| **CRITICAL**  | 2   | 7        | 3        | 1      | **13** |
| **HIGH**      | 6   | 13       | 7        | 4      | **30** |
| **MEDIUM**    | 17  | 11       | 15       | 7      | **50** |
| **LOW**       | 21  | 9        | 10       | 5      | **45** |
| **Toplam**    | 46  | 40       | 35       | 17     | **138** |

**En kritik 5 risk:**
1. **Veri kaybı:** RabbitMQ mesajları onay beklenmeden (confirm) gönderiliyor; broker çökerse mesajlar sessizce kayboluyor.
2. **Yetkilendirme açığı:** Angular `auth.interceptor` token yenileme başarısız olursa isteği **eski/geçersiz token ile göndermeye devam ediyor**.
3. **Race condition:** Ingest plan item çakışma kontrolü atomik değil; iki paralel istek aynı kayıt portunu çakışan zamana atayabiliyor.
4. **Bellek sızıntısı:** Açılan her MatDialog'un `afterClosed()` aboneliği unsubscribe edilmiyor.
5. **Altyapı:** Production'da veritabanı yedekleme, migration baseline ve query timeout yok.

---

## 2. CRITICAL Bulgular (13 adet)

### CRIT-001 — RabbitMQ `sendToQueue` Onaysız / Mesaj Kaybı ✅ RESOLVED (commit `acde48e`)
| | |
|:---|:---|
| **Dosya** | `apps/api/src/plugins/rabbitmq.ts` |
| **Satır** | 116 |
| **Kategori** | Mesaj Dayanıklılığı / Güvenlik |
| **Açıklama** | `channel.sendToQueue()` `await` edilmiyor ve `confirmSelect()` açık değil. Kanal tamponu dolu veya kanal kapalıysa mesaj sessizce düşer. Bildirim, ingest ve audit arka-plan işleri kaybolabilir. |
| **Düzeltme** | `ConfirmChannel` kullan; `await channel.sendToQueue(...)` yap veya `amqp-connection-manager` ile confirm kanalı kullan. |

### CRIT-002 — Ingest Plan Item Çakışma Kontrolü Atomik Değil (Race Condition) ❌ FALSE POSITIVE
| | |
|:---|:---|
| **Dosya** | `apps/api/src/modules/ingest/ingest.routes.ts` |
| **Satır** | 377–428 |
| **Kategori** | Eşzamanlılık / Veri Bütünlüğü |
| **Açıklama** | `findFirst` ile çakışma kontrolü yapılıp ardından `upsert` atılıyor; işlem (transaction) yok. İki paralel PUT aynı portu aynı zamana atayabilir. |
| **Düzeltme** | `$transaction` (Serializable) içine al veya PostgreSQL exclusion constraint (`tstzrange`) ekle. |
| **POST-RAPOR ANALİZ** | **Migration `20260426000000_ingest_port_no_overlap` zaten DB-level GiST exclusion constraint kuruyor** (`recording_port`, `day_date`, `int4range(start,end,'[)')`). `isPlanTimeConstraintError` (line 111) P2002/P2004'ü yakalayıp 409 dönüyor. Race senaryosunda kaybeden istek sadece daha generic bir hata mesajı alır; **veri korunması yapısal**. Action gerekmedi. |

### CRIT-003 — Angular Auth Interceptor Token Yenileme Başarısız Olursa Sessiz İletim ✅ RESOLVED (commit `51306ec`)
| | |
|:---|:---|
| **Dosya** | `apps/web/src/app/core/interceptors/auth.interceptor.ts` |
| **Satır** | 24–40 |
| **Kategori** | Güvenlik / Yetkilendirme |
| **Açıklama** | `keycloak.updateToken()` hata verirse `catchError` bloğunda `next(req)` çağrılıyor; yani **eski veya boş token ile istek sunucuya gidiyor**. 401 alınıyor ama bu istek zararlı payload taşıyorsa güvenlik riski oluşturur. |
| **Düzeltme** | Token yenileme başarısız olursa `throwError(() => err)` dön ve kullanıcıyı login'e yönlendir; asla `next(req)` çağırma. |

### CRIT-004 — Token Refresh Interval Asla Temizlenmiyor
| | |
|:---|:---|
| **Dosya** | `apps/web/src/app/app.config.ts` |
| **Satır** | 41 |
| **Kategori** | Bellek Sızıntısı |
| **Açıklama** | `window.setInterval` ile token yenileme döngüsü oluşturuluyor ama interval ID saklanmıyor/temizlenmiyor. Testlerde veya micro-frontend senaryolarında interval'ler yığılıyor. |
| **Düzeltme** | Interval ID'yi sakla; `onDestroy` hook veya teardown fonksiyonunda `clearInterval` yap. |

### CRIT-005 — `canEdit` Computed Bir Kere Değerlendikten Sonra Cache'leniyor
| | |
|:---|:---|
| **Dosya** | `apps/web/src/app/features/studio-plan/studio-plan.component.ts` |
| **Satır** | 133–138 |
| **Kategori** | Sinyal Kullanımı / Yetkilendirme Hatası |
| **Açıklama** | `canEdit` `computed()` sinyali `keycloak.getKeycloakInstance().tokenParsed` (sıradan nesne, reaktif değil) okuyor. Oturum sırasında kullanıcı grupları değişirse `canEdit` asla güncellenmez. |
| **Düzeltme** | `canEdit`'i reaktif bir `userGroups` sinyaline bağla veya şablonda doğrudan `computed()` olmadan oku. |

### CRIT-006 → CRIT-009 — Ortak Not (RxJS Auto-Complete)

Aşağıdaki 4 madde **aynı kavram hatasından** doğmuş false positive'lerdir.

**Sebep:** `MatDialogRef.afterClosed()` ve `MatSnackBarRef.onAction()` her ikisi de **complete-once** observable'lardır:
- `afterClosed()` → internal `_afterClosed` Subject; dialog kapandığında `.next() + .complete()` çağrılır
- `onAction()` → action tetiklendiğinde veya snackbar dismiss'te complete olur

Bir Observable complete ettiğinde subscription **otomatik teardown** yapar (RxJS contract). `take(1)` eklemek functional no-op — sadece readability tercihi olabilir, leak fix DEĞİL.

Edge case: `duration: 0` veya manuel dismiss bekleyen snackbar'da subscription o süre boyunca yaşar. Bu "leak" değil, "lifecycle-bound subscription" — LOW seviyesinde defensive cleanup, CRITICAL değil.

**Ortak verdict:** Hiçbir aksiyon gerekmedi. Rapor sınıflandırması yanlış.

---

### CRIT-006 — MatDialog `afterClosed()` Abonelikleri Asla Temizlenmiyor (Schedule List) ❌ FALSE POSITIVE
| | |
|:---|:---|
| **Dosya** | `apps/web/src/app/features/schedules/schedule-list/schedule-list.component.ts` |
| **Satır** | 2239, 2255, 2270, 2285 |
| **Kategori** | Bellek Sızıntısı |
| **Açıklama** | Ekle, Düzenle, Teknik, Sorun Bildir dialog'ları her açıldığında `afterClosed().subscribe(...)` çağrılıyor; hiçbiri unsubscribe edilmiyor. Uzun oturumlarda bellek yığılıyor. |
| **Düzeltme** | `.pipe(take(1))` ekle veya `Subscription` nesnesinde toplayıp `ngOnDestroy`'da temizle. |

### CRIT-007 — MatDialog `afterClosed()` Aboneliği Temizlenmiyor (Booking List) ❌ FALSE POSITIVE
| | |
|:---|:---|
| **Dosya** | `apps/web/src/app/features/bookings/booking-list/booking-list.component.ts` |
| **Satır** | 384 |
| **Kategori** | Bellek Sızıntısı |
| **Açıklama** | `openDialog` içinde `ref.afterClosed().subscribe(...)` unsubscribe edilmiyor. |
| **Düzeltme** | `take(1)` ekle. |

### CRIT-008 — MatDialog `afterClosed()` Aboneliği Temizlenmiyor (Users List) ❌ FALSE POSITIVE
| | |
|:---|:---|
| **Dosya** | `apps/web/src/app/features/users/users-list/users-list.component.ts` |
| **Satır** | 408, 415 |
| **Kategori** | Bellek Sızıntısı |
| **Açıklama** | `openEdit` ve `openNewUser` dialog abonelikleri temizlenmiyor. |
| **Düzeltme** | `take(1)` ekle. |

### CRIT-009 — Snackbar `onAction()` Aboneliği Her Silmede Yeniden Oluşturuluyor ❌ FALSE POSITIVE
| | |
|:---|:---|
| **Dosya** | `apps/web/src/app/features/schedules/schedule-list/schedule-list.component.ts` |
| **Satır** | 2322 |
| **Kategori** | Bellek Sızıntısı |
| **Açıklama** | `deleteSchedule` içinde `snackRef.onAction().subscribe(...)` her silme işleminde yeni abonelik oluşturuyor ve temizlemiyor. |
| **Düzeltme** | `take(1)` kullan veya aboneliği yönet. |

### CRIT-010 — Eksik Baseline Migration: Sıfır DB'de `migrate deploy` Çalışmaz
| | |
|:---|:---|
| **Dosya** | `apps/api/prisma/migrations/` |
| **Kategori** | Altyapı / Veritabanı |
| **Açıklama** | İlk migration `20260416000000_add_matches`. Temel tabloların (`schedules`, `bookings`, `channels` vb.) **oluşturma migration'ı yok**. Yeni bir PostgreSQL instance'ında `prisma migrate deploy` başarısız olur. |
| **Düzeltme** | Mevcut production DB'den baseline migration oluştur (`prisma migrate dev --create-only`) veya `prisma migrate resolve --applied <baseline>` ile idempotent hale getir. |

### CRIT-011 — Otomatik Yedekleme ve Felaket Kurtarma Yok ✅ RESOLVED-PARTIAL (commit `5f6e728`)
| | |
|:---|:---|
| **Dosya** | `docker-compose.yml`, `infra/postgres/` |
| **Kategori** | Altyapı / Veri Kaybı |
| **Açıklama** | Yedekleme konteyneri, `pg_dump` cron, WAL arşivleme, replikasyon yok. `postgres_data` yerel Docker volume'ü; disk arızası = tam veri kaybı. |
| **Düzeltme** | `pg_dump` cron sidecar veya `offen/docker-volume-backup` ekle; WAL'ı object storage'a akıt; PITR runbook'u yaz ve test et. |
| **POST-RAPOR DURUM** | `postgres_backup` sidecar eklendi (`prodrigestivill/postgres-backup-local:16`), daily 03:00, retention 7/4/6, restore drill 110 → 110 OK. Runbook: `infra/postgres/RESTORE.md`. **Off-host kopya hâlâ yok** (rsync/S3/borg) — follow-up. WAL/PITR de follow-up. |

### CRIT-012 — Veritabanı Query Timeout Yok — Runaway Query Tüm Havuzu Kitleyebilir
| | |
|:---|:---|
| **Dosya** | `apps/api/src/plugins/prisma.ts`, `docker-compose.yml` |
| **Kategori** | Altyapı / Performans |
| **Açıklama** | `statement_timeout` PostgreSQL'de ayarlanmamış; Prisma'da query-level timeout yok. Yavaş rapor sorgusu bağlantı havuzunu (10 API, 5 worker) sonsuza dek tutabilir. |
| **Düzeltme** | PostgreSQL'de `statement_timeout=30000` (30 sn) ayarla veya Prisma middleware ile `SET statement_timeout` gönder. API için `connection_limit`'i 20'ye çıkar. |

### CRIT-013 — `Schedule` Shared Tipinde `matchId` Eksik — Derleme/Çalışma Zamanı Uyumsuzluğu
| | |
|:---|:---|
| **Dosya** | `packages/shared/src/types/schedule.ts` |
| **Satır** | 5 |
| **Kategori** | Tip Güvenliği / Sözleşme |
| **Açıklama** | Prisma `Schedule` modelinde `matchId Int?` var ama shared `Schedule` interface'inde yok. API yanıtları bu alanı içerdiğinde frontend tip güvenliği bozulur. |
| **Düzeltme** | `matchId?: number | null;` ekle. Ayrıca `channel.type`'ı `ChannelType` ile hizala. |

---

## 3. HIGH Bulgular (30 adet)

### HIGH-001 — Her Booking List İsteğinde Keycloak'dan 500 Kullanıcı Çekiliyor (N+1)
| | |
|:---|:---|
| **Dosya** | `apps/api/src/modules/bookings/booking.service.ts` |
| **Satır** | 137–147 |
| **Kategori** | Performans |
| **Açıklama** | `findAll` her çağrıda `fetchUserDisplayNameMap()` ile Keycloak Admin API'den 500 kullanıcı çekiyor; önbellek yok. Sayfalama endpoint'inin kritik yolunda sabitlenmemiş HTTP çağrısı. |
| **Düzeltme** | Kısa TTL (60 sn) ile önbellekle veya sadece yanıtta gerçekten ihtiyaç duyulan kullanıcıları çek. |

### HIGH-002 — Weekly-Shift'te Aynı Keycloak Çağrısı N Kere Tekrarlanıyor
| | |
|:---|:---|
| **Dosya** | `apps/api/src/modules/weekly-shifts/weekly-shift.routes.ts` |
| **Satır** | 157, 163 |
| **Kategori** | Performans |
| **Açıklama** | `visibleGroups.map(...)` içinde `canEditGroup` her grup için `fetchCurrentUserType` çağırıyor. N görünür grup = N aynı HTTP isteği. |
| **Düzeltme** | `fetchCurrentUserType`'ı `Promise.all`'den önce bir kere hesapla ve sonucu `canEditGroup`'a parametre olarak geç. |

### HIGH-003 — Users List'te Her İstekte 13 Keycloak HTTP Turu
| | |
|:---|:---|
| **Dosya** | `apps/api/src/modules/users/users.routes.ts` |
| **Satır** | 109–111 |
| **Kategori** | Performans |
| **Açıklama** | Tüm kullanıcılar çekildikten sonra `fetchBcmsGroupMemberships()` 12 paralel Keycloak isteği atıyor. Önbellek yok; her listing ~13 HTTP turu. |
| **Düzeltme** | Grup üyeliklerini TTL ile önbellekle; mevcut `groupMembershipCache`'den faydalan. |

### HIGH-004 — FFmpeg İşlemlerinde Timeout Yok — Worker Sonsuza Dek Asılı Kalabilir
| | |
|:---|:---|
| **Dosya** | `apps/api/src/modules/ingest/ingest.worker.ts` |
| **Satır** | 31–116 |
| **Kategori** | Kaynak Sızıntısı / Eşzamanlılık |
| **Açıklama** | `computeChecksum`, `probeFile`, `measureLoudness`, `generateProxy` hiçbir zaman aşımı (timeout) kullanmıyor. Bozuk dosyada `ffmpeg`/`ffprobe` askıda kalırsa worker sonsuza dek kilitlenir. |
| **Düzeltme** | Her işlemi `Promise.race` ile 5 dakikalık timeout'a sok; aşımda `FAILED` durumuna çevir. |

### HIGH-005 — Excel Export Stream Hataları Yönetilmiyor / Response Asılı Kalıyor
| | |
|:---|:---|
| **Dosya** | `apps/api/src/modules/ingest/ingest.routes.ts` (332), `studio-plan.routes.ts` (262), `weekly-shift.routes.ts` (334), `schedules/schedule.export.ts` (94) |
| **Kategori** | Hata Yönetimi / Kaynak Sızıntısı |
| **Açıklama** | `workbook.xlsx.write(stream)` `await` edilmiyor; `PassThrough` stream'e error listener eklenmemiş. Yazma reddederse hata HTTP istemciye yansımıyor, yanıt yarım kalıyor veya asılı kalıyor. |
| **Düzeltme** | `await workbook.xlsx.write(stream)` try/catch içinde yap veya `pipeline(stream, reply.raw)` ile düzgün hata yönlendirme kur. |

### HIGH-006 — Chokidar Watchers Kapatılmıyor — Shutdown'da FD Açık Kalıyor
| | |
|:---|:---|
| **Dosya** | `apps/api/src/modules/ingest/ingest.watcher.ts`, `modules/bxf/bxf.watcher.ts` |
| **Satır** | 10, 65 |
| **Kategori** | Kaynak Sızıntısı |
| **Açıklama** | `chokidar.watch()` referansı saklanmıyor ve `onClose`'da `.close()` çağrılmıyor. SIGTERM'de inotify/kqueue tanıtıcıları açık kalıyor; Docker `stop_grace_period` içinde çıkış engellenebiliyor. |
| **Düzeltme** | Watcher instance'ını sakla ve `app.addHook('onClose', ...)` içinde `.close()` çağır. |

### HIGH-007 — OPTA Sync Transaction İçinde Sınırsız Paralel Yazma
| | |
|:---|:---|
| **Dosya** | `apps/api/src/modules/opta/opta.sync.routes.ts` |
| **Satır** | 93–110 |
| **Kategori** | Veritabanı / Performans |
| **Açıklama** | Tek bir `$transaction` içinde tüm `match.create` ve `match.update`'ler `Promise.all` ile aynı anda atılıyor. Yüzlerce maçta bağlantı havuzu tükenir, kilit çatışması yaşanır. |
| **Düzeltme** | `createMany` ile toplu ekle; güncellemeleri `p-map` gibi concurrency limiti (ör. 10) ile işle. |

### HIGH-008 — Fastify `trustProxy` Kapalı — Rate-Limit ve Audit IP'leri Yanlış
| | |
|:---|:---|
| **Dosya** | `apps/api/src/app.ts` |
| **Satır** | 165–173 |
| **Kategori** | Güvenlik / Gözlemlenebilirlik |
| **Açıklama** | Fastify `trustProxy: true` olmadan başlatılıyor. API nginx arkasında olduğu için `request.ip` nginx konteynerinin dahili IP'si (`172.x.x.x`) oluyor. Tüm `AuditLog.ipAddress` aynı Docker IP'si olarak kaydediliyor; rate-limit de tek bir IP'ye (nginx) uygulanıyor. |
| **Düzeltme** | Fastify'ı `trustProxy: true` veya güvenilir CIDR listesiyle başlat. |

### HIGH-009 — Docker Compose'da TLS Yok — Tüm Trafiği Plain HTTP
| | |
|:---|:---|
| **Dosya** | `docker-compose.yml`, `infra/docker/nginx.conf` |
| **Kategori** | Taşıma Güvenliği |
| **Açıklama** | API, web, Keycloak, Grafana, Prometheus, RabbitMQ management hepsi plain HTTP. Sertifika, HSTS, HTTPS redirect yok. Kimlik bilgileri ve JWT'ler şifrelenmeden ağda dolaşıyor. |
| **Düzeltme** | nginx/Traefik/cloud LB üzerinde TLS termination kur; `KC_HOSTNAME_STRICT_HTTPS=true` ve Keycloak `sslRequired=external` ayarla. |

### HIGH-010 — Keycloak Admin Konsolu Tüm Arayüzlere Bağlı
| | |
|:---|:---|
| **Dosya** | `docker-compose.yml` |
| **Satır** | 68 (keycloak ports) |
| **Kategori** | Docker / Ağ Güvenliği |
| **Açıklama** | Keycloak `8080:8080` olarak **tüm host arayüzlerine** (`0.0.0.0`) yayınlanmış. Reverse proxy/WAF olmadan production ağına doğrudan maruz. |
| **Düzeltme** | Sadece localhost'a bağla (`127.0.0.1:8080:8080`) ve hardened reverse proxy üzerinden eriş. |

### HIGH-011 — Prometheus Hedefleri Var Olmayan Exporter'lara İşaret Ediyor
| | |
|:---|:---|
| **Dosya** | `infra/prometheus/prometheus.yml` |
| **Satır** | 16–26 |
| **Kategori** | İzleme / Gözlemlenebilirlik |
| **Açıklama** | `postgres-exporter:9187`, `rabbitmq:15692`, `node-exporter:9100` yapılandırılmış ama `docker-compose.yml`'de bu servisler yok. `rabbitmq.conf`'da prometheus plugin'i etkin değil. Sadece `bcms-api` metrikleri toplanıyor; diğer hedefler log spam'i ve yanlış negatif alarm üretiyor. |
| **Düzeltme** | Eksik exporter konteynerlerini ekle veya hedefleri `prometheus.yml`'den kaldır. |

### HIGH-012 — Worker Service API'ye `depends_on` — Cascading Failure
| | |
|:---|:---|
| **Dosya** | `docker-compose.yml` |
| **Satır** | 178–179 |
| **Kategori** | Altyapı / Hizmet Bağımlılığı |
| **Açıklama** | Worker `depends_on: api: condition: service_started` diyor. API/Worker ayrımı ihlal ediliyor; API başlatılamazsa worker da başlayamaz. |
| **Düzeltme** | Worker'dan `api` bağımlılığını kaldır. İkisi de sadece `postgres` ve `rabbitmq`'ya bağımlı olsun. Migration'ları init konteyner veya one-off job olarak çalıştır. |

### HIGH-013 — Soft Delete ile `@unique` Çatışması — Silinen Kayıt Yeniden Oluşturulamaz
| | |
|:---|:---|
| **Dosya** | `apps/api/prisma/schema.prisma` |
| **Satır** | `Channel.name` (66), `League.code` (12), `StudioPlanProgram.name` (312), `StudioPlanColor.label/value` (325-326), `RecordingPort.name` (213), `StudioPlan.weekStart` (280), `IngestPlanItem.sourceKey` (189), `ShiftAssignment` unique (386) |
| **Kategori** | Veritabanı / Veri Bütünlüğü |
| **Açıklama** | Soft delete (`deleted_at`) olan modellerde `@unique` sadece iş alanlarını içeriyor; silinen satır hâlâ unique slot'u işgal ediyor. Aynı isim/code/sourceKey ile yeni kayıt 409 verir. |
| **Düzeltme** | `@@unique([field, deleted_at])` yap ve `@@index([deleted_at])` ekle; PostgreSQL partial unique index (`WHERE deleted_at IS NULL`) kullan. |

### HIGH-014 — `safeToIso()` Hata Fırlatırsa Submit Çöker
| | |
|:---|:---|
| **Dosya** | `apps/web/src/app/features/schedules/schedule-form/schedule-form.component.ts` |
| **Satır** | 476 |
| **Kategori** | Çalışma Zamanı Hatası |
| **Açıklama** | `safeToIso()` geçersiz tarihte `Error` fırlatıyor; `submit()` bunu try/catch ile sarmamış. Kullanıcı formu gönderirse uygulama çöker. |
| **Düzeltme** | `submit()` içinde `safeToIso` çağrılarını try/catch ile sarmala ve validation snackbar göster. |

### HIGH-015 — Schedule Form API Çağrılarında Hata Handler Yok
| | |
|:---|:---|
| **Dosya** | `apps/web/src/app/features/schedules/schedule-form/schedule-form.component.ts` |
| **Satır** | 303–310 |
| **Kategori** | Hata Yönetimi |
| **Açıklama** | Kanal, lig ve schedule getirme çağrıları `error` handler içermiyor. API başarısız olursa form sessizce bozuk kalıyor. |
| **Düzeltme** | Her `subscribe`'a `error` callback ekle; güvenli default'lara düş ve kullanıcıya bildir. |

### HIGH-016 — `schedule-detail` Route Param `NaN` Kontrolü Yok
| | |
|:---|:---|
| **Dosya** | `apps/web/src/app/features/schedules/schedule-detail/schedule-detail.component.ts` |
| **Satır** | 116 |
| **Kategori** | Null Güvenliği / Mantık |
| **Açıklama** | `Number(this.route.snapshot.params['id'])` `NaN` kontrolü yapmıyor; bozuk route parametresi API'ye `NaN` olarak gidiyor. |
| **Düzeltme** | `if (!Number.isFinite(id)) { ... }` ile doğrula ve hata sayfasına yönlendir. |

### HIGH-017 — Zaman Dilimi (Timezone) Sabit Kodlanmış (+03:00)
| | |
|:---|:---|
| **Dosya** | `apps/web/src/app/features/ingest/ingest-list/ingest-list.component.ts` (986, 1129–1130, 1291), `schedules/schedule-list/schedule-list.component.ts` (2193–2194), `schedules/reporting/schedule-reporting.component.ts` (826–827) |
| **Kategori** | Mantık Hatası / Taşınabilirlik |
| **Açıklama** | `new Date(\`${dateValue}T00:00:00+03:00\`)` sabit kodlanmış. DST değişikliğinde veya farklı dağıtımda yanlış zaman üretir. `environment.utcOffset` görmezden geliniyor. |
| **Düzeltme** | `environment.utcOffset`'i kullan veya `Intl.DateTimeFormat` ile yapılandırılmış timezone'dan türet. |

### HIGH-018 — SMB Şifresi Component State'inde Düz Metin Tutuluyor
| | |
|:---|:---|
| **Dosya** | `apps/web/src/app/features/settings/settings.component.ts` |
| **Satır** | 179–214 |
| **Kategori** | Güvenlik / UX |
| **Açıklama** | SMB şifresi `cfg.password` olarak component state'inde plaintext tutuluyor. Kaydettikten sonra maskelemek `********` ile değiştirse de, Angular DevTools state incelemesinde bellekte görünür. |
| **Düzeltme** | Şifreyi component state'inde tutma; ayrı bir `password` input alanı kullan ve gönderimden sonra temizle. |

### HIGH-019 — Alt Route'larda `canActivate: [AuthGuard]` Eksik
| | |
|:---|:---|
| **Dosya** | `apps/web/src/app/app.routes.ts` (çocuk route dosyaları) |
| **Kategori** | Yönlendirme / Güvenlik |
| **Açıklama** | Ebeveyn `canActivate` lazy-load'ı koruyor ama kardeş/çocuk navigasyonu korumuyor. Gelecekte eklenen derin çocuk route'lar korunmasız kalabilir. |
| **Düzeltme** | Tüm çocuk route tanımlarına `canActivate: [AuthGuard]` (veya `canActivateChild`) ekle. |

### HIGH-020 — `AuditLog.action` Tipi Prisma Enum'undan Dar
| | |
|:---|:---|
| **Dosya** | `packages/shared/src/types/common.ts` |
| **Satır** | 15 |
| **Kategori** | Tip Güvenliği / Sözleşme |
| **Açıklama** | `AuditLog.action` sadece `'CREATE' | 'UPDATE' | 'DELETE'` iken Prisma `AuditLogAction` enum'unda `UPSERT` ve `CREATEMANY` da var. Audit eklentisi bu eylemleri üretebiliyor; frontend/shared tüketicilerinde tip hatası/uyumsuz case oluşur. |
| **Düzeltme** | Birliği `'CREATE' | 'UPDATE' | 'DELETE' | 'UPSERT' | 'CREATEMANY'` şeklinde genişlet. |

### HIGH-021 — `Booking` Tipinde `requestedByName` Var Olmayan Bir Entity Alanı Gibi
| | |
|:---|:---|
| **Dosya** | `packages/shared/src/types/booking.ts` |
| **Satır** | 7 |
| **Kategori** | Tip Güvenliği / Sözleşme |
| **Açıklama** | `requestedByName` DB şemasında yok; sadece `BookingService.findAll()`'da hesaplanıyor. `findById()` veya raw Prisma nesnelerinde bu alan `undefined`. Shared tip yanlışlıkla entity şekli gibi davranıyor. |
| **Düzeltme** | `requestedByName`'i temel `Booking` interface'inden çıkar; `BookingListItem extends Booking` gibi ayrı bir tip oluştur ve `findAll` dönüş tipinde kullan. |

### HIGH-022 — `Booking` ve `IngestJob` Shared Tipinde `updatedAt` Eksik
| | |
|:---|:---|
| **Dosya** | `packages/shared/src/types/booking.ts` (3), `types/ingest.ts` (4) |
| **Kategori** | Tip Güvenliği / Sözleşme |
| **Açıklama** | Prisma'da `@updatedAt` olan alanlar shared type'larda yok. API yanıtlarında bu alanlar gelir ama TypeScript reddeder. |
| **Düzeltme** | `updatedAt: string;` ekle. |

### HIGH-023 — `UpdateScheduleDto`'da `broadcastTypeId` Eksik
| | |
|:---|:---|
| **Dosya** | `packages/shared/src/types/schedule.ts` (38), `apps/api/src/modules/schedules/schedule.schema.ts` (20–29) |
| **Kategori** | Tip Güvenliği / API Sözleşmesi |
| **Açıklama** | DB `broadcastTypeId Int?` izin veriyor, `CreateScheduleDto` içeriyor, ama `UpdateScheduleDto` ve Zod şeması yok. Değiştirilmesi kasıtlıysa belgelenmeli; değilse eksik. |
| **Düzeltme** | İzin vermek isteniyorsa DTO ve Zod şemasına ekle; yasaklanacaksa kod yorumuyla belgele. |

### HIGH-024 — `PERMISSIONS` Haritası Yanlış Etki Alanlarına Bağlı
| | |
|:---|:---|
| **Dosya** | `packages/shared/src/types/rbac.ts` (45) |
| **Kategori** | Yetkilendirme / Semantik |
| **Açıklama** | `users.routes.ts` tüm kullanıcı yönetim endpoint'lerinde `PERMISSIONS.auditLogs.read` kullanıyor. `broadcast-type.routes.ts` `PERMISSIONS.channels.read/write/delete` kullanıyor. `opta.routes.ts` `PERMISSIONS.channels.write` kullanıyor. Bunlar mantıksal olarak yanlış domain'lere bağlı. |
| **Düzeltme** | `users`, `broadcastTypes`, `opta` domain'lerini `PERMISSIONS`'a ekle ve route'ları güncelle. |

### HIGH-025 — `JwtPayload.email` Zorunlu Olarak Tanımlı — Keycloak'da Olmayabilir
| | |
|:---|:---|
| **Dosya** | `packages/shared/src/types/rbac.ts` (34) |
| **Kategori** | Tip Güvenliği / Çalışma Zamanı |
| **Açıklama** | `email` zorunlu `string` olarak tanımlı ama Keycloak token'larında (servis hesapları, e-postasız kullanıcılar) bu claim eksik olabilir. API cast yaparken runtime güvenliği bozulur. |
| **Düzeltme** | `email?: string` yap veya cast öncesinde claim varlığını doğrula. |

---

## 4. MEDIUM Bulgular (50 adet — Özet Tablo)

| ID | Dosya | Satır | Kategori | Açıklama | Düzeltme Önerisi |
|:---|:---|:---|:---|:---|:---|
| MED-001 | `apps/api/src/plugins/audit.ts` | 154–165 | Hata Yönetimi | `onSend` hook içinde `auditLog.createMany` hata verirse re-throw ediliyor; yanıt zaten başlamışsa socket asılı kalıyor veya crash oluyor. | Hatayı yakalayıp logla ama re-throw etme. |
| MED-002 | `apps/api/src/modules/ingest/ingest.routes.ts` | 567–602 | Veritabanı | Callback handler üç ayrı DB çağrısı yapıyor (job, qcReport, planItem); transaction yok. İkincisi/üçüncüsü başarısız olursa kısmi durum kalıyor. | Tek `$transaction` içine al. |
| MED-003 | `apps/api/src/modules/ingest/ingest.routes.ts` | 465–485 | Veritabanı | `ingestJob.create` + `ingestPlanItem.updateMany` transaction'sız. Plan güncellemesi başarısız olursa job var ama plan eski kalıyor. | `$transaction` ile sarmala. |
| MED-004 | `apps/api/src/modules/bxf/bxf.watcher.ts` | 38–44 | Mantık | `channelCache` başlangıçta bir kere dolduruluyor; çalışma zamanında kanal ekleme/değiştirme yapılırsa BXF eşleşmesi bozuluyor. | Cache'i periyodik yenile veya `handleFile` içinde miss olduğunda tekrar doldur. |
| MED-005 | `apps/api/src/modules/bxf/bxf.watcher.ts` | 142–148 | Mantık | Duplicate detection sadece `channelId + startTime` kontrol ediyor; aynı başlangıç zamanlı ama farklı bitiş/başlıklı revize BXF sessizce atlanıyor. | `endTime` veya içerik hash'ini de kontrol et. |
| MED-006 | `apps/api/src/plugins/rabbitmq.ts` | 88–94, 56–61 | Kaynak Sızıntısı | Bağlantı düşerken `scheduleReconnect` birden fazla timeout üretebiliyor; eski timeout başarılı retry sonrası çalışıp redundant bağlantı denemesi yapıyor. | Tek `shouldReconnect` bayrağı veya pending timeout'ları temizle. |
| MED-007 | `apps/api/src/modules/bookings/booking.service.ts` | 307–338 | Performans / Veritabanı | Import loop her satır için `schedule.findUnique` + booking create yapıyor; batch yok, transaction yok. Kısmi import kalıcı olabilir. | `createMany` ile toplu oluştur veya loop'u transaction içine al. |
| MED-008 | `apps/api/src/modules/schedules/schedule.schema.ts` | 20–29 | Doğrulama | `createScheduleSchema`'da `endTime > startTime` `refine`'ı var ama `updateScheduleSchema`'da yok. PATCH ile ters aralık oluşturulabilir. | Aynı `refine()`'ı `updateScheduleSchema`'ya ekle (her iki alan da varsa çalışacak şekilde). |
| MED-009 | `apps/api/src/modules/bookings/booking.routes.ts` | 29–30 | Tip Güvenliği | `group` query param `z.string()` ile parse edilip `as BcmsGroup` cast ediliyor. Geçersiz grup string'i servise kadar iniyor. | `z.enum(BCMS_GROUPS)` veya `isBcmsGroup` doğrulaması yap. |
| MED-010 | `apps/api/src/modules/bookings/booking.service.ts` | 272–280 | Mantık | `emailPayload.to = existing.requestedBy` bir **kullanıcı adı**nı (ör. `osman.baskan`) doğrudan e-posta adresi olarak kullanıyor. SMTP sunucusu alias yapmıyorsa iletişim başarısız olur. | Keycloak veya JWT `email` claim'inden çözümle. |
| MED-011 | `apps/api/src/modules/users/users.routes.ts` | 293–299 | Hata Yönetimi / Tutarlılık | Kullanıcı Keycloak'da oluşturulup grup atamalarından biri hata verirse kullanıcı grupları eksik kalıyor; rollback yok. | Grup ataması başarısız olursa oluşturulan kullanıcıyı sil (compensating transaction). |
| MED-012 | `apps/api/src/modules/users/users.routes.ts` | 289–290 | Hata Yönetimi | `Location` header'ından `split('/').pop()!` ile ID çıkarılıyor; header bozuksa/eksikse `newId` boş string oluyor. | `location`'ı doğrula; eksikse açık 500 fırlat. |
| MED-013 | `apps/api/src/modules/opta/opta.parser.ts` | 86–121 | Kaynak Sızıntısı | `fs.openSync` ile açılan fd, `fs.readSync` hata verirse `null` dönmeden önce kapatılmıyor. | `try/finally` ile `fs.closeSync(fd)` garantile. |
| MED-014 | `apps/api/src/modules/ingest/ingest.routes.ts` (358), `weekly-shift.routes.ts` (393) | çeşitli | Hata Yönetimi | `decodeURIComponent(request.params.sourceKey)` ve `decodeURIComponent(request.params.group)` `%ZZ` gibi bozuk encoding'de `URIError` fırlatıyor; try/catch yok. | `try/catch` ile sarla; 400 dön. |
| MED-015 | `apps/api/src/modules/ingest/ingest.routes.ts` | 433–445 | Mantık / Belge | Yorum "Delete an ingest plan item (ingest-plan source only)" diyor ama kod `sourceType === 'ingest-plan'` kontrolü yapmıyor. | Kontrolü ekle veya yorumu güncelle. |
| MED-016 | `apps/api/src/modules/notifications/notification.consumer.ts` | 12–23 | Hata Yönetimi | SMTP transport startup'ta `transport.verify()` çağrılmıyor; yanlış credential'lar ilk gerçek mesajda fark ediliyor. | `transport.verify()` ekle ve sonucu logla. |
| MED-017 | `apps/api/src/modules/opta/opta.routes.ts` | 115–121 | Veritabanı | `$queryRaw` içinde `ANY(${FEATURED})` array literal interpolation kullanıyor; Prisma sürücüsüne bağlı olarak `text[]` cast edilmeyebilir. | `ANY(${FEATURED}::text[])` yaz. |
| MED-018 | `apps/api/src/modules/opta/opta.routes.ts` | 93–99 | AGENTS.md İhlali | `metadata` JSON path ile `optaMatchId` filtreleniyor. AGENTS.md metadata JSON filtrelemeyi eski yöntem olarak işaretliyor; canonical kolon kullanılmalı. | `Schedule`'a `optaMatchId` kolonu ekle ve oradan sorgula. |
| MED-019 | `apps/web/src/app/app.component.ts` | 162 | Change Detection | `ngOnInit` içinde `this.cdr.detectChanges()` manuel çağrılıyor; sinyal mimarisiyle çatışma kokusu. | Neden manuel CD gerektiğini araştır; gereksizse kaldır. |
| MED-020 | `apps/web/src/app/features/schedules/schedule-list/schedule-list.component.ts` | 2107–2115 | Güvenlik (Dev) | `environment.skipAuth` true ise `_userGroups.set([GROUP.SystemEng])` yapılıyor; prod build'de `fileReplacements` eksik kalırsa tam yetkisiz erişim. | Runtime guard: `skipAuth && window.location.hostname !== 'localhost'` ise throw. |
| MED-021 | `apps/web/src/app/features/bookings/booking-list/booking-list.component.ts` | 417–420 | Güvenlik (Dev) | Aynı `skipAuth` bypass deseni. | Aynı runtime guard. |
| MED-022 | `apps/web/src/app/features/users/users-list/users-list.component.ts` | 420–431 | Eşzamanlılık | `toggleEnabled` PATCH atıp optimistic UI güncelliyor; hızlı tıklamada paralel istekler oluşuyor, hata durumunda yanlış state'e dönüyor. | İstek uçuşdayken slide toggle'ı devre dışı bırak. |
| MED-023 | `apps/web/src/app/features/ingest/ingest-list/ingest-list.component.ts` | 244–245 | Erişilebilirlik | `source-pill` yalnızca renkle (`#9bd3ff` vs `#ffd166`) ayırt ediliyor; ekran okuyucu için ek açıklama yok. | `aria-label` ve yeterli kontrast ekle. |
| MED-024 | `apps/web/src/app/features/ingest/ingest-port-board/ingest-port-board.component.ts` | 46–49 | Erişilebilirlik | Zoom butonları sadece CSS class'lı `<button>`; `aria-label` ve görünür metin yok. | `aria-label="Zoom sıkı"` vb. ekle. |
| MED-025 | `apps/web/src/app/features/audit/audit-log.component.ts` | 96–99 | Erişilebilirlik | `filterEntityId` input'u `aria-label` içermiyor. | `aria-label="Kayıt ID filtresi"` ekle. |
| MED-026 | `apps/web/src/app/features/mcr/mcr-panel/mcr-panel.component.ts` | 350–351 | Bellek Sızıntısı (Edge) | `setInterval` `ngOnDestroy`'da temizleniyor ama hızlı create/destroy testlerinde gap var. | Timer'ları `ngOnInit`'te her zaman tanımla. |
| MED-027 | `apps/web/src/app/features/schedules/schedule-form/schedule-form.component.ts` | 382–390 | Mantık / UX | `onOptaMatchSelect` ve `onMatchSelect` `toLocalDatetimeStr` ile string üretip sonra `submit()`'ta `new Date(value)` yapıyor. DST geçişlerinde saat kayması. | API'den ISO string al; sadece görüntüleme için formatla. |
| MED-028 | `apps/web/src/app/features/studio-plan/studio-plan.component.ts` | 111 | AGENTS.md İhlali | `STUDIO_EDIT_GROUPS` grup kontrolünü merkezi `hasGroup()` yerine kendisi tekrar ediyor. | `core/auth`'e `hasGroup()` utility koy ve her yerde yeniden kullan. |
| MED-029 | `apps/api/prisma/migrations/20260423005000_recording_ports_1_44_metus/migration.sql` | tüm dosya | Veri Kaybı | `DELETE FROM recording_ports;` yapılıp yeniden insert ediliyor; ops ekiplerinin eklediği özel portlar kayboluyor. | `INSERT ... ON CONFLICT DO NOTHING` kullan veya seed'i migration'dan ayır. |
| MED-030 | `apps/api/prisma/schema.prisma` | Schedule (95-96) | Veritabanı | `start_time < end_time` DB-level CHECK constraint yok. | `CHECK (start_time < end_time)` ekle. |
| MED-031 | `apps/api/prisma/schema.prisma` | IngestPlanItem (193-194) | Veritabanı | `planned_start_minute < planned_end_minute` kontrolü yok; ters aralık anlamsız. | `CHECK (planned_start_minute IS NULL OR planned_end_minute IS NULL OR planned_start_minute < planned_end_minute)` ekle. |
| MED-032 | `apps/api/prisma/schema.prisma` | content_entry_categories (392), content_entry_tags (399), workspaces (406) | Şema Hijyeni | Bu modellerin migration'ı, kod referansı ve ilişkisi yok; ölü kod. | Kaldır veya gelecek modül için açıklama ekle. |
| MED-033 | `apps/api/prisma/schema.prisma` | Match (43-62) | Veritabanı | `(league_id, home_team_name, away_team_name, match_date)` üzerinde unique constraint yok; duplicate fixture oluşabilir. | `@@unique([leagueId, homeTeamName, awayTeamName, matchDate])` ekle. |
| MED-034 | `apps/api/prisma/schema.prisma` | AuditLog (354-369) | Performans | `(entityType, action, timestamp)` bileşik indeksi yok; "son 24 saatteki silme işlemleri" gibi raporlar table scan yapar. | `@@index([entityType, action, timestamp])` ekle. |
| MED-035 | `apps/api/src/app.ts` | 59-76 | Çevre Değişkeni | `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` production zorunlu env listesinde yok; eksikse worker sessizce başarısız olur. | `validateRuntimeEnv()`'e ekle veya graceful degradation belgesi yaz. |
| MED-036 | `apps/api/prisma/schema.prisma` | StudioPlan (278-290) | Eşzamanlılık | `StudioPlan`'da `version` var ama optimistic locking yok; son-yazar-kazanır çatışması riskli. | `schedule.service.ts` ile aynı optimistic locking pattern'ini uygula. |
| MED-037 | `apps/api/src/plugins/prisma.ts` | 21 | Bağlantı Havuzu | `pool_timeout=20` çok uzun; HTTP isteği 20 sn DB bağlantısı bekleyebilir. | `pool_timeout=5` yap. |
| MED-038 | `apps/api/prisma/schema.prisma` | StudioPlan.weekStart (280), ShiftAssignment.weekStart (377) | Şema Tasarımı | Aynı iş kavramı (`weekStart`) biri `DATE` diğeri `VARCHAR(10)`; join, range sorgusu, RI mümkün değil. | `ShiftAssignment.weekStart`'ı `DateTime @db.Date` normalize et. |
| MED-039 | `apps/api/prisma/schema.prisma` | Schedule (102) | Tip Güvenliği | `usageScope` `String @db.VarChar(30)`; Prisma enum değil. Derleme zamanı güvenliği yok. | Prisma native enum tanımla (`UsageScope { broadcast live_plan }`). |
| MED-040 | `docker-compose.yml` | tüm servisler | Docker | `deploy.resources.limits` yok; bellek sızıntısı tüm host RAM'ini tüketebilir. | API 1g, Worker 1g, Postgres 2g, Keycloak 1g, RabbitMQ 1g limit ekle. |
| MED-041 | `apps/api/src/plugins/rabbitmq.ts` | 133-152 | Güvenilirlik | `RABBITMQ_OPTIONAL=true` veya `NODE_ENV !== 'production'`'da RabbitMQ bağlantı hatası yutuluyor; prod'da yanlışlıkla `true` kalırsa tüm olaylar sessizce düşer. | Prod'da `optional` hatch'i kaldır; kullanılıyorsa `FATAL` log at. |
| MED-042 | `docker-compose.yml` | postgres servisi | Ayrıcalık Ayrımı | Uygulama ve Keycloak DB'leri aynı `POSTGRES_USER` süper kullanıcıyı paylaşıyor. | Keycloak için ayrı, düşük yetkili DB kullanıcısı oluştur. |
| MED-043 | `docker-compose.yml` | worker healthcheck | Docker | `healthcheck: { disable: true }`; orchestrator worker çökmesini/askıda kalmasını algılayamaz. | Dosya tabanlı liveness probe veya hafif HTTP endpoint ekle. |
| MED-044 | `packages/shared/src/types/rbac.ts` | 45 | Yetkilendirme | `PERMISSIONS.bookings.read/write/delete` hepsi `[]` (boş). `app.requireGroup(...[])` → `app.requireGroup()` (argüman yok) = **herhangi bir authenticated user**. Servis seviyesi kontroller telafi ediyor ama iki katmanlı auth kırılgan. | Açık grup listesi tanımla veya boş dizinin anlamını yorumla belgele. |
| MED-045 | `apps/api/src/modules/bookings/booking.service.ts` | 52 | Mantık / Gizli Bağlantı | `isSistemMuhendisligi()` `PERMISSIONS.weeklyShifts.admin` kontrol ediyor; booking görünürlüğü haftalık vardiya yetkilerine gizlice bağlı. | `isAdminOrSystemEng(claims)` yardımcı fonksiyonu tanımla. |
| MED-046 | `packages/shared/src/types/studio-plan.ts` | 1 | Tip Güvenliği | `StudioPlanSlot`'ta `planId` eksik; `day: string`/`time: string` DB ile (`dayDate DateTime`, `startMinute Int`) uyuşmuyor. | `StudioPlanSlot` (DTO) ve `StudioPlanSlotEntity` (DB) olarak ayır. |
| MED-047 | `packages/shared/src/types/match.ts` | 8 | Tip Güvenliği | `Match` interface'inde `optaUid?: string \| null` eksik. | Ekle. |
| MED-048 | `packages/shared/src/types/match.ts` | 1 | Tip Güvenliği | `League` interface'inde `metadata`, `createdAt`, `updatedAt` eksik. | Ekle. |
| MED-049 | `packages/shared/src/types/channel.ts` | 3 | Tip Güvenliği | `Channel` interface'inde `updatedAt: string` eksik. | Ekle. |
| MED-050 | `apps/web/src/app/features/studio-plan/studio-plan.types.ts` | 1 | Çoğaltma / Kayma Riski | Web app kendi tip setini tanımlıyor; `@bcms/shared` ile alan adları ve şekiller farklı. | Yerel tipleri `@bcms/shared` ile hizala veya shared'e taşı. |

---

## 5. LOW Bulgular (45 adet — Özet Liste)

### API (21 adet)
1. `middleware/audit.ts` — `writeAuditLog` hiç import edilmiyor; ölü dosya. (Kaldır.)
2. `utils/prisma-json.ts` — `asPrismaJson` hiç kullanılmıyor; ölü dosya. (Kaldır.)
3. `modules/bookings/booking.service.ts` — `remove()` metodu hiç çağrılmıyor; route `removeForRequest()` kullanıyor. (Kaldır.)
4. `plugins/auth.ts` — `isAdminPrincipal` `'Admin'` string'ini hardcode ediyor; `GROUP.Admin` kullanmalı. (AGENTS.md ihlali)
5. `modules/users/users.routes.ts` — `hasAdminGroup` `'Admin'` hardcode. (AGENTS.md ihlali)
6. `plugins/auth.ts` — `DEV_USER` `['SystemEng']` hardcode; dev-only ama kural ihlali.
7. `modules/bookings/booking.service.ts`, `users.routes.ts`, `weekly-shift.routes.ts` — Keycloak helper fonksiyonları `any` kullanıyor. (`unknown` + guard yap.)
8. `app.ts` — `rateLimit` key generator `x-real-ip`'i `as string` cast ediyor; array olabilir. (`Array.isArray` kontrolü ekle.)
9. `plugins/auth.ts` — JWKS fetch/network hatası her durumda 401 dönüyor; altyapı hataları 503 olmalı. (Ayır.)
10. `modules/schedules/schedule.service.ts` — `updateMany` `broadcastTypeId` içermiyor; kasıtlı mı? (Doğrula.)
11. `modules/schedules/schedule.export.ts` — `getDate()`, `getMonth()`, `getHours()` yerel zaman kullanıyor; UTC sunucuda Türkiye yayınları +3 kayar. (`toLocaleString('tr-TR', {timeZone:'Europe/Istanbul'})` kullan.)
12. `modules/schedules/schedule.import.ts` — `new Date(year, month, day, hour, minute, 0)` sunucu yerel zamanında oluşturuluyor. (UTC offset ekle.)
13. `modules/playout/playout.routes.ts` — `new Date(q.date)` UTC gece yarısı parse edip `setHours(0,0,0,0)` yerel gece yarısına çeviriyor; rundown yanlış güne kayar. (İstanbul zamanında explicit oluştur.)
14. `modules/matches/match.routes.ts` — `buildLabel` `getDate()`, `getMonth()` yerel zaman kullanıyor. (Timezone-aware formatla.)
15. `modules/audit/audit-retention.job.ts` — `setTimeout`/`setInterval` `.unref()` edilmiyor; event loop'u canlı tutar. (`.unref()` ekle.)
16. `modules/opta/opta.watcher.ts` — İki `setInterval` başlatılıyor ama shutdown'ta temizlenmiyor. (Handle sakla ve `onClose`'da temizle.)
17. `modules/channels/channel.routes.ts` — `createChannelSchema.partial().parse(...)` cast ediliyor; `updateChannelSchema` tanımla. (`partial()` + cast yerine açık schema.)
18. `modules/ingest/ingest.routes.ts` — `dateSchema.parse(from)` iki kez parse ediliyor. (Birini kaldır.)
19. `modules/ingest/ingest.routes.ts` — `safeEqual` string olmayan input alırsa `Buffer.from(undefined)` patlar. (`typeof` guard ekle.)
20. `modules/signals/signal.routes.ts` — `+(Math.random() * 1e-6).toExponential(2) as unknown as number` gereksiz cast. (Cast'i kaldır.)
21. `modules/ingest/ingest.worker.ts` — `ffmpeg.setFfmpegPath(...)` import anında global state'i değiştiriyor; testler kırılgan. (Startup fonksiyonuna taşı.)
22. `plugins/metrics.ts` — Sayaç `Number.MAX_SAFE_INTEGER`'ı aşabilir (teorik). (`BigInt` veya startup'ta resetle.)
23. `modules/opta/opta.smb-config.ts` — SMB şifresi `~/.bcms-opta.cred`'e yazılıyor; home dizini shared volume olabilir. (Belgele ve konteyner home'unun shared mount olmadığını doğrula.)
24. `modules/users/users.routes.ts` — `groupIdMapCache` 5 dakika TTL; Keycloak grup değişikliği bu pencerede etkisiz. (Admin flush endpoint veya daha kısa TTL.)

### Frontend (9 adet)
25. `features/documents/documents.component.ts` — Stub component; hiçbir işlev yok. (Kaldır veya implemente et.)
26. `features/provys-content-control/provys-content-control.component.ts` — Stub component. (Kaldır veya implemente et.)
27. `features/audit/audit-log.component.ts` — `::ng-deep` kullanılıyor; Angular Material güncellemelerinde kırılabilir. (CSS variables veya `ViewEncapsulation.None` + BEM.)
28. `features/settings/settings.component.ts` — SMB input `aria-describedby` yok. (Ekle.)
29. `features/weekly-shift/weekly-shift.component.ts` — `window.open` sonrası `win` popup blocker'da `null` olabilir; kontrol yok. (Null check ve snackbar.)
30. `features/schedules/schedule-list/schedule-list.component.ts` — `[style.background]` her satırda change detection'da yeniden hesaplanıyor. (`computed()` veya memoize.)
31. `core/services/api.service.ts` — `patch()` `version` undefined ise bile yeni `HttpHeaders` oluşturuyor. (Koşullu oluştur.)
32. `features/channel-list/channel-list.component.ts` — Hata sessizce `channels.set([])` yapılıyor; kullanıcı bildirimi yok. (Kısa hata mesajı veya retry.)
33. `features/mcr/mcr-panel/mcr-panel.component.ts` — `toUTCString()` İngilizce locale varsayımı; farklı locale'de bozulabilir. (`toISOString()` veya `Intl.DateTimeFormat` kullan.)
34. `features/studio-plan/studio-plan.component.ts` — `loadCatalog()` hatası sadece `saveError` set ediyor; UI hâlâ `DEFAULT_PROGRAMS` gösteriyor ve mesaj yanıltıcı olabilir. (Hata türünü ayır.)

### Altyapı / DB (10 adet)
35. `prisma/schema.prisma` — `Schedule.contentId` orphan FK; `@relation` yok. (Relation tanımla veya kaldır.)
36. `prisma/schema.prisma` — `ShiftAssignment` `deletedAt` (camelCase) kullanıyor; diğer tüm modeller `deleted_at` (snake_case). (Adlandırmayı standartlaştır.)
37. `infra/docker/nginx.conf` — `X-Forwarded-Proto` header iletilmiyor. (Ekle.)
38. `infra/keycloak/realm-export.json` — `bcms-web` client `directAccessGrantsEnabled: true` (Password Grant); OAuth best practice'a aykırı. (Kapat, sadece Authorization Code + PKCE.)
39. `infra/keycloak/realm-export.json` — `redirectUris` / `webOrigins`'de `172.28.204.133` hardcoded. (`envsubst` ile template'le.)
40. `prisma/schema.prisma` — `StudioPlanSlot.startMinute` ve `ShiftAssignment.dayIndex` aralık kontrolü yok. (CHECK constraint ekle.)
41. `prisma/schema.prisma` — `ShiftAssignment.weekStart` format regex kontrolü yok. (CHECK `~ '^\d{4}-W\d{2}$'` ekle veya DATE tipine geç.)
42. `apps/api/src/plugins/audit.ts` — `AuditLog` girişlerinde `batch_id` / `request_id` yok; aynı HTTP isteğinin multi-entity değişiklikleri ilişkilendirilemez. (`correlationId` kolonu ekle.)
43. `docker-compose.yml` — `opta-watcher` healthcheck sadece `pgrep` yapıyor; SMB bağlantısı koparsa bile sağlıklı görünür. (Heartbeat dosyası kontrolü ekle.)
44. `infra/prometheus/prometheus.yml` — `alerting` bloğu boş; Alertmanager yok, kural yok. (Temel kurallar ve Alertmanager deploy et.)

### Shared (5 adet)
45. `packages/shared/dist/errors.js`, `dist/constants.js` — Kaynak dosyası olmayan eski build artifaktları. (Temizle ve rebuild yap.)

---

## 6. Önerilen Acil Eylem Planı (Öncelik Sırasına Göre)

| Sıra | Eylem | Önem | Etki Alanı |
|:---|:---|:---|:---|
| 1 | RabbitMQ `ConfirmChannel` + `await` geçişi | CRITICAL | API / Güvenilirlik |
| 2 | Angular auth interceptor'ı token yenileme başarısızlığında `throwError`'a çevir | CRITICAL | Frontend / Güvenlik |
| 3 | Ingest plan item çakışma kontrolünü `$transaction` ile atomik yap | CRITICAL | API / Veri Bütünlüğü |
| 4 | MatDialog ve snackbar aboneliklerine `take(1)` ekle | CRITICAL | Frontend / Bellek |
| 5 | Prisma baseline migration oluştur ve commit et | CRITICAL | Altyapı / Deployment |
| 6 | Otomatik DB yedekleme (pg_dump cron veya WAL archive) kur | CRITICAL | Altyapı / DR |
| 7 | PostgreSQL `statement_timeout` ve Prisma pool tuning yap | CRITICAL | Altyapı / Performans |
| 8 | Fastify `trustProxy: true` etkinleştir | HIGH | API / Güvenlik & Gözlemlenebilirlik |
| 9 | Keycloak Admin konsolunu sadece localhost'a bağla; reverse proxy ile TLS zorla | HIGH | Altyapı / Güvenlik |
| 10 | `packages/shared` entity type'larını Prisma schema ile senkronize et (`matchId`, `updatedAt`, `optaUid`) | HIGH | Shared / Tip Güvenliği |
| 11 | FFmpeg işlemlerine 5 dk timeout ekle | HIGH | API / Worker Dayanıklılığı |
| 12 | Excel export stream'lerinde `await` + try/catch + pipeline kullan | HIGH | API / Hata Yönetimi |
| 13 | Keycloak N+1 çağrılarına (booking, weekly-shift, users) TTL önbellek ekle | HIGH | API / Performans |
| 14 | Soft delete + `@unique` çatışmasını partial unique index ile çöz | HIGH | DB / Veri Bütünlüğü |
| 15 | Chokidar watcher'ları `onClose` hook'unda `.close()` yap | HIGH | API / Kaynak Yönetimi |

---

> **Not:** Bu rapor tamamen **read-only** analiz sonucudur. Kod tabanında hiçbir değişiklik yapılmamıştır. Tüm satır numaraları ve dosya referansları 2026-04-30 tarihindeki `HEAD` durumuna göredir.
