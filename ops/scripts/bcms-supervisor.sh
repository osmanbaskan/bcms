#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="${ROOT_DIR}/ops/run"
LOG_DIR="${ROOT_DIR}/ops/logs"

mkdir -p "${RUN_DIR}" "${LOG_DIR}" "${ROOT_DIR}/tmp/watch" "${ROOT_DIR}/tmp/proxies"

start_process() {
  local name="$1"
  local pid_file="${RUN_DIR}/${name}.pid"
  local log_file="${LOG_DIR}/${name}.log"
  local command="$2"

  if [[ -f "${pid_file}" ]]; then
    local pid
    pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      return
    fi
  fi

  printf '[%s] starting %s\n' "$(date -Is)" "${name}" >> "${LOG_DIR}/supervisor.log"
  setsid bash -lc "${command}" >> "${log_file}" 2>&1 &
  echo "$!" > "${pid_file}"
}

stop_children() {
  for name in web api; do
    local pid_file="${RUN_DIR}/${name}.pid"
    [[ -f "${pid_file}" ]] || continue

    local pid
    pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill -TERM -"${pid}" >/dev/null 2>&1 || kill -TERM "${pid}" >/dev/null 2>&1 || true
    fi
  done
}

trap 'stop_children; exit 0' INT TERM

API_COMMAND="cd '${ROOT_DIR}' && set -a && . ./.env && set +a && exec node apps/api/dist/server.js"
WEB_COMMAND="cd '${ROOT_DIR}' && set -a && . ./.env && set +a && exec node ops/scripts/bcms-web-static-server.mjs"

while true; do
  start_process api "${API_COMMAND}"
  start_process web "${WEB_COMMAND}"
  sleep 10
done
