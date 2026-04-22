#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"

mkdir -p "${USER_SYSTEMD_DIR}"
"${ROOT_DIR}/ops/scripts/bcms-build.sh"

install -m 0644 "${ROOT_DIR}/ops/systemd/bcms-api-dev.service" "${USER_SYSTEMD_DIR}/bcms-api-dev.service"
install -m 0644 "${ROOT_DIR}/ops/systemd/bcms-web-dev.service" "${USER_SYSTEMD_DIR}/bcms-web-dev.service"

systemctl --user daemon-reload
systemctl --user enable bcms-api-dev.service bcms-web-dev.service
systemctl --user restart bcms-api-dev.service bcms-web-dev.service

if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "${USER}" || true
fi

"${ROOT_DIR}/ops/scripts/bcms-status.sh"
