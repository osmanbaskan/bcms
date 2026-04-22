#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="${ROOT_DIR}/ops/run"
LOG_DIR="${ROOT_DIR}/ops/logs"
PID_FILE="${RUN_DIR}/supervisor.pid"

mkdir -p "${RUN_DIR}" "${LOG_DIR}"

if [[ -f "${PID_FILE}" ]]; then
  PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${PID}" ]] && kill -0 "${PID}" >/dev/null 2>&1; then
    printf 'BCMS supervisor already running: %s\n' "${PID}"
    exit 0
  fi
fi

setsid "${ROOT_DIR}/ops/scripts/bcms-supervisor.sh" >> "${LOG_DIR}/supervisor.log" 2>&1 &
echo "$!" > "${PID_FILE}"
printf 'BCMS supervisor started: %s\n' "$(cat "${PID_FILE}")"
