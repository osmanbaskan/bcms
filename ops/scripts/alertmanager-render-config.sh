#!/bin/bash
# AlertManager config render helper — K15 (2026-05-29)
#
# Production'da bu script çalıştırılır → infra/alertmanager/config.yml.tpl
# template'inden .env değerleri ile substitute ederek config.yml üretir.
#
# Kullanım:
#   bash ops/scripts/alertmanager-render-config.sh
#   docker compose restart alertmanager
#
# Dev: skip (default config.yml mailhog + Slack placeholder ile dev'e uygun).

set -euo pipefail

cd "$(dirname "$0")/../.."

if [ ! -f .env ]; then
  echo "FAIL: .env not found (run from project root)"; exit 1
fi
if [ ! -f infra/alertmanager/config.yml.tpl ]; then
  echo "FAIL: infra/alertmanager/config.yml.tpl not found"; exit 1
fi

# Required env'ler
required=(SMTP_HOST SMTP_PORT SMTP_FROM ALERT_EMAIL_TO)
missing=()
set -a; source .env; set +a
for v in "${required[@]}"; do
  if [ -z "${!v:-}" ]; then missing+=("$v"); fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "FAIL: .env'de eksik env: ${missing[*]}"; exit 1
fi

# Defaults
: "${SMTP_USER:=}"
: "${SMTP_PASS:=}"
: "${SMTP_SECURE:=false}"
: "${SLACK_WEBHOOK_URL:=https://hooks.slack.com/services/PLACEHOLDER-SET-SLACK_WEBHOOK_URL}"

# Render
sed \
  -e "s|\${SMTP_HOST}|${SMTP_HOST}|g" \
  -e "s|\${SMTP_PORT}|${SMTP_PORT}|g" \
  -e "s|\${SMTP_USER}|${SMTP_USER}|g" \
  -e "s|\${SMTP_PASS}|${SMTP_PASS}|g" \
  -e "s|\${SMTP_FROM}|${SMTP_FROM}|g" \
  -e "s|\${ALERT_EMAIL_TO}|${ALERT_EMAIL_TO}|g" \
  -e "s|\${SLACK_WEBHOOK_URL}|${SLACK_WEBHOOK_URL}|g" \
  infra/alertmanager/config.yml.tpl > infra/alertmanager/config.yml

echo "OK: infra/alertmanager/config.yml render edildi."
echo "Tetikle: docker compose restart alertmanager"
