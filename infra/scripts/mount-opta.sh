#!/usr/bin/env bash
# OPTA SMB share'ini kalıcı olarak mount eder.
# Çalıştırmadan önce env değişkenlerini ayarla:
#   export OPTA_SMB_SHARE=//server/share
#   export OPTA_SMB_SUBDIR=subfolder
#   export OPTA_SMB_DOMAIN=domain
# Sonra: sudo -E bash infra/scripts/mount-opta.sh

set -euo pipefail

SHARE="${OPTA_SMB_SHARE:?OPTA_SMB_SHARE env değişkeni gerekli}"
SUBDIR="${OPTA_SMB_SUBDIR:?OPTA_SMB_SUBDIR env değişkeni gerekli}"
DOMAIN="${OPTA_SMB_DOMAIN:-}"
MOUNT_POINT="${OPTA_SMB_MOUNT_POINT:-/mnt/opta-backups}"
CRED_FILE="/home/ubuntu/.bcms-opta.cred"
UID_VAL=$(id -u ubuntu)
GID_VAL=$(id -g ubuntu)

# Paket kur
if ! command -v mount.cifs &>/dev/null; then
  echo "[*] cifs-utils kuruluyor..."
  apt-get install -y cifs-utils
fi

# Mount noktası oluştur
mkdir -p "$MOUNT_POINT"

# fstab kaydı yoksa ekle
DOMAIN_OPT="${DOMAIN:+,domain=${DOMAIN}}"
FSTAB_LINE="${SHARE} ${MOUNT_POINT} cifs credentials=${CRED_FILE}${DOMAIN_OPT},uid=${UID_VAL},gid=${GID_VAL},iocharset=utf8,file_mode=0755,dir_mode=0755,_netdev,x-systemd.automount,x-systemd.device-timeout=10s 0 0"

if ! grep -qF "$SHARE" /etc/fstab; then
  echo "[*] /etc/fstab'a mount kaydı ekleniyor..."
  echo "$FSTAB_LINE" >> /etc/fstab
else
  echo "[*] /etc/fstab'da kayıt zaten var, atlanıyor."
fi

# Hemen mount et
echo "[*] Share mount ediliyor: ${SHARE}/${SUBDIR}"
mount -a

if mountpoint -q "$MOUNT_POINT"; then
  echo "[OK] Mount başarılı: ${MOUNT_POINT}"
  echo "     OPTA dizini: ${MOUNT_POINT}/${SUBDIR}"
  ls "${MOUNT_POINT}/${SUBDIR}" 2>/dev/null | head -5 || echo "(dizin boş ya da erişilemiyor)"
else
  echo "[HATA] Mount başarısız!"
  exit 1
fi

echo ""
echo "Sonraki adım: .env dosyasına şunu ekle:"
echo "  OPTA_DIR=${MOUNT_POINT}/${SUBDIR}"
