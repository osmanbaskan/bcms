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
from datetime import datetime, timedelta, timezone
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


# ── Yeni sport parser'ları (2026-05-13) ──────────────────────────────────────
#
# Hedef: Python watcher tek otoriter ETL kanalı olarak kalır; TAB7-*.xml
# (tenis), MOTOGP_CALENDAR_<year>.xml ve ru1_compfixtures.*.xml dosyaları
# srml-results ile aynı `/opta/sync` payload kontratına çevrilir:
#   { matchUid, compId, compName, season, matchDate (ISO8601 offset),
#     homeTeam, awayTeam, weekNumber? }
#
# compId konvansiyonu:
#   - tenis  → "tennis"          (backend leagueCodeForCompId → custom-tennis)
#   - MotoGP → "motogp"          (→ custom-motogp)
#   - rugby  → "rugby-<comp_id>" (→ custom-rugby-<comp_id>)
#
# parse_* fonksiyonları yalnızca XML byte'ı alır (test edilebilirlik); SMB
# I/O parse_*_file wrapper'larında.


def _parse_iso8601_z(value: str):
    """OPTA ISO8601 → tz-aware datetime; 'Z' veya '+HH:MM' destekler.

    Başarısızsa None döner; çağıran skip + log eder. defusedxml ya da
    pure-string operasyon — XXE riski yok.
    """
    s = (value or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            return datetime.fromisoformat(s[:-1] + "+00:00")
        # `datetime.fromisoformat` Python 3.11+ '+HH:MM' offset'i destekler.
        return datetime.fromisoformat(s)
    except ValueError:
        pass
    # Defansif fallback: "YYYY-MM-DD HH:MM:SS" (UTC kabul).
    try:
        return datetime.fromisoformat(s.replace(" ", "T") + "+00:00")
    except ValueError:
        return None


def _parse_motogp_local_datetime(date_str: str, start_str: str, utc_offset_hours: int):
    """MotoGP `date='DD.MM.YYYY'` + `start='HH:MM'` + `utc='<int>'` → UTC datetime."""
    m_date = re.match(r"^(\d{2})\.(\d{2})\.(\d{4})$", (date_str or "").strip())
    m_time = re.match(r"^(\d{2}):(\d{2})$",          (start_str or "").strip())
    if not m_date or not m_time:
        return None
    dd, mm, yyyy = m_date.group(1), m_date.group(2), m_date.group(3)
    hh, mn       = m_time.group(1), m_time.group(2)
    try:
        local_dt = datetime(int(yyyy), int(mm), int(dd), int(hh), int(mn))
    except ValueError:
        return None
    utc_dt = local_dt - timedelta(hours=utc_offset_hours)
    return utc_dt.replace(tzinfo=timezone.utc)


_MOTOGP_SESSION_LABELS = {
    "RACE":        "Yarış",
    "QUALI":       "Sıralama",
    "SPRINTRACE":  "Sprint Yarış",
    "SPRINTQUALI": "Sprint Sıralama",
    "FP1":         "Antrenman 1",
    "FP2":         "Antrenman 2",
    "FP3":         "Antrenman 3",
    "WARMUP":      "Warm-up",
}


def _extract_tennis_player_name(entry) -> str | None:
    """`<first_entry><player display_name | first_name + last_name /></first_entry>`."""
    if entry is None:
        return None
    player = entry.find("player")
    if player is None:
        return None
    display = (player.get("display_name") or "").strip()
    if display:
        return display
    first = (player.get("first_name") or "").strip()
    last  = (player.get("last_name")  or "").strip()
    name = f"{first} {last}".strip()
    return name or None


def parse_tab7_xml(content: bytes) -> list[dict]:
    """TAB7-<id>.xml → tenis match dict listesi (kontrat: matchItemSchema).

    Beklenen yapı: `<statsperform_feed name="Tennis"><tournament ...>
                      <competition><round><match start_time id />...`.
    Tek dosya tipik olarak 1 match içerir; defansif olarak çoklu round/match
    traversal'i destekler. Parse hatası → boş liste (caller skip + log).
    """
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return []
    if root.tag != "statsperform_feed":
        return []
    if (root.get("name") or "") != "Tennis":
        return []

    tournament = root.find("tournament")
    if tournament is None:
        return []

    tournament_name = (
        (tournament.get("name") or "").strip()
        or (tournament.get("tournament_class") or "").strip()
        or "Tennis"
    )
    end_date = tournament.get("end_date", "")
    season   = end_date[:4] if len(end_date) >= 4 and end_date[:4].isdigit() else "2026"

    matches: list[dict] = []
    for comp in tournament.findall("competition"):
        comp_name = (comp.get("name") or comp.get("sex") or "Singles").strip()
        for rnd in comp.findall("round"):
            for mtag in rnd.findall("match"):
                match_id   = (mtag.get("id") or "").strip()
                start_time = (mtag.get("start_time") or "").strip()
                if not match_id or not start_time:
                    continue

                match_dt = _parse_iso8601_z(start_time)
                if match_dt is None:
                    continue

                home = _extract_tennis_player_name(mtag.find("first_entry"))  or tournament_name
                away = _extract_tennis_player_name(mtag.find("second_entry")) or comp_name

                matches.append({
                    "matchUid":   f"tennis-{match_id}",
                    "compId":     "tennis",
                    "compName":   "Tenis",
                    "season":     season,
                    "matchDate":  match_dt.isoformat(),
                    "homeTeam":   home,
                    "awayTeam":   away,
                    "weekNumber": None,
                })
    return matches


def parse_motogp_calendar_xml(content: bytes, fallback_season: str = "2026") -> list[dict]:
    """MOTOGP_CALENDAR_<year>.xml → MotoGP session dict listesi.

    F1 paterni: `<block><schedule><session/><eventname/><date/><start/><utc/>
                  <gpno/></schedule>...`. session ve eventname zorunlu;
    tarih/saat parse edilemiyorsa skip.
    """
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return []
    if root.tag != "block":
        return []

    matches: list[dict] = []
    for sch in root.findall("schedule"):
        sched_id  = (sch.get("id") or "").strip()
        session   = (sch.findtext("session")   or "").strip()
        eventname = (sch.findtext("eventname") or "").strip()
        date_str  = (sch.findtext("date")      or "").strip()
        start_str = (sch.findtext("start")     or "").strip()
        utc_str   = (sch.findtext("utc")       or "0").strip()
        gpno_str  = (sch.findtext("gpno")      or "0").strip()

        if not session or not eventname:
            continue
        try:
            utc_offset = int(utc_str)
        except ValueError:
            utc_offset = 0
        try:
            gpno = int(gpno_str)
        except ValueError:
            gpno = 0

        match_dt = _parse_motogp_local_datetime(date_str, start_str, utc_offset)
        if match_dt is None:
            continue

        session_label = _MOTOGP_SESSION_LABELS.get(session, session)
        # matchUid stabil olmalı; OPTA `id` attribute'ü yoksa session+gpno
        # fallback (aynı yarış weekend'inde her oturum benzersiz).
        uid_seed = sched_id or f"{gpno}-{session}"
        matches.append({
            "matchUid":   f"motogp-{uid_seed}",
            "compId":     "motogp",
            "compName":   "MotoGP",
            "season":     str(match_dt.year) or fallback_season,
            "matchDate":  match_dt.isoformat(),
            "homeTeam":   eventname,
            "awayTeam":   session_label,
            "weekNumber": gpno or None,
        })
    return matches


def parse_rugby_compfixtures_xml(content: bytes) -> list[dict]:
    """ru1_compfixtures.<comp>.<season>.<ts>.xml → rugby fixture dict listesi.

    Yapı: `<fixtures><fixture id comp_id comp_name season_id datetime>
                  <team home_or_away="home|away" team_name=.../>...`.
    Zorunlu attribute'ler: id, comp_id, season_id, datetime. Eksikse skip.
    """
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return []
    if root.tag != "fixtures":
        return []

    matches: list[dict] = []
    for fix in root.findall("fixture"):
        fixture_id  = (fix.get("id")        or "").strip()
        comp_num    = (fix.get("comp_id")   or "").strip()
        comp_name   = (fix.get("comp_name") or "Rugby").strip()
        season_id   = (fix.get("season_id") or "").strip()
        dt_str      = (fix.get("datetime")  or "").strip()
        if not (fixture_id and comp_num and season_id and dt_str):
            continue

        match_dt = _parse_iso8601_z(dt_str)
        if match_dt is None:
            continue

        home_name = "Home"
        away_name = "Away"
        for team in fix.findall("team"):
            side = (team.get("home_or_away") or "").strip()
            name = (team.get("team_name") or (team.text or "")).strip()
            if not name:
                continue
            if side == "home":
                home_name = name
            elif side == "away":
                away_name = name

        matches.append({
            "matchUid":   f"rugby-{fixture_id}",
            "compId":     f"rugby-{comp_num}",
            "compName":   comp_name or "Rugby",
            "season":     season_id,
            "matchDate":  match_dt.isoformat(),
            "homeTeam":   home_name,
            "awayTeam":   away_name,
            "weekNumber": None,
        })
    return matches


# ── SMB-bağımlı wrapper'lar (test edilmez; pure-XML parser'lara delege eder)

def parse_tab7_file(cfg: dict, filename: str) -> list[dict]:
    return parse_tab7_xml(read_smb_file(cfg, filename))


def parse_motogp_calendar_file(cfg: dict, filename: str) -> list[dict]:
    m = _MOTOGP_CAL_RE.match(filename)
    fallback_season = m.group(1) if m else "2026"
    return parse_motogp_calendar_xml(read_smb_file(cfg, filename), fallback_season=fallback_season)


def parse_rugby_compfixtures_file(cfg: dict, filename: str) -> list[dict]:
    return parse_rugby_compfixtures_xml(read_smb_file(cfg, filename))


# ── Pattern dispatch ──────────────────────────────────────────────────────────

def classify_filename(fname: str) -> str | None:
    """Bilinen pattern'lerden hangisi → sport kind; eşleşme yoksa None."""
    if _RESULTS_RE.match(fname):    return "results"
    if _TAB7_RE.match(fname):       return "tab7"
    if _MOTOGP_CAL_RE.match(fname): return "motogp"
    if _RUGBY_RE.match(fname):      return "rugby"
    return None


# ── State recovery (2026-05-13) ───────────────────────────────────────────────
#
# Sebep: v1 öncesi watcher, TAB7 / MOTOGP_CALENDAR / ru1_compfixtures pattern'leri
# `scan_once`'a dahil edilmiş ama parse `parse_results_file`'a yönlenip `[]`
# döndüğü için state map'e mtime yazıldı (eski davranış). Bu nedenle watcher
# state dosyasında bu dosyalar "işlenmiş" gibi duruyor.
#
# Sport-aware parser deploy edildikten sonra aynı TAB7/MOTOGP/Rugby dosyalarının
# tekrar parse edilmesi gerekir; ancak mtime state'te aynı kaldığı için
# `scan_once` "değişiklik yok" der ve dosyaları skip eder.
#
# Çözüm: bir-kerelik state recovery — sport pattern'lerini state'ten çıkar;
# srml-results entry'leri ve bilinmeyen anahtarlar dokunulmaz.

def purge_sport_state_entries(state: dict) -> tuple[dict, int]:
    """Sport pattern entry'lerini (TAB7/MOTOGP_CAL/RUGBY) state'ten çıkar.

    `classify_filename` ile kategorize edilir; `results` (srml-results) ve
    None (bilinmeyen anahtar) korunur. Sadece `tab7` / `motogp` / `rugby`
    silinir.

    Returns: `(yeni_state_dict, silinen_entry_sayısı)`.
    """
    new_state: dict = {}
    removed = 0
    for key, val in state.items():
        kind = classify_filename(key)
        if kind in ("tab7", "motogp", "rugby"):
            removed += 1
            continue
        new_state[key] = val
    return new_state, removed


def _purge_env_enabled(env: dict | None = None) -> bool:
    """`OPTA_WATCHER_PURGE_SPORT_STATE_ONCE` ENV truthy ise True (case-insensitive)."""
    src = env if env is not None else os.environ
    val = src.get("OPTA_WATCHER_PURGE_SPORT_STATE_ONCE", "")
    return val.strip().lower() in ("true", "1", "yes")


def _do_purge_sport_state(source: str) -> int:
    """Disk state'ini oku, purge et, yaz; silinen sayıyı döner.

    `load_state` / `save_state` mevcut kontrat'ı kullanır — state dosyası
    yolu `STATE_PATH` (`HOME=/data` → `/data/.bcms-opta-watcher-state.json`).
    """
    state = load_state()
    new_state, removed = purge_sport_state_entries(state)
    save_state(new_state, state)
    log.info(
        "Sport state purge — TAB7/MOTOGP_CAL/RUGBY silindi "
        "(silinen:%d, kalan:%d, kaynak:%s)",
        removed, len(new_state), source,
    )
    return removed


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
    """Bir tarama turu: değişen dosyaları sport bazlı parse et, güncel state döndür.

    State advance kuralları (2026-05-13):
      - `results` (srml-results): mevcut davranış aynen korunur — parse
        çağrısı sonrası mtime state'e yazılır (POST sonucundan bağımsız).
        Mevcut futbol akışı bozulmaz.
      - `tab7` / `motogp` / `rugby`: parse exception veya 0 match dönerse
        state advance EDİLMEZ (sonraki turda tekrar denenir). Parse ≥1 match
        döndürdü VE batch POST başarılıysa state advance edilir.
      - Pattern eşleşmeyen dosya zaten taramaya alınmaz.
    """
    base      = smb_path(cfg)
    new_state = dict(state)
    changed_files: list[tuple[str, float, str]] = []  # (fname, mtime, kind)

    try:
        for entry in smbclient.scandir(base):
            fname = entry.name
            kind = classify_filename(fname)
            if kind is None:
                continue
            try:
                mtime = entry.stat(follow_symlinks=False).st_mtime
            except Exception:
                mtime = 0.0

            now = time.time()
            if mtime > state.get(fname, 0.0) and (now - mtime) >= MTIME_SETTLE_SEC:
                changed_files.append((fname, mtime, kind))
                log.info("Değişiklik algılandı: %s [%s] (mtime: %s)", fname, kind,
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
    # POST sonrası kalıcılaştırılacak (tennis/motogp/rugby) state.
    pending_state: dict[str, float] = {}

    for fname, mtime, kind in changed_files:
        try:
            if kind == "results":
                # Futbol mevcut akışı — POST sonucundan bağımsız state advance.
                matches = parse_results_file(cfg, fname, team_cache)
                all_matches.extend(matches)
                new_state[fname] = mtime
            elif kind == "tab7":
                matches = parse_tab7_file(cfg, fname)
                if matches:
                    all_matches.extend(matches)
                    pending_state[fname] = mtime
                else:
                    log.warning("TAB7 parse 0 match: %s — state advance edilmedi", fname)
            elif kind == "motogp":
                matches = parse_motogp_calendar_file(cfg, fname)
                if matches:
                    all_matches.extend(matches)
                    pending_state[fname] = mtime
                else:
                    log.warning("MotoGP parse 0 match: %s — state advance edilmedi", fname)
            elif kind == "rugby":
                matches = parse_rugby_compfixtures_file(cfg, fname)
                if matches:
                    all_matches.extend(matches)
                    pending_state[fname] = mtime
                else:
                    log.warning("Rugby parse 0 match: %s — state advance edilmedi", fname)
        except Exception as e:
            log.error("Dosya işleme hatası %s [%s]: %s", fname, kind, e)
            # Yeni sport pattern'lerinde state advance edilmez; futbol için
            # mevcut bug-uyumlu davranış değişmedi (parse_results_file kendi
            # exception'larını swallow eder + boş döner).

    # Tüm maçları tek seferde DB'ye yaz
    try:
        ins, upd, unch = upsert_matches(all_matches)
        # POST başarılı → tennis/motogp/rugby state'i kalıcılaştır.
        new_state.update(pending_state)
        log.info(
            "Tarama tamamlandı — değişen:%d dosya | yeni:%d güncellenen:%d değişmeyen:%d",
            len(changed_files), ins, upd, unch,
        )
    except Exception as e:
        log.error("DB yazma hatası: %s — sport pending state atıldı", e)
        # `pending_state` atılır; sonraki turda tekrar denenir. `new_state`
        # içindeki srml-results advance'i korunur (mevcut "bozma" kuralı).

    return new_state


def main():
    parser = argparse.ArgumentParser(description="OPTA SMB Watcher")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL,
                        help="Tarama aralığı (saniye, varsayılan: 300)")
    parser.add_argument("--once", action="store_true",
                        help="Tek seferlik tarama yap ve çık")
    # State recovery (2026-05-13): TAB7/MOTOGP_CAL/RUGBY entry'lerini state'ten
    # tek seferlik temizler. SMB I/O yapmaz; sadece disk state'ini düzenler.
    parser.add_argument("--purge-sport-state", action="store_true",
                        help="State'ten TAB7/MOTOGP_CAL/RUGBY entry'lerini "
                             "tek seferlik sil ve çık (srml-results dokunulmaz)")
    args = parser.parse_args()

    # ── Startup state recovery hook ──────────────────────────────────────────
    # İki tetikleyici:
    #   1) `--purge-sport-state` CLI argümanı → purge + exit (ad-hoc komut).
    #   2) `OPTA_WATCHER_PURGE_SPORT_STATE_ONCE=true` ENV → startup'ta purge,
    #      sonra normal döngüye devam (deployment ile birlikte recovery).
    # `--purge-sport-state` `OPTA_WATCHER_PURGE_SPORT_STATE_ONCE`'a göre öncelikli.
    if args.purge_sport_state:
        _do_purge_sport_state("CLI --purge-sport-state")
        log.info("Purge tamamlandı — çıkılıyor (CLI mode)")
        return
    if _purge_env_enabled():
        _do_purge_sport_state("ENV OPTA_WATCHER_PURGE_SPORT_STATE_ONCE")
        # Normal döngüye devam — operatör ENV'i bir sonraki deployment'ta
        # unset etmeli; aksi halde her container restart purge çalışır
        # (idempotent ama log gürültüsü yapar).

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
