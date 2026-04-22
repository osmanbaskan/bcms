#!/usr/bin/env bash
set -euo pipefail

if systemctl --user list-unit-files bcms-api-dev.service >/dev/null 2>&1; then
  systemctl --user stop bcms-web-dev.service bcms-api-dev.service
  systemctl --user --no-pager --full status bcms-api-dev.service bcms-web-dev.service || true
elif systemctl list-unit-files bcms-api-dev.service >/dev/null 2>&1; then
  systemctl stop bcms-web-dev.service bcms-api-dev.service
  systemctl --no-pager --full status bcms-api-dev.service bcms-web-dev.service || true
else
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bcms-supervisor-stop.sh"
fi
