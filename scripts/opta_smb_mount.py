#!/usr/bin/env python3
"""
OPTA SMB FUSE mount (read-only)
//beinfilesrv/BACKUPS/OPTAfromFTP20511 → /home/ubuntu/opta

Çalıştırma:
    python3 opta_smb_mount.py [--mountpoint /home/ubuntu/opta]
"""
import argparse
import errno
import json
import logging
import os
import stat
import sys
import time
from pathlib import Path
from threading import Lock

import smbclient
import smbclient.path
from fuse import FUSE, FuseOSError, Operations

CONFIG_PATH = Path.home() / ".bcms-opta-config.json"
log = logging.getLogger("opta-smb-mount")


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text())
    except Exception:
        return {
            "share":    "//beinfilesrv/BACKUPS",
            "subdir":   "OPTAfromFTP20511",
            "username": "OPTA_SMB_USER",
            "password": "OPTA_SMB_PASS",
            "domain":   "OPTA_SMB_DOMAIN",
        }


def smb_unc(cfg: dict, posix_path: str = "") -> str:
    server = cfg["share"].lstrip("/").split("/")[0]
    share  = cfg["share"].lstrip("/").split("/")[1]
    base   = f"\\\\{server}\\{share}\\{cfg['subdir']}"
    if posix_path and posix_path != "/":
        return base + posix_path.replace("/", "\\")
    return base


class OptaSmbFS(Operations):
    def __init__(self, cfg: dict):
        self.cfg  = cfg
        self._lk  = Lock()
        self._dir_cache:  dict[str, tuple[float, list]] = {}
        self._attr_cache: dict[str, tuple[float, dict]]  = {}
        self.TTL = 30.0

        smbclient.reset_connection_cache()
        smbclient.ClientConfig(
            username=cfg["username"],
            password=cfg["password"],
            domain=cfg.get("domain", ""),
        )
        log.info("SMB bağlantısı kuruldu: %s", smb_unc(cfg))

    # ── helpers ──────────────────────────────────────────────────────────────

    def _unc(self, path: str) -> str:
        return smb_unc(self.cfg, path)

    def _readdir_cached(self, path: str) -> list:
        now = time.monotonic()
        with self._lk:
            c = self._dir_cache.get(path)
            if c and now - c[0] < self.TTL:
                return c[1]
        entries = []
        try:
            for e in smbclient.scandir(self._unc(path)):
                entries.append((e.name, e.stat()))
        except Exception:
            pass
        with self._lk:
            self._dir_cache[path] = (now, entries)
        return entries

    # ── FUSE ops ─────────────────────────────────────────────────────────────

    def getattr(self, path: str, fh=None) -> dict:
        if path == "/":
            return dict(st_mode=stat.S_IFDIR | 0o555, st_nlink=2,
                        st_size=0, st_atime=0, st_mtime=0, st_ctime=0)
        now = time.monotonic()
        with self._lk:
            c = self._attr_cache.get(path)
            if c and now - c[0] < self.TTL:
                return c[1]
        try:
            s = smbclient.stat(self._unc(path))
            if stat.S_ISDIR(s.st_mode):
                attrs = dict(st_mode=stat.S_IFDIR | 0o555, st_nlink=2,
                             st_size=0, st_atime=int(s.st_mtime),
                             st_mtime=int(s.st_mtime), st_ctime=int(s.st_mtime))
            else:
                attrs = dict(st_mode=stat.S_IFREG | 0o444, st_nlink=1,
                             st_size=s.st_size, st_atime=int(s.st_mtime),
                             st_mtime=int(s.st_mtime), st_ctime=int(s.st_mtime))
        except Exception:
            raise FuseOSError(errno.ENOENT)
        with self._lk:
            self._attr_cache[path] = (now, attrs)
        return attrs

    def readdir(self, path: str, fh):
        yield "."
        yield ".."
        for name, _ in self._readdir_cached(path):
            yield name

    def open(self, path: str, flags: int) -> int:
        if (flags & os.O_ACCMODE) != os.O_RDONLY:
            raise FuseOSError(errno.EACCES)
        return 0

    def read(self, path: str, size: int, offset: int, fh: int) -> bytes:
        try:
            with smbclient.open_file(self._unc(path), mode="rb") as f:
                f.seek(offset)
                return f.read(size)
        except Exception as e:
            log.warning("read hata %s: %s", path, e)
            raise FuseOSError(errno.EIO)

    def statfs(self, path: str) -> dict:
        return dict(f_bsize=512, f_blocks=0, f_bfree=0, f_bavail=0,
                    f_files=0, f_ffree=0)


def main():
    ap = argparse.ArgumentParser(description="OPTA SMB FUSE mount")
    ap.add_argument("--mountpoint", default="/home/ubuntu/opta")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    cfg = load_config()
    mp  = args.mountpoint

    os.makedirs(mp, exist_ok=True)

    log.info("Mount: %s/%s → %s", cfg["share"], cfg["subdir"], mp)
    # default_permissions: kernel kendi mode bit kontrolünü yapar, FUSE'a access() göndermez
    FUSE(OptaSmbFS(cfg), mp, nothreads=True, foreground=False,
         ro=True, nonempty=True, allow_other=False, default_permissions=True)
    log.info("Mount tamamlandı.")


if __name__ == "__main__":
    main()
