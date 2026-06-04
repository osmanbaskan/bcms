#!/usr/bin/env bash
#
# BCMS — Provys + Asrun SMB mount restore / refresh (restart sonrası).
#
# Normalde gerekmez: /etc/fstab (_netdev,nofail) boot'ta mount'ları kurar ve
# docker-compose bind'leri `rslave` olduğu için mount çalışan worker'a yansır.
# Bu script ELLE kurtarma/tazeleme içindir:
#   - mount düşmüşse yeniden mount eder (sudo),
#   - worker'ı rslave bind + canlı mount ile recreate eder,
#   - watcher'ın dosyaları gördüğünü doğrular.
#
# Kullanım:  ./scripts/smb-mount.sh        (sudo İÇERDE çağrılır; docker user ile)
#
# Kaynaklar (info_smb.txt + /etc/fstab):
#   provys: //smb-host.example.local/mcr/PROVYS/MANUEL/Playout/Inbox/Success -> /mnt/provys
#   asrun : //smb-host.example.local/mcr/PROVYS/FTP-PROVYS/Playout/Outbox/Ok -> /mnt/asrun-ok
# Credential: /home/ubuntu/.bcms-245.cred (chmod 600, repo dışı).
#
set -euo pipefail

PROVYS_MNT="/mnt/provys"
ASRUN_MNT="/mnt/asrun-ok"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '[smb-mount] %s\n' "$*"; }

ensure_mount() {
  local mp="$1"
  if mountpoint -q "$mp"; then
    log "$mp zaten mount'lu."
  else
    log "$mp mount değil → sudo mount $mp (fstab'dan)"
    sudo mount "$mp"
  fi
}

log "1) SMB mount kontrol/kurulum..."
ensure_mount "$PROVYS_MNT"
ensure_mount "$ASRUN_MNT"

log "2) Aktif CIFS mount'lar:"
mount | grep -E 'provys|asrun-ok' || { log "HATA: provys/asrun mount bulunamadı (credential/ağ?)"; exit 1; }

log "3) Worker recreate (rslave bind + canlı mount devreye)..."
cd "$REPO_ROOT"
docker compose up -d --no-deps --force-recreate worker

log "4) Worker dosya görünürlüğü (birkaç saniye bekle):"
sleep 3
docker exec bcms_worker sh -c \
  'echo "   provys: $(ls /app/tmp/provys/*.bxf 2>/dev/null | wc -l) bxf"; echo "   asrun : $(ls /app/tmp/asrun/*.bxf 2>/dev/null | wc -l) bxf"'

log "OK. Watcher açılış taramasıyla import edecek (~birkaç dk; polling 30sn)."
log "Doğrula: docker logs bcms_worker | grep -iE 'senkronize|watcher'"
