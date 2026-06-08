# BCMS k3s — Faz 1 Manifest Taslağı (api + web + Ingress)

> **TASLAK / İSKELET.** Üretime almadan önce gözden geçir. Bkz. `docs/multiviewer-k3s-mimari-2026-06-08.md` §13.

## Kapsam
Bu fazda **sadece stateless katman** taşınır:
- ✅ `bcms-api` (Fastify, HTTP-only, 2 replica)
- ✅ `bcms-web` (nginx + Angular SPA, 2 replica)
- ✅ Ingress (Traefik) + TLS

**Bu fazda YOK (sonraki fazlar):**
- ❌ worker (Faz-2, tek-replika + SMB)
- ❌ Postgres/CloudNativePG, Keycloak, RabbitMQ (Faz-3) → DB şimdilik **cluster dışında** (Compose/dış sunucu), `DATABASE_URL` ona bakar.
- ❌ MetalLB, monitoring, GPU operator (Faz-4)

## Ön koşullar
1. **k3s** kurulu (3 node); CPU node'lar `role=cpu` label'lı:
   `kubectl label node <node> role=cpu`
2. **Image registry** + image'lar push'lanmış: `bcms-api`, `bcms-web`.
   Manifest'lerdeki `REGISTRY/bcms-...:TAG` placeholder'larını gerçek değerle değiştir.
3. **TLS:** cert-manager (internal CA issuer) **veya** manuel secret:
   `kubectl -n bcms create secret tls bcms-tls --cert=server-fullchain.crt --key=server.key`
4. **DNS/hosts:** izleyiciler `beinport` → Ingress (Traefik) IP'sine çözmeli.

## Uygulama
```bash
# 1) Config'i doldur (10-configmap.yaml) — .env'deki NON-SECRET anahtarları taşı.
# 2) Sırları ver (örnek dosyayı KULLANMA; gerçek sırları repo dışından):
kubectl create namespace bcms
kubectl -n bcms create secret generic bcms-secrets --from-env-file=secrets.env   # repo'da OLMAYAN dosya
# 3) Image placeholder'larını değiştir (REGISTRY/...:TAG) — 30-api.yaml, 40-web.yaml.
# 4) Uygula (secret hariç — onu yukarıda verdik):
kubectl apply -f 00-namespace.yaml -f 10-configmap.yaml -f 30-api.yaml -f 40-web.yaml -f 50-ingress.yaml
# 5) Kontrol:
kubectl -n bcms get pods,svc,ingress
kubectl -n bcms rollout status deploy/bcms-api deploy/bcms-web
```

## Gerçek değerler (koddan teyitli)
| Bileşen | Port | Probe |
|---|---|---|
| api | 3000 | readiness `/health` (DB+RabbitMQ) · liveness `/health/live` |
| web | 80 | readiness `/health` (nginx) |
| worker (Faz-2) | 3000 | `/health/live` (zaten var) |

## Önemli notlar
- **🔴 20-secret.example.yaml ÖRNEKTİR** — gerçek sır YAZMA/COMMIT ETME. `--from-env-file` veya Sealed/External Secrets kullan. (Repo public.)
- **web nginx sadeleştirme:** Mevcut web imajının nginx'i 80→443 redirect + `/api`,`/realms` reverse-proxy içeriyor. k3s'te TLS+yönlendirme Ingress'te olduğu için web nginx'i **SPA-only + 80 (redirect'siz)** yap (ayrı küçük iş). Aksi halde redirect döngüsü olur.
- **Keycloak yolları** (`/realms`,`/resources`,`/admin/(master\|realms)`) Faz-3'te Ingress'e eklenir (50-ingress.yaml'de yorumlu).
- **SSE** (`/api/v1/.../stream`): Traefik varsayılan stream eder; ekstra ayar gerekmez (gerekirse buffering middleware).
- **DB (Faz-1):** cluster dışında; `DATABASE_URL` secret'i ona işaret etsin. Faz-3'te CloudNativePG service'ine geçer.
