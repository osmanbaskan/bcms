#!/usr/bin/env python3
"""
OPTA SMB Watcher — srml-results.xml dosyalarını izler,
maç saat değişikliklerini anında PostgreSQL'e yazar.

Çalıştırma:
    python3 opta_smb_watcher.py
    python3 opta_smb_watcher.py --interval 120   # saniye
"""
import argparse
import json
import logging
import os
import re
import signal
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from defusedxml import ElementTree as ET

import smbclient

# ── Yapılandırma ──────────────────────────────────────────────────────────────

CONFIG_PATH = Path.home() / ".bcms-opta-config.json"

API_URL = os.getenv("BCMS_API_URL", "http://api:3000/api/v1")
API_TOKEN = os.getenv("BCMS_API_TOKEN", "")

DEFAULT_INTERVAL = int(os.getenv("OPTA_POLL_INTERVAL", "3600"))
STATE_PATH = Path.home() / ".bcms-opta-watcher-state.json"

# Dosya son değişikliğinden bu kadar saniye geçmeden işlenmez (yarım yazma koruması)
MTIME_SETTLE_SEC = 5
# Tek bir API isteğinde gönderilecek maksimum maç sayısı
BATCH_SIZE = 100

_RESULTS_RE = re.compile(r"^srml-(\d+)-(\d{4})-results\.xml$")
_SQUADS_RE  = re.compile(r"^srml-(\d+)-(\d+)-squads\.xml$")
# 2026-05-13: Yeni sport feed pattern'leri — tenis (TAB7), MotoGP takvim,
# rugby fixtures. Watcher bu dosyaları SMB'den /opta volume'una düşürür;
# Backend OPTA parser ilgili compId'de okur. F1 paterniyle MotoGP takvim
# dosyası operatör tarafından manuel oluşturulur (MOTOGP_CALENDAR_<year>.xml).
_TAB7_RE      = re.compile(r"^TAB7-(\d+)\.xml$")
_MOTOGP_CAL_RE = re.compile(r"^MOTOGP_CALENDAR_(\d{4})\.xml$")
_RUGBY_RE     = re.compile(r"^ru1_compfixtures\.[^.]+\.[^.]+\..*\.xml$")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
# smbclient her SMB2 paketini logluyor, bunu kapat
logging.getLogger("smbclient").setLevel(logging.WARNING)
logging.getLogger("smbprotocol").setLevel(logging.WARNING)
log = logging.getLogger("opta-watcher")

# ── SMB bağlantısı ────────────────────────────────────────────────────────────

DEFAULT_SMB_CONFIG = {
    "share":    os.getenv("OPTA_SMB_SHARE", ""),
    "subdir":   os.getenv("OPTA_SMB_SUBDIR", ""),
    "username": os.getenv("OPTA_SMB_USERNAME", ""),
    "password": os.getenv("OPTA_SMB_PASSWORD", ""),
    "domain":   os.getenv("OPTA_SMB_DOMAIN", ""),
}


def load_smb_config() -> dict:
    try:
        return {**DEFAULT_SMB_CONFIG, **json.loads(CONFIG_PATH.read_text())}
    except Exception:
        return DEFAULT_SMB_CONFIG.copy()


def smb_connect(cfg: dict):
    smbclient.reset_connection_cache()
    smbclient.ClientConfig(
        username=cfg["username"],
        password=cfg["password"],
        domain=cfg.get("domain", ""),
    )


def smb_path(cfg: dict, filename: str = "") -> str:
    server = cfg["share"].lstrip("/").split("/")[0]
    share  = cfg["share"].lstrip("/").split("/")[1]
    subdir = cfg["subdir"]
    base   = f"\\\\{server}\\{share}\\{subdir}"
    return f"{base}\\{filename}" if filename else base


# ── State yönetimi ────────────────────────────────────────────────────────────

def load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return {}


def save_state(state: dict, old_state: dict):
    if state != old_state:
        STATE_PATH.write_text(json.dumps(state, indent=2))


# ── XML parse ─────────────────────────────────────────────────────────────────

def read_smb_file(cfg: dict, filename: str) -> bytes:
    with smbclient.open_file(smb_path(cfg, filename), mode="rb") as f:
        return f.read()


def load_team_names(cfg: dict, comp_id: str, season: str) -> dict:
    fname = f"srml-{comp_id}-{season}-squads.xml"
    teams = {}
    try:
        content = read_smb_file(cfg, fname)
        root = ET.fromstring(content)
        for team in root.iter("Team"):
            uid  = team.get("uID", "")
            name = team.get("short_club_name") or team.findtext("Name") or uid
            if uid:
                teams[uid] = name
    except Exception:
        pass
    return teams


def parse_results_file(cfg: dict, filename: str, team_cache: dict) -> list[dict]:
    """srml-{comp}-{season}-results.xml → maç listesi."""
    m = _RESULTS_RE.match(filename)
    if not m:
        return []
    comp_id, season = m.group(1), m.group(2)

    try:
        content = read_smb_file(cfg, filename)
        root = ET.fromstring(content)
        doc = root.find("SoccerDocument") or root
    except Exception as e:
        log.warning("Parse hatası %s: %s", filename, e)
        return []

    cache_key = f"{comp_id}-{season}"
    if cache_key not in team_cache:
        team_cache[cache_key] = load_team_names(cfg, comp_id, season)
    team_names = team_cache[cache_key]

    comp_name = doc.get("competition_name", comp_id)
    matches   = []

    for md in doc.findall(".//MatchData"):
        info = md.find("MatchInfo")
        if info is None:
            continue

        date_str = info.findtext("DateUtc") or info.findtext("Date") or ""
        if not date_str:
            continue

        dt = date_str.strip().replace(" ", "T")
        if not dt.endswith("Z"):
            dt += "Z"

        match_uid = md.get("uID", "")
        match_day = info.get("MatchDay") or info.get("MatchWeek")
        week_num  = int(match_day) if match_day and match_day.isdigit() else None
        venue     = info.findtext("Venue") or ""

        home_ref = away_ref = ""
        for td in md.findall("TeamData"):
            side = td.get("Side", "")
            if side == "Home":
                home_ref = td.get("TeamRef", "")
            elif side == "Away":
                away_ref = td.get("TeamRef", "")

        matches.append({
            "matchUid":   match_uid,
            "compId":     comp_id,
            "compName":   comp_name,
            "season":     season,
            "homeTeam":   team_names.get(home_ref, home_ref),
            "awayTeam":   team_names.get(away_ref, away_ref),
            "matchDate":  dt,
            "weekNumber": week_num,
            "venue":      venue,
        })

    return matches


# ── DB işlemleri ──────────────────────────────────────────────────────────────

def upsert_matches(matches: list[dict]) -> tuple[int, int, int]:
    """(inserted, updated, unchanged) döner. Verileri BATCH_SIZE'lık parçalar hâlinde API'ye gönderir."""
    if not matches:
        return 0, 0, 0

    total_ins = total_upd = total_unch = 0
    for i in range(0, len(matches), BATCH_SIZE):
        chunk = matches[i:i + BATCH_SIZE]
        req = urllib.request.Request(
            f"{API_URL}/opta/sync",
            data=json.dumps({"matches": chunk}).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {API_TOKEN}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8"))
                total_ins  += data.get("inserted", 0)
                total_upd  += data.get("updated", 0)
                total_unch += data.get("unchanged", 0)
        except urllib.error.URLError as e:
            log.error("API'ye gönderim hatası (batch %d-%d): %s", i, i + len(chunk), e)
            raise
    return total_ins, total_upd, total_unch


# ── Ana döngü ─────────────────────────────────────────────────────────────────

_running = True


def _stop(sig, frame):  # noqa: ANN001
    global _running
    log.info("Durdurma sinyali alındı (%s), kapanıyor…", sig)
    _running = False


signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT, _stop)


def scan_once(cfg: dict, state: dict) -> dict:
    """Bir tarama turu: değişen dosyaları paralel işle, güncel state döndür."""
    base      = smb_path(cfg)
    new_state = dict(state)
    changed_files: list[tuple[str, float]] = []

    try:
        for entry in smbclient.scandir(base):
            fname = entry.name
            # 2026-05-13: Pattern set genişledi — futbol (srml-results) +
            # tenis (TAB7) + MotoGP takvim + rugby (ru1_compfixtures).
            if not (_RESULTS_RE.match(fname)
                    or _TAB7_RE.match(fname)
                    or _MOTOGP_CAL_RE.match(fname)
                    or _RUGBY_RE.match(fname)):
                continue
            try:
                mtime = entry.stat(follow_symlinks=False).st_mtime
            except Exception:
                mtime = 0.0

            now = time.time()
            if mtime > state.get(fname, 0.0) and (now - mtime) >= MTIME_SETTLE_SEC:
                changed_files.append((fname, mtime))
                log.info("Değişiklik algılandı: %s (mtime: %s)", fname,
                         datetime.fromtimestamp(mtime, tz=timezone.utc)
                         .strftime("%Y-%m-%d %H:%M:%S UTC"))
    except Exception as e:
        log.error("SMB tarama hatası: %s", e)
        return new_state

    if not changed_files:
        log.debug("Tarama tamamlandı — değişiklik yok")
        return new_state

    team_cache: dict[str, dict] = {}
    all_matches: list[dict] = []

    for fname, mtime in changed_files:
        try:
            matches = parse_results_file(cfg, fname, team_cache)
            all_matches.extend(matches)
            new_state[fname] = mtime
        except Exception as e:
            log.error("Dosya işleme hatası %s: %s", fname, e)

    # Tüm maçları tek seferde DB'ye yaz
    try:
        ins, upd, unch = upsert_matches(all_matches)
        log.info(
            "Tarama tamamlandı — değişen:%d dosya | yeni:%d güncellenen:%d değişmeyen:%d",
            len(changed_files), ins, upd, unch,
        )
    except Exception as e:
        log.error("DB yazma hatası: %s", e)

    return new_state


def main():
    parser = argparse.ArgumentParser(description="OPTA SMB Watcher")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL,
                        help="Tarama aralığı (saniye, varsayılan: 300)")
    parser.add_argument("--once", action="store_true",
                        help="Tek seferlik tarama yap ve çık")
    args = parser.parse_args()

    cfg   = load_smb_config()
    state = load_state()

    log.info("OPTA SMB Watcher başlatıldı | share: %s/%s | aralık: %ds",
             cfg["share"], cfg["subdir"], args.interval)

    smb_connect(cfg)

    try:
        while _running:
            old_state = dict(state)
            state = scan_once(cfg, state)
            save_state(state, old_state)

            if args.once:
                break

            for _ in range(args.interval):
                if not _running:
                    break
                time.sleep(1)
    except KeyboardInterrupt:
        pass

    log.info("OPTA SMB Watcher durduruldu.")


if __name__ == "__main__":
    main()
