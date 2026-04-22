#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

"${ROOT_DIR}/ops/scripts/bcms-build.sh"

if systemctl --user list-unit-files bcms-api-dev.service >/dev/null 2>&1; then
  systemctl --user restart bcms-api-dev.service bcms-web-dev.service
  systemctl --user --no-pager --full status bcms-api-dev.service bcms-web-dev.service
elif systemctl list-unit-files bcms-api-dev.service >/dev/null 2>&1; then
  systemctl restart bcms-api-dev.service bcms-web-dev.service
  systemctl --no-pager --full status bcms-api-dev.service bcms-web-dev.service
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  "${SCRIPT_DIR}/bcms-supervisor-stop.sh"
  "${SCRIPT_DIR}/bcms-supervisor-start.sh"
fi
