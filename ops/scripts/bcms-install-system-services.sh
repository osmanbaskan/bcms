#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ "$(id -u)" -eq 0 ]]; then
  runuser -u ubuntu -- "${ROOT_DIR}/ops/scripts/bcms-build.sh"
else
  "${ROOT_DIR}/ops/scripts/bcms-build.sh"
fi

install -m 0644 "${ROOT_DIR}/ops/systemd/bcms-opta-mount.system.service" /etc/systemd/system/bcms-opta-mount.service
install -m 0644 "${ROOT_DIR}/ops/systemd/bcms-api-dev.system.service" /etc/systemd/system/bcms-api-dev.service
install -m 0644 "${ROOT_DIR}/ops/systemd/bcms-web-dev.system.service" /etc/systemd/system/bcms-web-dev.service

systemctl daemon-reload
systemctl enable bcms-opta-mount.service bcms-api-dev.service bcms-web-dev.service
systemctl restart bcms-opta-mount.service
systemctl restart bcms-api-dev.service bcms-web-dev.service

"${ROOT_DIR}/ops/scripts/bcms-status.sh"
