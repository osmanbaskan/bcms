# BCMS Multiviewer + k3s HA Cluster — Mimari Plan

**Tarih:** 2026-06-08 · **Durum:** Plan (onaylandı) · **Kapsam:** UDP kanalların tarayıcıda multiviewer gösterimi + BCMS'in 3-node k3s cluster'a taşınması.

> Bu belge **blueprint**'tir; henüz uygulanmadı. BCMS multiviewer sekmesi ve k3s geçişi ayrı iş kalemleri.

---

## 0. Parametreler (kilitli)

| Konu | Değer |
|---|---|
| Kanal | **12** (720p H.264, UDP multicast), **~50'ye genişletilebilir** |
| Düzenler | Tekli=**720p** · 2'li=**480p** · 4'lü=**360p** · 6'lı=**360p** · max **6 tile** |
| İzleyici | ~**200**, iç network, farklı switch'ler |
| İzleyici peak bant | ~**0.84 Gbps** (hepsi 6'lı) — kanal sayısından bağımsız |
| Node | **3** (1 Gbps/node) — k3s cluster |
| GPU | **1× A2000** (Node-3, gateway); kanal artarsa GPU eklenir |
| Orkestrasyon | **k3s** + CloudNativePG (DB) + NVIDIA GPU operator |
| Dağıtım | **LL-HLS** + VIP/load-balance |
| Gecikme | LL-HLS ~2-5 sn (monitoring uygun) |

---

## 1. Cluster topolojisi (ana şema)

```
                          ┌──────────────── k3s CLUSTER · 3 node = quorum (raft) ────────────────┐
  UDP multicast           │                                                                       │
  12 kanal 720p H.264     │  ┌─ Node-1 (CPU) ─┐   ┌─ Node-2 (CPU) ─┐   ┌─── Node-3 (A2000) ───┐  │
  239.x.x.x:port ─────────┼─────────────────────────────────────────▶ │  GATEWAY              │  │
  (multicast VLAN)        │  │ BCMS app (web/  │   │ BCMS app        │  │  UDP/TS → LL-HLS      │  │
                          │  │  api replicas)  │   │                 │  │  12 ch × 3 rendition  │  │
                          │  │ worker (singleton)  │ Postgres        │  │  720 remux+480+360 tc │  │
                          │  │ Postgres PRIMARY│◀─▶│  REPLICA (sync) │  │                       │  │
                          │  └────────┬────────┘   └────────┬────────┘  └───────────┬───────────┘  │
                          │  label: cpu             label: cpu           label: gpu               │
                          │  taint: gateway=NO      taint: gateway=NO    taint: only-gateway       │
                          └───────────┼──────────────────────┼──────────────────────┼─────────────┘
                                      │  Ingress/VIP (BCMS https)                    │ VIP (HLS http)
                                      ▼                                              ▼
              ┌───────────────────────────── İÇ NETWORK · access switch'ler (1 Gbps) ──────────────┐
              │   access-sw-1            access-sw-2            access-sw-N                          │
              │      │                       │                     │                                │
              │   ~50 izleyici            ~50 izleyici          ...        (toplam ~200)             │
              │   tarayıcı → BCMS Multiviewer sekmesi (1/2/4/6 düzen, max 6 tile)                   │
              └─────────────────────────────────────────────────────────────────────────────────────┘
```

**Anahtar ayrım:** Gateway (gerçek-zaman, GPU, multicast) **Node-3'e izole**; DB+BCMS **Node-1/2'de**. Aynı cluster, ayrı node havuzu → orkestrasyon birliği + iş yükü izolasyonu.

---

## 2. Node rolleri

| Node | Donanım | Çalıştırır | label / taint |
|---|---|---|---|
| **Node-1** | CPU (8c/32GB), 1 GbE | BCMS api+web, **worker (singleton)**, **Postgres primary** | `role=cpu` · gateway taint'i ile korunur |
| **Node-2** | CPU (8c/32GB), 1 GbE | BCMS api+web, **Postgres replica** | `role=cpu` |
| **Node-3** | **A2000 GPU**, 8c/32GB, 1 GbE (multicast VLAN) | **Gateway** (UDP→LL-HLS) | `role=gpu` · `taint: gateway=true:NoSchedule` (sadece gateway buraya düşer) |

> 3 node = k3s control-plane **quorum** (etcd/raft). 2-node split-brain yok; ayrı arbiter gerekmez.

---

## 3. Ağ mimarisi

```
[Yayın kaynağı] ──UDP multicast (12× 720p, ~12×15=180 Mbps)──▶ multicast VLAN ──▶ Node-3 NIC (IGMP join)
                                                                                      │
Node-3 gateway origin (LL-HLS) ──▶ VIP/LB ──▶ access switch'ler ──▶ ~200 izleyici (peak ~0.84 Gbps)
                                   (3 node'a değil; sadece Node-3 yayınlar — origin)
BCMS https ──▶ Ingress/VIP ──▶ Node-1/2 (api+web)
```

- **Multicast yalnız Node-3'e** gelir (gateway IGMP ile gruplara katılır). Switch'te **IGMP snooping** açık.
- **HLS dağıtımı:** Node-3 origin; 200 izleyici peak ~0.84 Gbps → 1 Gbps uplink'e sığar (yük artarsa 2. gateway node + LB).
- **2 VIP:** (1) BCMS https → Node-1/2 ingress; (2) HLS → gateway. keepalived/MetalLB.

---

## 4. Media pipeline — kanal başına 3-basamaklı merdiven

```
        udp://239.x.x.x:port  (720p H.264 SPTS)
                │  IGMP join
                ▼
        ┌──────────────── GATEWAY (Node-3, A2000) ────────────────┐
        │  demux MPEG-TS                                           │
        │   ├─ 720p  →  REMUX (-c:v copy)        → LL-HLS  (bedava)│  ← tekli
        │   ├─ 480p  →  TRANSCODE (NVENC)        → LL-HLS         │  ← 2'li
        │   └─ 360p  →  TRANSCODE (NVENC)        → LL-HLS         │  ← 4'lü, 6'lı
        └──────────────────────────┬──────────────────────────────┘
                                   ▼   /hls/ch{N}/{720|480|360}/index.m3u8
                          BCMS Multiviewer sekmesi (player rendition'ı düzene göre seçer)
```

- **720p = remux** (re-encode yok, NVENC'i yormaz). **480p+360p = NVENC transcode.**
- 12 kanal → 12 decode (NVDEC) + 24 low-res encode (NVENC) ≈ ~4.2× 1080p eşdeğeri → **tek A2000'in ~yarısı**.
- Yazılım: **MediaMTX** (UDP→LL-HLS/WebRTC) ya da **FFmpeg + nginx**. On-demand (sadece izlenen rendition) ile genişleme payı artar.

---

## 5. Rendition + bant hesabı

**Tile bitrate'leri:** 720p ~3.5 · 480p ~1.3 · 360p ~0.7 Mbps.

| Düzen | Akış | İzleyici/bant | 200 izleyici |
|---|---|---|---|
| Tekli | 1× 720p | ~3.5 Mbps | ~0.70 Gbps |
| 2'li | 2× 480p | ~2.6 Mbps | ~0.52 Gbps |
| 4'lü | 4× 360p | ~2.8 Mbps | ~0.56 Gbps |
| **6'lı (peak)** | 6× 360p | ~**4.2 Mbps** | ~**0.84 Gbps** |

- **Peak ~0.84 Gbps** → 3 Gbps toplam uplink'in **%28'i**. 1 node düşse bile (2×0.85=1.7 Gbps) rahat.
- Kanal sayısı (12→50) **izleyici bandını değiştirmez** (max 6 tile). Sadece gateway transcode yükü artar.

---

## 6. DB HA — CloudNativePG (shared storage YOK)

```
CloudNativePG operator
   ├─ Postgres PRIMARY  (Node-1, yerel disk)
   └─ Postgres REPLICA  (Node-2, yerel disk, streaming replication)
        otomatik failover (primary ölürse replica promote)
        WAL arşiv + günlük backup (mevcut yedek deseni korunur)
```

- **Ortak SAN/SPOF yok**, **fencing/STONITH yok** — replication + operator failover.
- BCMS api `DATABASE_URL` → CloudNativePG **service** (failover'da otomatik primary'e yönelir).
- (Alternatif: DB'yi cluster dışında ayrı HA Postgres'te tutmak — ama in-cluster operator daha az parça.)

---

## 7. GPU — NVIDIA operator

- **NVIDIA GPU Operator** (k3s) → Node-3'teki A2000'i pod'lara açar (device plugin + sürücü).
- Gateway pod: `nodeSelector: role=gpu` + `tolerations: gateway` + **`hostNetwork: true`** (multicast/IGMP için) + multicast NIC erişimi.
- Genişleme: 2. GPU node eklenince operator otomatik tanır; kanallar node'lara bölünür (aktif-aktif).

---

## 8. BCMS app / worker

| Bileşen | Cluster'da |
|---|---|
| **api / web** (stateless) | Deployment, 2 replica (Node-1/2), Ingress + HPA opsiyonel |
| **worker (singleton)** | **tek replika** ya da leader-election — watcher/poller/restore/transfer çift çalışmasın |
| **Keycloak / RabbitMQ** | Deployment/StatefulSet (Node-1/2), gerekiyorsa operatör |
| Secrets (`.env`) | k8s **Secret** (AA/Avid creds, Cloud UX client Basic) |

---

## 9. BCMS "Multiviewer" sekmesi (frontend)

```
┌─ Multiviewer ───────────────────────────────────────────────┐
│ Düzen:  [ Tekli ] [ 2'li ] [ 4'lü ] [ 6'lı ]    Kanal seçici │
│         (720p)   (480p)   (360p)   (360p)        ▼ 12 kanal  │
├──────────────────────────┬──────────────────────────────────┤
│  ┌────────┐  ┌────────┐   │  Seçili düzen kadar tile (max 6) │
│  │  ch3   │  │  ch7   │   │  her tile = hls.js, rendition'ı  │
│  ├────────┤  ├────────┤   │  düzene göre (720/480/360)        │
│  │  ch1   │  │  ch9   │   │  muted autoplay; tıkla→büyüt/ses  │
│  └────────┘  └────────┘   │  7. kanal seçimi pasif (max 6)    │
└──────────────────────────┴──────────────────────────────────┘
```

- Angular standalone bileşen, route `/multiviewer`, RBAC grubu (ör. `Multiviewer`/`Haber`).
- Kanal listesi config/DB'den `(ad, multicast IP:port, hls base)`.
- Player: **hls.js (LL-HLS)**; düzen değişince her tile'ın rendition URL'i değişir.
- Sadece **gösterim** (kayıt yok).

---

## 10. Arıza senaryoları (HA)

| Arıza | Sonuç |
|---|---|
| **Node-1 (primary) düşer** | CloudNativePG → Node-2 replica **promote**; BCMS app Node-2'de çalışmaya devam; worker yeniden zamanlanır |
| **Node-2 düşer** | Primary + Node-1 app ayakta; replica kaybı (tek kopya) — Node-2 dönünce resync |
| **Node-3 (gateway) düşer** | **Multiviewer durur** (tek gateway — bilinçli taviz); BCMS core etkilenmez. (İstenirse 2. GPU node = multiviewer HA) |
| **1 node bakımı** | k3s diğer node'lara taşır; DB failover; rolling |
| **Storage** | Yerel disk + replication → tek-SAN SPOF **yok** |

---

## 11. Kapasite + genişletme

| Eksen | Bugün | Sınır / genişletme |
|---|---|---|
| Kanal | 12 | **~25-30/A2000**; 3 node ~50-75; daha fazlası → GPU node ekle / on-demand |
| İzleyici | 200 (~0.84 Gbps peak) | ~**400'e** kadar (HA korunarak); sonrası → 2. gateway + LB |
| BCMS app | 2 replica | HPA ile ölçeklenir |
| Multiviewer HA | yok (1 gateway) | 2. GPU node → aktif-aktif HA |

---

## 12. Donanım + yazılım

**Donanım (3 node + ağ):**
| Node | Spec |
|---|---|
| Node-1, Node-2 | 8c CPU, 32GB RAM, yerel SSD (DB), 1 GbE |
| Node-3 | 8c CPU, 32GB RAM, **NVIDIA A2000 (NVENC/NVDEC)**, 1 GbE (multicast VLAN), SSD |
| Ağ | multicast VLAN (IGMP snooping) + access switch'ler (1 GbE), 2× VIP |

**Yazılım:**
- **k3s** (hafif k8s) · **CloudNativePG** (DB HA) · **NVIDIA GPU Operator**
- **Gateway:** MediaMTX (UDP→LL-HLS) veya FFmpeg+nginx
- **BCMS:** mevcut api/web/worker imajları (Deployment), Keycloak, RabbitMQ
- **LB/VIP:** MetalLB veya keepalived; Ingress (Traefik/nginx) + cert-manager

---

## Uygulama fazları (öneri)
0. **Multiviewer PoC (cluster'sız):** Node-3'te MediaMTX ile 6-12 kanal UDP→LL-HLS + basit BCMS sekmesi → canlı demo (CPU bile test için yetiyor).
1. **Gateway prod:** A2000 + 3-rendition merdiven + LL-HLS + VIP.
2. **k3s geçişi:** node'lar + CloudNativePG (DB) + GPU operator + app Deployment'ları + worker singleton.
3. **BCMS Multiviewer sekmesi:** Angular bileşen + RBAC + kanal config.
4. **HA sertleştirme:** quorum, failover testleri, (opsiyonel) 2. gateway node.

> **Not:** Multiviewer **tek gateway** ile başlar (gösterim, redundancy tavizi bilinçli). DB ve BCMS core **3-node cluster (quorum + replication)** ile dayanıklı.
> **Terminoloji:** Bu yapı bir **cluster**'dır (k3s + quorum + replication), klasik **HA** (aktif-pasif + shared storage + fencing) değil. Belgedeki "HA" ifadeleri **cluster** olarak okunmalı.

---

## 13. k3s Migrasyon Planı

### 13.1 İyi haber — kod zaten cluster-dostu
- ✅ **api stateless** · ✅ **api/worker ayrımı** (`BCMS_BACKGROUND_SERVICES`) · ✅ **env-driven config** · ✅ audit + optimistic-lock + outbox.
- ✅ **Health endpoint'leri hazır:** api `/health` (readiness: DB+RabbitMQ ping) + `/health/live` (liveness). **Worker'ın da `/health/live`'ı VAR** (`BCMS_WORKER_HEALTH_URL=http://worker:3000`) → probe için kod eklemeye gerek yok.

### 13.2 KODDA değişen (çok az)
| Konu | Değişiklik |
|---|---|
| Worker singleton | **tek-replika Deployment** → kod değişmez (watcher/poller/outbox/restore/transfer çift çalışmasın) |
| Migration | `prisma migrate deploy` → ayrı **Job/initContainer** (startup'ta otomatik migrate YOK — drift riski) |
| SMB erişimi | CSI-SMB ile **aynı path'e** mount → kod değişmez; değilse smbclient-in-pod (EGS'te var) |
| Health probe | **gerekmez** — api+worker `/health/live` zaten var |

### 13.3 ALTYAPI/DEPLOYMENT'ta değişen (asıl iş)
| Şu an | k3s'te |
|---|---|
| `docker compose build` | **Image registry + CI** (build/push) |
| docker-compose.yml | **Helm/manifest** (Deployment/StatefulSet/Service/Ingress) |
| `.env` | **ConfigMap** (config) + **Secret** (parolalar, AA/Avid/cloudux creds) |
| tek postgres | **CloudNativePG** (primary+replica, local PV) |
| nginx 443 | **Ingress (Traefik) + cert-manager** |
| keycloak, rabbitmq | **Deployment/StatefulSet** (veya operatör) |
| host CIFS mount | **CSI-SMB driver** veya worker'ı node'a pinle (nodeSelector+hostPath) |
| port bind | **MetalLB** (LoadBalancer/VIP) |
| standalone Prom/Grafana | **kube-prometheus-stack** |
| (gateway) | **NVIDIA GPU operator** + taint/label |

### 13.4 En kritik 3 dikkat
1. **Worker = tek replika** (singleton'lar çift çalışmasın).
2. **SMB host-mount kırılır** — CSI-SMB veya worker'ı mount'lu node'a pinle.
3. **Migration = Job** (otomatik startup-migrate yok).

### 13.5 Fazlı geçiş
| Faz | İçerik |
|---|---|
| **0** | Image registry + CI |
| **1** | **api + web → Deployment/Service/Ingress** *(taslak: `infra/k8s/phase1/`)* · DB şimdilik dışarıda |
| **2** | worker (tek-replika) + SMB (CSI/pin) |
| **3** | CloudNativePG (DB) + Keycloak + RabbitMQ + migration Job |
| **4** | ConfigMap/Secret, MetalLB, monitoring, (gateway) GPU operator |

### 13.6 Ingress yol haritası (nginx.conf → Ingress)
| Yol | Hedef servis |
|---|---|
| `/api/...` (export/SSE özel timeout) | **api:3000** |
| `/realms`, `/resources`, `/js`, `/robots.txt` | **keycloak:8080** |
| `/admin/(master\|realms)` | **keycloak:8080** |
| `/` (SPA fallback) | **web:80** |
| `/api/v1/.../stream` (SSE) | api:3000 — Ingress'te buffering off + uzun timeout |

> **Faz-1 manifest taslağı:** `infra/k8s/phase1/` (namespace, configmap, secret örneği, api+web Deployment/Service, Ingress, README).
