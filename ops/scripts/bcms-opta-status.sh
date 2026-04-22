#!/usr/bin/env bash
set -euo pipefail

printf 'OPTA mount:\n'
if findmnt /mnt/opta-backups >/dev/null 2>&1; then
  findmnt /mnt/opta-backups
else
  printf '  /mnt/opta-backups mount degil\n'
fi

printf '\nOPTA_DIR:\n'
if [[ -d /mnt/opta-backups/OPTAfromFTP20511 ]]; then
  count="$(find /mnt/opta-backups/OPTAfromFTP20511 -maxdepth 1 -type f | wc -l)"
  printf '  /mnt/opta-backups/OPTAfromFTP20511 OK (%s dosya)\n' "${count}"
else
  printf '  /mnt/opta-backups/OPTAfromFTP20511 bulunamadi\n'
fi

printf '\nAPI OPTA status:\n'
if command -v curl >/dev/null 2>&1; then
  for attempt in 1 2 3 4 5; do
    if curl -fsS http://127.0.0.1:3000/api/v1/opta/status; then
      printf '\n'
      exit 0
    fi
    sleep 1
  done
  printf '  API OPTA status alinamadi\n'
else
  printf '  curl bulunamadi\n'
fi
