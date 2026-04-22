#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/ops/logs"
TMP_CRON="$(mktemp)"
ENTRY="@reboot ${ROOT_DIR}/ops/scripts/bcms-supervisor-start.sh >> ${LOG_DIR}/supervisor.cron.log 2>&1"

mkdir -p "${LOG_DIR}"
"${ROOT_DIR}/ops/scripts/bcms-build.sh"

crontab -l 2>/dev/null | grep -v 'bcms-supervisor-start.sh' > "${TMP_CRON}" || true
printf '%s\n' "${ENTRY}" >> "${TMP_CRON}"
crontab "${TMP_CRON}"
rm -f "${TMP_CRON}"

"${ROOT_DIR}/ops/scripts/bcms-supervisor-start.sh"
"${ROOT_DIR}/ops/scripts/bcms-status.sh"
