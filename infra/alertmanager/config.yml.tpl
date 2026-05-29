# BCMS AlertManager config — K15 (2026-05-29)
#
# Bu dosya envsubst ile render edilir (docker-compose entrypoint).
# Environment'tan substitute edilen değişkenler (.env'de set):
#   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE
#   ALERT_EMAIL_TO       (varsayilan: ops@bcms.local)
#   SLACK_WEBHOOK_URL    (bos ise Slack receiver pasif, warn log)
#
# AlertManager Slack URL boş ise receiver'a istek atmaya çalışır ve 404 alır;
# log'a hata düşer ama crash olmaz. Email her zaman aktif (mailhog'a düşer
# dev'de).

global:
  resolve_timeout: 5m
  smtp_smarthost: '${SMTP_HOST}:${SMTP_PORT}'
  smtp_from: '${SMTP_FROM}'
  smtp_auth_username: '${SMTP_USER}'
  smtp_auth_password: '${SMTP_PASS}'
  smtp_require_tls: false   # mailhog için kapalı; prod SMTP'de auto-detect

route:
  receiver: 'all-channels'
  group_by: ['alertname', 'area', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    # Kritik alarmlar daha hızlı tetik
    - matchers:
        - severity =~ "critical|fatal"
      group_wait: 10s
      repeat_interval: 1h

receivers:
  - name: 'all-channels'
    email_configs:
      - to: '${ALERT_EMAIL_TO}'
        send_resolved: true
        headers:
          Subject: '[BCMS {{ .Status | toUpper }}] {{ .GroupLabels.alertname }}'
    slack_configs:
      - api_url: '${SLACK_WEBHOOK_URL}'
        send_resolved: true
        channel: '#bcms-alerts'
        title: '[{{ .Status | toUpper }}] {{ .GroupLabels.alertname }} ({{ .GroupLabels.area }})'
        text: |
          {{ range .Alerts }}
          *Severity*: {{ .Labels.severity }}
          *Summary*: {{ .Annotations.summary }}
          *Description*: {{ .Annotations.description }}
          {{ if .Annotations.runbook }}*Runbook*: {{ .Annotations.runbook }}{{ end }}
          {{ end }}

inhibit_rules:
  # critical alarm fired iken warning'leri suspend et (aynı alert/area için)
  - source_matchers:
      - severity = "critical"
    target_matchers:
      - severity = "warning"
    equal: ['alertname', 'area']
