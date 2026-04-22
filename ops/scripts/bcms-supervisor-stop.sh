#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="${ROOT_DIR}/ops/run"

stop_pid_file() {
  local pid_file="$1"
  [[ -f "${pid_file}" ]] || return

  local pid
  pid="$(cat "${pid_file}" 2>/dev/null || true)"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill -TERM -"${pid}" >/dev/null 2>&1 || kill -TERM "${pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${pid_file}"
}

stop_pid_file "${RUN_DIR}/supervisor.pid"
stop_pid_file "${RUN_DIR}/web.pid"
stop_pid_file "${RUN_DIR}/api.pid"

printf 'BCMS supervisor stopped.\n'
