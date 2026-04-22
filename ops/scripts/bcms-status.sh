#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if systemctl --user list-unit-files bcms-api-dev.service >/dev/null 2>&1; then
  systemctl --user --no-pager --full status bcms-api-dev.service bcms-web-dev.service || true
elif systemctl list-unit-files bcms-api-dev.service >/dev/null 2>&1; then
  systemctl --no-pager --full status bcms-opta-mount.service bcms-api-dev.service bcms-web-dev.service || true
else
  printf 'Systemd service bulunamadi; cron/supervisor fallback durumu:\n'
  for name in supervisor api web; do
    pid_file="${ROOT_DIR}/ops/run/${name}.pid"
    if [[ -f "${pid_file}" ]]; then
      pid="$(cat "${pid_file}" 2>/dev/null || true)"
      if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
        printf '  %-10s running pid=%s\n' "${name}" "${pid}"
      else
        printf '  %-10s stopped\n' "${name}"
      fi
    else
      printf '  %-10s stopped\n' "${name}"
    fi
  done
fi

printf '\nHealth checks:\n'
if command -v curl >/dev/null 2>&1; then
  curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 \
    && printf '  API  http://127.0.0.1:3000/health  OK\n' \
    || printf '  API  http://127.0.0.1:3000/health  FAIL\n'

  curl -fsS http://127.0.0.1:4200/ >/dev/null 2>&1 \
    && printf '  Web  http://127.0.0.1:4200/         OK\n' \
    || printf '  Web  http://127.0.0.1:4200/         FAIL\n'
else
  printf '  curl bulunamadi, HTTP kontrolu atlandi.\n'
fi

printf '\nOPTA:\n'
if command -v findmnt >/dev/null 2>&1 && findmnt /mnt/opta-backups >/dev/null 2>&1; then
  printf '  Mount /mnt/opta-backups            OK\n'
else
  printf '  Mount /mnt/opta-backups            FAIL\n'
fi

if [[ -d /mnt/opta-backups/OPTAfromFTP20511 ]]; then
  printf '  OPTA_DIR /mnt/opta-backups/OPTAfromFTP20511 OK\n'
else
  printf '  OPTA_DIR /mnt/opta-backups/OPTAfromFTP20511 FAIL\n'
fi

printf '\nLAN URLs:\n'
printf '  Web: http://172.28.204.133:4200\n'
printf '  API: http://172.28.204.133:3000\n'
printf '\nLogs:\n'
printf '  %s/ops/scripts/bcms-logs.sh\n' "${ROOT_DIR}"
