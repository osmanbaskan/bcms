#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

"${ROOT_DIR}/ops/scripts/bcms-build.sh"

if systemctl --user list-unit-files bcms-api-dev.service >/dev/null 2>&1; then
  systemctl --user start bcms-api-dev.service bcms-web-dev.service
  systemctl --user --no-pager --full status bcms-api-dev.service bcms-web-dev.service
elif systemctl list-unit-files bcms-api-dev.service >/dev/null 2>&1; then
  systemctl start bcms-api-dev.service bcms-web-dev.service
  systemctl --no-pager --full status bcms-api-dev.service bcms-web-dev.service
else
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bcms-supervisor-start.sh"
fi
