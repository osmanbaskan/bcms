#!/usr/bin/env bash
set -euo pipefail

SERVICE="${1:-all}"
USER_UNITS=false
SYSTEM_UNITS=false
if systemctl --user list-unit-files bcms-api-dev.service >/dev/null 2>&1; then
  USER_UNITS=true
elif systemctl list-unit-files bcms-api-dev.service >/dev/null 2>&1; then
  SYSTEM_UNITS=true
fi
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

case "${SERVICE}" in
  api)
    if "${USER_UNITS}"; then
      journalctl --user -u bcms-api-dev.service -f
    elif "${SYSTEM_UNITS}"; then
      journalctl -u bcms-api-dev.service -f
    else
      tail -f "${ROOT_DIR}/ops/logs/api.log"
    fi
    ;;
  web)
    if "${USER_UNITS}"; then
      journalctl --user -u bcms-web-dev.service -f
    elif "${SYSTEM_UNITS}"; then
      journalctl -u bcms-web-dev.service -f
    else
      tail -f "${ROOT_DIR}/ops/logs/web.log"
    fi
    ;;
  all)
    if "${USER_UNITS}"; then
      journalctl --user -u bcms-api-dev.service -u bcms-web-dev.service -f
    elif "${SYSTEM_UNITS}"; then
      journalctl -u bcms-opta-mount.service -u bcms-api-dev.service -u bcms-web-dev.service -f
    else
      tail -f "${ROOT_DIR}/ops/logs/supervisor.log" "${ROOT_DIR}/ops/logs/api.log" "${ROOT_DIR}/ops/logs/web.log"
    fi
    ;;
  *)
    printf 'Usage: %s [api|web|all]\n' "$0" >&2
    exit 2
    ;;
esac
