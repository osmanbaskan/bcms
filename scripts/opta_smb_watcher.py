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
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

import psycopg2
import psycopg2.extras
import smbclient

# ── Yapılandırma ──────────────────────────────────────────────────────────────

CONFIG_PATH = Path.home() / ".bcms-opta-config.json"

DB_PARAMS = dict(
    host=os.getenv("POSTGRES_HOST", "localhost"),
    port=int(os.getenv("POSTGRES_PORT", "5432")),
    dbname=os.getenv("POSTGRES_DB", "bcms"),
    user=os.getenv("POSTGRES_USER", "bcms_user"),
    password=os.getenv("POSTGRES_PASSWORD", "changeme"),
)

DEFAULT_INTERVAL = int(os.getenv("OPTA_POLL_INTERVAL", "300"))
STATE_PATH = Path.home() / ".bcms-opta-watcher-state.json"

_RESULTS_RE = re.compile(r"^srml-(\d+)-(2025|2026)-results\.xml$")
_SQUADS_RE  = re.compile(r"^srml-(\d+)-(\d+)-squads\.xml$")

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

class DBConnection:
    """Tek bir bağlantıyı yeniden kullanan, hata durumunda yeniden bağlanan wrapper."""

    def __init__(self):
        self._conn = None

    def get(self) -> psycopg2.extensions.connection:
        if self._conn is None or self._conn.closed:
            self._conn = psycopg2.connect(**DB_PARAMS)
        return self._conn

    def close(self):
        if self._conn and not self._conn.closed:
            self._conn.close()
        self._conn = None


_db = DBConnection()


def ensure_league_bulk(cur, leagues: dict[str, str]) -> dict[str, int]:
    """
    {comp_id: comp_name} → {comp_id: league_db_id}
    Tek sorguda tüm ligleri upsert eder.
    """
    if not leagues:
        return {}

    rows = [(f"opta-{cid}", name) for cid, name in leagues.items()]
    psycopg2.extras.execute_values(
        cur,
        """INSERT INTO leagues (code, name, country, metadata, created_at, updated_at)
           VALUES %s
           ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
           RETURNING code, id""",
        [(code, name, json.dumps({"optaCompId": code.removeprefix("opta-")}))
         for code, name in rows],
        template="(%s, %s, '', %s::jsonb, now(), now())",
    )
    return {row[0].removeprefix("opta-"): row[1] for row in cur.fetchall()}


def upsert_matches(matches: list[dict]) -> tuple[int, int, int]:
    """(inserted, updated, unchanged) döner. Tek DB round-trip ile toplu upsert."""
    if not matches:
        return 0, 0, 0

    conn = _db.get()
    cur  = conn.cursor()

    # 1. Tüm lig kodlarını tek sorguda upsert et
    leagues = {m["compId"]: m["compName"] for m in matches}
    league_ids = ensure_league_bulk(cur, leagues)

    # 2. Tüm opta_uid'leri tek sorguda çek
    opta_uids = [m["matchUid"] for m in matches if m["matchUid"]]
    if not opta_uids:
        conn.commit()
        cur.close()
        return 0, 0, 0

    cur.execute(
        "SELECT opta_uid, id, match_date FROM matches WHERE opta_uid = ANY(%s)",
        (opta_uids,),
    )
    existing = {row[0]: (row[1], row[2]) for row in cur.fetchall()}

    # 3. Yeni ve güncellenecekleri ayır
    to_insert = []
    to_update = []
    unchanged = 0

    for m in matches:
        uid = m["matchUid"]
        if not uid:
            continue

        new_ts = datetime.fromisoformat(
            m["matchDate"].replace("Z", "+00:00")
        ).strftime("%Y-%m-%dT%H:%MZ")

        lid = league_ids.get(m["compId"])

        if uid not in existing:
            to_insert.append((
                lid, uid,
                m["homeTeam"] or "?", m["awayTeam"] or "?",
                m["matchDate"], m["weekNumber"], m["season"], m["venue"] or None,
            ))
            log.info("YENİ MAÇ  | %s | %s - %s | %s",
                     uid, m["homeTeam"], m["awayTeam"], m["matchDate"])
        else:
            match_id, old_date = existing[uid]
            old_ts = old_date.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
            if old_ts != new_ts:
                to_update.append((m["matchDate"], match_id))
                log.info("SAAT DEĞİŞTİ | %s | %s - %s | %s → %s",
                         uid, m["homeTeam"], m["awayTeam"], old_ts, new_ts)
            else:
                unchanged += 1

    # 4. Toplu INSERT
    if to_insert:
        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO matches
                 (league_id, opta_uid, home_team_name, away_team_name,
                  match_date, week_number, season, venue, created_at, updated_at)
               VALUES %s""",
            to_insert,
            template="(%s,%s,%s,%s,%s::timestamptz,%s,%s,%s,now(),now())",
        )

    # 5. Toplu UPDATE
    if to_update:
        psycopg2.extras.execute_values(
            cur,
            "UPDATE matches SET match_date = data.dt::timestamptz, updated_at = now() "
            "FROM (VALUES %s) AS data(dt, id) WHERE matches.id = data.id",
            to_update,
        )

    conn.commit()
    cur.close()
    return len(to_insert), len(to_update), unchanged


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
            if not _RESULTS_RE.match(fname):
                continue
            try:
                mtime = entry.stat(follow_symlinks=False).st_mtime
            except Exception:
                mtime = 0.0

            if mtime > state.get(fname, 0.0):
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
        _db.close()

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
    finally:
        _db.close()

    log.info("OPTA SMB Watcher durduruldu.")


if __name__ == "__main__":
    main()
