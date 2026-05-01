# Notification Delivery — Alertmanager + Slack/Email Gereksinimleri

> **Status**: 📋 Requirements doc (implement edilmedi). Implement ayrı tur, kullanıcı kararları + secret/webhook URL gelene kadar bekliyor.
> **Audit referansı**: `BCMS_AUDIT_REPORT_2026-05-01.md` Section 2 HIGH-003 — detection katmanı ✅ kapatıldı (`4e364f3`), notification katmanı 🔴 hâlâ açık.
> **Pattern referansı**: `ops/REQUIREMENTS-S3-BACKUP.md` (`9925422`) — design-first, decisions-pending yapısının ikizi.

## Amaç

OPTA observability HIGH-003'te detection katmanı (Prometheus metric `bcms_opta_league_sync_total{action}` + 2 alert rule `OptaLeagueSyncBurst`, `OptaLeagueWriteBurst`) `4e364f3` ile kuruldu. Şu anki durum:

- ✅ Burst tekrar olursa Prometheus `firing` state'e geçer
- ✅ `/api/v1/alerts` endpoint'inde firing alert görünür
- ✅ Manuel monitoring + post-hoc analiz mümkün
- ❌ **Proaktif uyarı yok** — Slack/email/PagerDuty notification gitmez
- ❌ "Burst oldu, kimse görmedi" senaryosu hâlâ mümkün

Notification delivery katmanı = **Alertmanager + receiver config + secret yönetimi**. Bu doc onun design'ı.

## Karar Verilmesi Gerekenler (kullanıcı input)

| Karar | Seçenekler | Default önerim |
|---|---|---|
| **Kanal** | Slack incoming webhook / SMTP email / hibrit (severity bazlı routing) | **Slack** birincil — anlık, takım kanalı, mesaj formatı zengin. Email fallback (severity=critical için) opsiyonel |
| **Slack workspace** | Mevcut iş Slack'i / dedicated workspace / yok (kurulacak) | Mevcut iş Slack'i (eğer varsa); yoksa dedicated `bcms-alerts` channel'ı yeterli |
| **Email SMTP (eğer email seçilirse)** | Şirket SMTP / SendGrid/Mailgun / Mailhog (sadece dev) | Şirket SMTP veya managed (SendGrid). Mailhog **prod için değil**, sadece dev |
| **Receiver count** | Tek receiver / severity bazlı çoklu | Severity bazlı 2 receiver: `slack-warnings`, `slack-critical` (henüz critical alert tanımlı değil ama gelecek için) |
| **Secret yönetimi** | Aşağıda 4 alternatif — ayrı bölüm | **(α) Deploy-time template** (envsubst), default. Bkz. "Secret Yönetimi" bölümü |
| **Alertmanager image versiyonu** | `prom/alertmanager:v0.27.x` veya repo Prometheus (`v2.53.1`) ile uyumlu pinned | **v0.27.x serisinde en son patch** (yazım anında v0.27.0 makul aday); release notes breaking change kontrolü pin sırasında |
| **Group wait/interval** | Group wait 30s / repeat interval 4h vs daha sık | Group wait `30s`, group interval `5m`, repeat interval `4h` (baseline; iteratif kalibrasyon) |
| **Inhibition** | Critical varsa warning susturulur / yok | **Var** — aynı `area=opta` label'ında critical fire ederse warning susturulur |
| **Silence policy** | `amtool` CLI / Alertmanager UI / kim ekleyebilir | UI üzerinden manuel; auth henüz yok (Alertmanager 127.0.0.1 bind, prod nginx-arkasında olur) |

## Secret Yönetimi — 4 Alternatif

⚠️ **Kritik teknik kısıt**: Alertmanager config (alertmanager.yml) **native env var substitution desteklemez** (Prometheus için aynı). `${SLACK_WEBHOOK}` doğrudan çalışmaz. Aşağıdaki yollardan biri seçilmeli.

| # | Yöntem | Avantaj | Dezavantaj |
|---|---|---|---|
| **(α)** | **Deploy-time template** (`envsubst < alertmanager.yml.template > alertmanager.yml`) | Compose env var'ları ile uyumlu, secret git'e gitmez, multi-env destek (`.env.prod`, `.env.staging`) | Init container veya entrypoint script gerekir; minor compose karmaşası |
| (β) | **`*_file` Docker secret** (`slack_api_url_file: /run/secrets/slack_webhook`) | Native Docker secret entegrasyonu, dosya bazlı, rotation kolay | Alertmanager v0.25+ bazı field'lar için `*_file` desteği var (slack_api_url ✓, smtp_auth_password ✓), ama her field değil — verify gerekir |
| (γ) | **External templating** (`gomplate`, `consul-template`) | Dinamik secret rotation | Overkill, yeni dep, BCMS scale'i için lüks |
| (δ) | **Plain config + git-ignore** (alertmanager.yml içinde direct secret, `.gitignore`'da) | En basit, init container yok | Multi-env zor, secret rotation manuel, repo policy ihlali (secret'lar volume mount'a yazılır) |

**Default önerim**: **(α) deploy-time template** — Prometheus tarafıyla uyumlu pattern, `infra/alertmanager/alertmanager.yml.template` repository'de placeholder'larla durur, deploy sırasında `${SLACK_WEBHOOK_URL}`, `${SMTP_PASSWORD}` vb. compose env var'larından doldurulur.

**Implementation şablonu (α için)**:
```yaml
# docker-compose.yml ek servis
alertmanager:
  image: prom/alertmanager:v0.27.0   # veya pinned versiyon
  container_name: bcms_alertmanager
  restart: unless-stopped
  volumes:
    - ./infra/alertmanager:/etc/alertmanager
  entrypoint: |
    sh -c '
      envsubst < /etc/alertmanager/alertmanager.yml.template > /etc/alertmanager/alertmanager.yml &&
      /bin/alertmanager --config.file=/etc/alertmanager/alertmanager.yml
    '
  environment:
    SLACK_WEBHOOK_URL: ${ALERTMANAGER_SLACK_WEBHOOK_URL}
    SMTP_PASSWORD:     ${ALERTMANAGER_SMTP_PASSWORD:-}
  ports:
    - "127.0.0.1:9093:9093"
  networks:
    - bcms_net
```

⚠️ `envsubst` `prom/alertmanager` image'ında default yok (`gettext` paketi gerekir). Custom Dockerfile veya init container daha temiz olabilir — implementation PR'da netleşir.

## Gerekli Env Değişkenleri (`.env` şablonu)

```bash
# Alertmanager Notification Delivery
ALERTMANAGER_SLACK_WEBHOOK_URL=__set_via_secret_manager__   # Slack incoming webhook full URL
ALERTMANAGER_SLACK_CHANNEL=#bcms-alerts                     # default channel; routing override edebilir
ALERTMANAGER_SMTP_HOST=                                     # opsiyonel email fallback
ALERTMANAGER_SMTP_PORT=587
ALERTMANAGER_SMTP_FROM=alerts@example.com
ALERTMANAGER_SMTP_USERNAME=
ALERTMANAGER_SMTP_PASSWORD=__set_via_secret_manager__
ALERTMANAGER_SMTP_TO=oncall@example.com
```

**Secret yönetimi notu**: `ALERTMANAGER_SLACK_WEBHOOK_URL` ve `ALERTMANAGER_SMTP_PASSWORD` `.env` dosyasına yazılırsa **`.env` git'e gitmemeli** (`.gitignore`'da olduğu doğrulanmalı). Yoksa Docker secret veya host-level env tercih edilir.

## Mesaj Formatı Prensipleri (in scope, principle level)

Alert mesajının her receiver kanalında içermesi gereken **minimum field set**:

| Field | Kaynak | Açıklama |
|---|---|---|
| `alertname` | Alert rule (`name:` yaml field) | "OptaLeagueSyncBurst" gibi |
| `severity` | Alert label | `warning` / `critical` |
| `summary` | Annotation | Tek satır insan-okunaklı özet |
| `description` | Annotation | Detay; `{{ $value }}` interpolasyonu ile mevcut değer |
| `runbook_url` | Annotation | Sorun çözüm dökümanına URL |
| `startsAt` | Auto (Alertmanager) | Alert ne zaman fire etti |
| `endsAt` | Auto (resolve) | Alert resolve olduğunda; `firing` mesajda boş |

**Routing prensipleri**:
- `area=opta` label'lı alert'ler `slack-opta` receiver'a (veya genel `slack-warnings`)
- `severity=critical` her zaman email + slack (çift kanal)
- `severity=warning` sadece slack
- Inhibition: aynı `area` + aynı `alertname` farklı severity'de ise critical warning'i susturur

**Out of scope (instances)**: spesifik Slack channel adı, email recipient adresi, `@here`/`@channel` mention syntax, mesaj template'in tam markdown formatı, emoji kullanımı.

## Alert Rule Annotation Uyumluluğu

⚠️ **Mevcut OPTA alert rule'larında uyumsuzluk** — `infra/prometheus/alerts.yml`'da:
```yaml
annotations:
  runbook: "BCMS_AUDIT_REPORT_2026-05-01.md HIGH-003"   # ← runbook (URL değil)
```

Receiver template `{{ .Annotations.runbook_url }}` interpolate edecekse, mevcut `runbook` field'ı **uyumsuz**. Implementation PR'ında iki seçenekten biri uygulanır:

- **(i) Alert rule'ları update**: `runbook` → `runbook_url`, value'yu URL formatına çevir (örn. `https://github.com/osmanbaskan/bcms/blob/main/BCMS_AUDIT_REPORT_2026-05-01.md#high-003`). 1-line edit.
- **(ii) Receiver template `runbook` kullanır**: `{{ .Annotations.runbook }}` — convention dışı ama çalışır.

**Default önerim (i)** — convention'a uygun, gelecek alert rule'lar tutarlı yazılır.

## Prometheus → Alertmanager Bağlantısı

`infra/prometheus/prometheus.yml` mevcut hali:
```yaml
alerting:
  alertmanagers:
    - static_configs:
        - targets: []   # ← şu an boş
```

Implementation PR'da:
```yaml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']   # ← bcms_net üzerinden DNS
```

## Test Prosedürü (deploy sonrası)

App code'a test hook eklemeden, **layer-isolated test**:

### (1) `amtool` ile test alert
```bash
docker exec bcms_alertmanager amtool alert add \
  alertname="TestAlert" \
  severity="warning" \
  area="opta" \
  --annotation summary="Manual test alert" \
  --annotation description="Notification delivery sanity check"
```
Beklenen: ~30sn içinde Slack channel'a mesaj düşer.

### (2) Alertmanager API direct POST
```bash
curl -X POST http://127.0.0.1:9093/api/v2/alerts -H "Content-Type: application/json" -d '[
  {
    "labels": {"alertname":"TestAlert","severity":"warning","area":"opta"},
    "annotations": {"summary":"Manual test","description":"API test"},
    "startsAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
  }
]'
```

**Bu yaklaşım metric/Prometheus path'ine dokunmaz** — sadece notification delivery katmanını test eder. Eğer Slack mesajı gelirse delivery çalışıyor; gelmezse webhook URL/secret/route policy hata.

⚠️ **App içine `optaLeagueSyncTotal.inc(600)` gibi test hook eklemek YASAK** — production code'da debug entry point + risk surface açar; ayrıca metric/Prometheus path'ini test eder, notification delivery'yi değil.

## Implementation Çerçevesi (henüz yapılmadı)

Onaylanan kararlar netleştikten sonra tek PR olarak gelir:

### Implementasyon adımları
1. `infra/alertmanager/alertmanager.yml.template` (placeholder secret'larla)
2. `docker-compose.yml` `alertmanager` servis ekleme (yukarıdaki şablon)
3. `infra/prometheus/prometheus.yml` `alertmanagers.targets` update
4. `infra/prometheus/alerts.yml` runbook → runbook_url annotation update (Madde i)
5. `.env` template güncelleme (yeni env var'lar)
6. `.env.example` veya `ops/notes` örnek değerler (secret olmadan)
7. Verify: amtool test, real burst simülasyonu (Alertmanager API POST), audit raporu HIGH-003 status update

### Implementation Trigger

Bu doküman tamamlanmış değil — **kullanıcı kararları + credential bekliyor**:

1. Kanal seçimi (default: Slack)
2. Slack workspace bilgisi (var/yok)
3. (Email seçilirse) SMTP credential
4. Secret yönetim yöntemi (default: α deploy-time template)
5. Alertmanager image versiyon onayı
6. Routing/inhibition policy onayı
7. Slack incoming webhook URL'si (sen oluşturup secret manager'a koyacaksın)

Yukarıdaki kararlar verilir verilmez `docker-compose.yml` ek servis + `alertmanager.yml.template` + alert rule annotation update + audit raporu HIGH-003 status update tek PR olarak gelir.

## Audit & Risk Etkisi (mevcut durum vs hedef)

| Senaryo | Şimdiki durum (detection ✅, notification 🔴) | Notification kurulduktan sonra |
|---|---|---|
| Burst tekrar olur | ⚠️ Prometheus firing — kimse manuel UI'a bakmazsa görmez | ✅ Slack/email anında |
| Caller spam yapar | ⚠️ Audit_logs şişer (post-hoc fark edilir) | ✅ Saatlik delta > 500 → instant alert |
| OPTA hata mesajı (P2002 storm) | ⚠️ API logs'ta — log retention yok | ✅ Alert + (gelecekte log retention ile) caller IP yakalanır |
| Routine sync rate değişimi | ✅ Metric'te görünür (manuel) | ✅ Aynı + Slack history'de tarihçe |

HIGH-003 status: detection katmanı ile 🟡 partial. Notification kurulduğunda → ✅ closed. Caller post-mortem (log retention) ayrı follow-up; HIGH-003 closure'ı için zorunlu değil — alert + manuel inceleme yeterli ilk aşama.
