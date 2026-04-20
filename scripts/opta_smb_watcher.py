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
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

import psycopg2
import smbclient

# ── Yapılandırma ──────────────────────────────────────────────────────────────

CONFIG_PATH = Path.home() / ".bcms-opta-config.json"

DB_PARAMS = dict(
    host=os.getenv("POSTGRES_HOST", "localhost"),
    port=int(os.getenv("POSTGRES_PORT", "5434")),
    dbname=os.getenv("POSTGRES_DB", "bcms"),
    user=os.getenv("POSTGRES_USER", "bcms_user"),
    password=os.getenv("POSTGRES_PASSWORD", "changeme"),
)

DEFAULT_INTERVAL = int(os.getenv("OPTA_POLL_INTERVAL", "300"))   # 5 dakika
STATE_PATH = Path.home() / ".bcms-opta-watcher-state.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("opta-watcher")

# ── SMB bağlantısı ─────────────────────────────────────────────────────────────

def load_smb_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text())
    except Exception:
        return {
            "share":      "//beinfilesrv/BACKUPS",
            "mountPoint": "/mnt/opta-backups",
            "subdir":     "OPTAfromFTP20511",
            "username":   "OPTA_SMB_USER",
            "password":   "OPTA_SMB_PASS",
            "domain":     "OPTA_SMB_DOMAIN",
        }


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


# ── State yönetimi (son görülen mtime'lar) ────────────────────────────────────

def load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return {}


def save_state(state: dict):
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


def parse_results_file(cfg: dict, filename: str) -> list[dict]:
    """srml-{comp}-{season}-results.xml → maç listesi."""
    import re
    m = re.match(r"^srml-(\d+)-(\d+)-results\.xml$", filename)
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

    team_names = load_team_names(cfg, comp_id, season)
    comp_name  = doc.get("competition_name", comp_id)
    matches    = []

    for md in doc.findall(".//MatchData"):
        info = md.find("MatchInfo")
        if info is None:
            continue

        date_str = info.findtext("DateUtc") or info.findtext("Date") or ""
        if not date_str:
            continue

        try:
            dt = date_str.strip().replace(" ", "T")
            if not dt.endswith("Z"):
                dt += "Z"
        except Exception:
            continue

        match_uid  = md.get("uID", "")
        match_day  = info.get("MatchDay") or info.get("MatchWeek")
        week_num   = int(match_day) if match_day and match_day.isdigit() else None
        venue      = info.findtext("Venue") or ""

        home_ref = away_ref = ""
        for td in md.findall("TeamData"):
            side = td.get("Side", "")
            if side == "Home":
                home_ref = td.get("TeamRef", "")
            elif side == "Away":
                away_ref = td.get("TeamRef", "")

        matches.append({
            "matchUid":  match_uid,
            "compId":    comp_id,
            "compName":  comp_name,
            "season":    season,
            "homeTeam":  team_names.get(home_ref, home_ref),
            "awayTeam":  team_names.get(away_ref, away_ref),
            "matchDate": dt,
            "weekNumber": week_num,
            "venue":     venue,
        })

    return matches


# ── DB işlemleri ──────────────────────────────────────────────────────────────

def get_db():
    return psycopg2.connect(**DB_PARAMS)


def ensure_league(cur, comp_id: str, comp_name: str) -> int:
    code = f"opta-{comp_id}"
    cur.execute("SELECT id FROM leagues WHERE code = %s", (code,))
    row = cur.fetchone()
    if row:
        return row[0]
    cur.execute(
        """INSERT INTO leagues (code, name, country, metadata, created_at, updated_at)
           VALUES (%s, %s, '', %s::jsonb, now(), now()) RETURNING id""",
        (code, comp_name, json.dumps({"optaCompId": comp_id})),
    )
    return cur.fetchone()[0]


def upsert_matches(matches: list[dict]) -> tuple[int, int, int]:
    """(inserted, updated, unchanged) döner."""
    if not matches:
        return 0, 0, 0

    conn = get_db()
    cur  = conn.cursor()
    inserted = updated = unchanged = 0

    # Lig haritası
    league_cache: dict[str, int] = {}

    for m in matches:
        comp_id = m["compId"]
        if comp_id not in league_cache:
            league_cache[comp_id] = ensure_league(cur, comp_id, m["compName"])
        lid = league_cache[comp_id]

        opta_uid = m["matchUid"]
        if not opta_uid:
            continue

        new_date = m["matchDate"]

        # Mevcut kaydı bul
        cur.execute(
            "SELECT id, match_date FROM matches WHERE opta_uid = %s",
            (opta_uid,),
        )
        row = cur.fetchone()

        if row is None:
            # Yeni maç
            cur.execute(
                """INSERT INTO matches
                     (league_id, opta_uid, home_team_name, away_team_name,
                      match_date, week_number, season, venue, created_at, updated_at)
                   VALUES (%s,%s,%s,%s,%s::timestamptz,%s,%s,%s,now(),now())""",
                (
                    lid, opta_uid,
                    m["homeTeam"] or "?", m["awayTeam"] or "?",
                    new_date, m["weekNumber"], m["season"], m["venue"] or None,
                ),
            )
            inserted += 1
            log.info("YENİ MAÇ  | %s | %s - %s | %s",
                     opta_uid, m["homeTeam"], m["awayTeam"], new_date)

        else:
            match_id, old_date = row
            # Tarih değişti mi? (saniye hassasiyetinde karşılaştır)
            old_ts = old_date.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
            new_ts = datetime.fromisoformat(
                new_date.replace("Z", "+00:00")
            ).strftime("%Y-%m-%dT%H:%MZ")

            if old_ts != new_ts:
                cur.execute(
                    "UPDATE matches SET match_date = %s::timestamptz, updated_at = now() WHERE id = %s",
                    (new_date, match_id),
                )
                updated += 1
                log.info(
                    "SAAT DEĞİŞTİ | %s | %s - %s | %s → %s",
                    opta_uid, m["homeTeam"], m["awayTeam"], old_ts, new_ts,
                )
            else:
                unchanged += 1

    conn.commit()
    cur.close()
    conn.close()
    return inserted, updated, unchanged


# ── Ana döngü ─────────────────────────────────────────────────────────────────

_running = True


def _stop(sig, frame):  # noqa: ANN001
    global _running
    log.info("Durdurma sinyali alındı (%s), kapanıyor…", sig)
    _running = False


signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT, _stop)


def scan_once(cfg: dict, state: dict) -> dict:
    """Bir tarama turu: değişen dosyaları işle, güncel state döndür."""
    import re

    base        = smb_path(cfg)
    new_state   = dict(state)
    total_ins   = total_upd = total_unch = 0
    files_checked = files_changed = 0

    try:
        for entry in smbclient.scandir(base):
            fname = entry.name
            if not re.match(r"^srml-\d+-(2025|2026)-results\.xml$", fname):
                continue

            try:
                mtime = entry.stat().st_mtime
            except Exception:
                mtime = 0.0

            files_checked += 1
            last_mtime = state.get(fname, 0.0)

            if mtime <= last_mtime:
                continue  # değişmemiş

            files_changed += 1
            log.info("Değişiklik algılandı: %s (mtime: %s)", fname,
                     datetime.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"))

            matches = parse_results_file(cfg, fname)
            if matches:
                ins, upd, unch = upsert_matches(matches)
                total_ins  += ins
                total_upd  += upd
                total_unch += unch

            new_state[fname] = mtime

    except Exception as e:
        log.error("SMB tarama hatası: %s", e)

    if files_changed:
        log.info(
            "Tarama tamamlandı — kontrol:%d değişen:%d | yeni:%d güncellenen:%d değişmeyen:%d",
            files_checked, files_changed, total_ins, total_upd, total_unch,
        )
    else:
        log.debug("Tarama tamamlandı — %d dosya kontrol edildi, değişiklik yok", files_checked)

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

    while _running:
        state = scan_once(cfg, state)
        save_state(state)

        if args.once:
            break

        # interval boyunca 1'er saniyede _running kontrolü
        for _ in range(args.interval):
            if not _running:
                break
            time.sleep(1)

    log.info("OPTA SMB Watcher durduruldu.")


if __name__ == "__main__":
    main()
