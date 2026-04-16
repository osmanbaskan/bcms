# BCMS Kurulum Kılavuzu

## Gereksinimler
- Node.js 20+
- Docker Desktop
- npm 10+

---

## 1. İlk Kurulum

```bash
# Proje kök dizininde
cd bcms

# .env dosyasını oluştur ve şifreleri değiştir
cp .env.example .env

# Tüm bağımlılıkları kur
npm install

# Angular CLI global kurulum (ilk sefer)
npm install -g @angular/cli
```

---

## 2. Altyapıyı Başlat (Docker)

```bash
# PostgreSQL, RabbitMQ, Keycloak, Prometheus, Grafana
docker compose up -d postgres rabbitmq keycloak prometheus grafana

# Servislerin hazır olmasını bekle (~60 sn)
docker compose ps
```

### Servis URL'leri
| Servis      | URL                      | Credentials (.env) |
|-------------|--------------------------|---------------------|
| Keycloak    | http://localhost:8080    | admin / changeme_kc |
| RabbitMQ UI | http://localhost:15672   | bcms / changeme_mq  |
| Grafana     | http://localhost:3001    | admin / changeme_grafana |
| Prometheus  | http://localhost:9090    | — |

---

## 3. Veritabanı Kurulumu

```bash
cd apps/api

# Prisma migration oluştur ve uygula
npx prisma migrate dev --name init

# Prisma Client oluştur
npx prisma generate

# Örnek veri yükle
npm run db:seed
```

---

## 4. API Başlat (Development)

```bash
# apps/api dizininde
cd apps/api
npm run dev
```

- API: http://localhost:3000
- Swagger UI: http://localhost:3000/docs
- Health: http://localhost:3000/health

---

## 5. Angular Frontend Başlat

```bash
# apps/web dizininde
cd apps/web
npm install
npm start
```

- Web: http://localhost:4200

---

## 6. Tam Stack Docker ile Çalıştırma

```bash
# Kök dizinden
docker compose up --build
```

---

## Test Kullanıcıları (Keycloak Realm Import)

| Kullanıcı | Şifre       | Rol     |
|-----------|-------------|---------|
| admin     | admin123    | admin   |
| planner1  | planner123  | planner |
| viewer1   | viewer123   | viewer  |

> ⚠️ İlk girişte şifre değişikliği zorunludur.

---

## Dizin Yapısı

```
bcms/
├── apps/
│   ├── api/                  # Fastify + TypeScript backend
│   │   ├── prisma/           # Şema + migration + seed
│   │   └── src/
│   │       ├── modules/      # schedules, bookings, channels, ingest, incidents, audit
│   │       ├── plugins/      # prisma, auth (Keycloak JWT), rabbitmq, metrics
│   │       └── middleware/   # audit logger
│   └── web/                  # Angular 17 frontend
│       └── src/app/
│           ├── core/         # services, interceptors, guards
│           └── features/     # schedules, bookings, channels, ingest, monitoring
├── packages/
│   └── shared/               # Ortak TypeScript tipleri (RBAC, DTO, entities)
├── infra/
│   ├── docker/               # Dockerfile (api, web, nginx)
│   ├── keycloak/             # Realm export (roller, kullanıcılar, client'lar)
│   ├── postgres/             # Multi-DB init script
│   ├── rabbitmq/             # RabbitMQ config
│   └── prometheus/           # Prometheus scrape config
└── docker-compose.yml
```

---

## Sprint Durumu

- [x] **Sprint 0**: Altyapı (PostgreSQL, RabbitMQ, Keycloak, CI/CD hazırlık)
- [x] **Sprint 1**: Schedule CRUD + conflict check + RBAC + Angular UI
- [x] **Sprint 2**: Booking versioning + Excel import + bildirimler
- [ ] **Sprint 3**: Ingest worker + proxy üretimi + QC
- [ ] **Sprint 4**: Monitoring dashboard + sinyal telemetrisi
- [ ] **Sprint 5**: MCR/playout entegrasyonu + incident logging
