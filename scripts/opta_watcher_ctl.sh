#!/usr/bin/env bash
# OPTA Watcher yönetim scripti
# Kullanım: ./opta_watcher_ctl.sh [start|stop|restart|status|logs]

PID_FILE=/tmp/opta-watcher.pid
LOG_FILE=~/opta-watcher.log
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cmd="${1:-status}"

_pid() { cat "$PID_FILE" 2>/dev/null; }
_running() { local p=$(_pid); [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }

case "$cmd" in
  start)
    if _running; then
      echo "Zaten çalışıyor (PID: $(_pid))"
      exit 0
    fi
    cd "$SCRIPT_DIR"
    nohup python3 opta_smb_watcher.py --interval 300 >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "Başlatıldı (PID: $!)"
    ;;

  stop)
    if _running; then
      kill "$(_pid)" && rm -f "$PID_FILE"
      echo "Durduruldu"
    else
      echo "Çalışmıyor"
    fi
    ;;

  restart)
    "$0" stop
    sleep 2
    "$0" start
    ;;

  status)
    if _running; then
      echo "ÇALIŞIYOR (PID: $(_pid))"
      echo ""
      grep -E "Tarama tamamlandı|SAAT DEĞİŞTİ|YENİ MAÇ|HATA|ERROR" "$LOG_FILE" 2>/dev/null | tail -5
    else
      echo "DURDURULMUŞ"
    fi
    ;;

  logs)
    tail -f "$LOG_FILE"
    ;;

  *)
    echo "Kullanım: $0 [start|stop|restart|status|logs]"
    exit 1
    ;;
esac
