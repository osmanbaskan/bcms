#!/usr/bin/env python3
"""
OPTA SMB Watcher — sport-aware parser unit testleri (2026-05-13).

Kapsam:
  - parse_tab7_xml           (tenis TAB7-*.xml)
  - parse_motogp_calendar_xml (MOTOGP_CALENDAR_<year>.xml)
  - parse_rugby_compfixtures_xml (ru1_compfixtures.*.xml)
  - classify_filename pattern dispatch
  - _parse_iso8601_z, _parse_motogp_local_datetime helper'ları
  - purge_sport_state_entries + _purge_env_enabled (state recovery)

Çalıştırma:
    docker compose exec opta-watcher python3 -m unittest /app/test_opta_smb_watcher.py
    # veya host'tan (defusedxml gerekir):
    PYTHONPATH=scripts python3 -m unittest scripts.test_opta_smb_watcher

XML I/O ve SMB-bağımlı wrapper'lar (parse_*_file) testlerin dışında — pure
parser fonksiyonları byte input alır, kontrat alanlarını döndürür.
"""
import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from opta_smb_watcher import (  # noqa: E402
    parse_tab7_xml,
    parse_motogp_calendar_xml,
    parse_rugby_compfixtures_xml,
    classify_filename,
    purge_sport_state_entries,
    _parse_iso8601_z,
    _parse_motogp_local_datetime,
    _purge_env_enabled,
)


# /opta/sync `matchItemSchema` zod kontratı (opta.sync.routes.ts):
#   matchUid, compId, compName, season?, matchDate (datetime+offset),
#   homeTeam?, awayTeam?, weekNumber?  (venue opsiyonel — parser'lar kullanmaz)
REQUIRED_FIELDS = {
    "matchUid", "compId", "compName", "season",
    "matchDate", "homeTeam", "awayTeam", "weekNumber",
}


def _assert_contract(test_case: unittest.TestCase, match: dict):
    """Her parser çıktısı `/opta/sync` zod şemasını karşılamalı."""
    missing = REQUIRED_FIELDS - set(match.keys())
    test_case.assertFalse(missing, f"eksik alanlar: {missing}")
    test_case.assertIsInstance(match["matchUid"], str)
    test_case.assertGreater(len(match["matchUid"]), 0)
    test_case.assertIsInstance(match["compId"], str)
    test_case.assertGreater(len(match["compId"]), 0)
    test_case.assertIsInstance(match["matchDate"], str)
    # ISO8601 (offset:true) — Z veya +HH:MM
    dt = _parse_iso8601_z(match["matchDate"])
    test_case.assertIsNotNone(dt, f"matchDate ISO8601 değil: {match['matchDate']}")


class TennisParserTests(unittest.TestCase):
    """parse_tab7_xml — TAB7-<id>.xml → tenis match dict listesi."""

    MINIMAL_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<statsperform_feed name="Tennis">
  <tournament name="ATP Marsilya" type="Singles" end_date="2026-03-15">
    <competition name="Men's Singles" sex="M">
      <round name="Quarter-Final">
        <match id="m12345" start_time="2026-03-12T14:00:00Z">
          <first_entry>
            <player display_name="N. Djokovic" first_name="Novak" last_name="Djokovic"/>
          </first_entry>
          <second_entry>
            <player display_name="C. Alcaraz" first_name="Carlos" last_name="Alcaraz"/>
          </second_entry>
        </match>
      </round>
    </competition>
  </tournament>
</statsperform_feed>"""

    def test_minimal_match_parses_to_contract(self):
        result = parse_tab7_xml(self.MINIMAL_XML)
        self.assertEqual(len(result), 1)
        m = result[0]
        _assert_contract(self, m)
        self.assertEqual(m["matchUid"],  "tennis-m12345")
        self.assertEqual(m["compId"],    "tennis")
        self.assertEqual(m["compName"],  "Tenis")
        self.assertEqual(m["season"],    "2026")
        self.assertEqual(m["homeTeam"],  "N. Djokovic")
        self.assertEqual(m["awayTeam"],  "C. Alcaraz")
        self.assertIsNone(m["weekNumber"])
        # 2026-03-12 14:00:00 UTC
        dt = _parse_iso8601_z(m["matchDate"])
        self.assertEqual(dt, datetime(2026, 3, 12, 14, 0, tzinfo=timezone.utc))

    def test_player_fallback_first_last(self):
        xml = b"""<?xml version="1.0"?>
<statsperform_feed name="Tennis">
  <tournament name="Test" end_date="2026-01-01">
    <competition name="W">
      <round name="R1">
        <match id="x1" start_time="2026-01-01T10:00:00Z">
          <first_entry><player first_name="Iga" last_name="Swiatek"/></first_entry>
          <second_entry><player last_name="Sabalenka"/></second_entry>
        </match>
      </round>
    </competition>
  </tournament>
</statsperform_feed>"""
        result = parse_tab7_xml(xml)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["homeTeam"], "Iga Swiatek")
        self.assertEqual(result[0]["awayTeam"], "Sabalenka")

    def test_invalid_xml_returns_empty_no_exception(self):
        self.assertEqual(parse_tab7_xml(b"<not-xml"), [])
        self.assertEqual(parse_tab7_xml(b""), [])
        self.assertEqual(parse_tab7_xml(b"<other_root/>"), [])

    def test_wrong_feed_name_skipped(self):
        xml = b'<statsperform_feed name="Soccer"><tournament/></statsperform_feed>'
        self.assertEqual(parse_tab7_xml(xml), [])

    def test_missing_start_time_skipped(self):
        xml = b"""<?xml version="1.0"?>
<statsperform_feed name="Tennis">
  <tournament name="Test" end_date="2026-01-01">
    <competition name="W">
      <round name="R1">
        <match id="x1"/>
      </round>
    </competition>
  </tournament>
</statsperform_feed>"""
        self.assertEqual(parse_tab7_xml(xml), [])


class MotoGPParserTests(unittest.TestCase):
    """parse_motogp_calendar_xml — F1 calendar paterni."""

    MINIMAL_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<block>
  <schedule id="bahrain-race-1">
    <session>RACE</session>
    <eventname>Bahrain GP</eventname>
    <date>15.03.2026</date>
    <start>14:00</start>
    <utc>3</utc>
    <gpno>1</gpno>
  </schedule>
</block>"""

    def test_minimal_session_parses_to_contract(self):
        result = parse_motogp_calendar_xml(self.MINIMAL_XML)
        self.assertEqual(len(result), 1)
        m = result[0]
        _assert_contract(self, m)
        self.assertEqual(m["matchUid"],  "motogp-bahrain-race-1")
        self.assertEqual(m["compId"],    "motogp")
        self.assertEqual(m["compName"],  "MotoGP")
        self.assertEqual(m["homeTeam"],  "Bahrain GP")
        self.assertEqual(m["awayTeam"],  "Yarış")  # RACE → Türkçe label
        self.assertEqual(m["weekNumber"], 1)
        # 15.03.2026 14:00 (UTC+3) → 2026-03-15 11:00 UTC
        dt = _parse_iso8601_z(m["matchDate"])
        self.assertEqual(dt, datetime(2026, 3, 15, 11, 0, tzinfo=timezone.utc))
        self.assertEqual(m["season"], "2026")

    def test_uid_fallback_when_no_id(self):
        xml = b"""<?xml version="1.0"?>
<block>
  <schedule>
    <session>QUALI</session>
    <eventname>Catalunya GP</eventname>
    <date>20.06.2026</date>
    <start>15:00</start>
    <utc>2</utc>
    <gpno>7</gpno>
  </schedule>
</block>"""
        result = parse_motogp_calendar_xml(xml)
        self.assertEqual(len(result), 1)
        # id yoksa gpno+session ile stabil uid
        self.assertEqual(result[0]["matchUid"], "motogp-7-QUALI")
        self.assertEqual(result[0]["awayTeam"], "Sıralama")

    def test_unparseable_date_skipped(self):
        xml = b"""<?xml version="1.0"?>
<block>
  <schedule id="x">
    <session>RACE</session>
    <eventname>GP</eventname>
    <date>bozuk-tarih</date>
    <start>14:00</start>
    <utc>3</utc>
  </schedule>
</block>"""
        self.assertEqual(parse_motogp_calendar_xml(xml), [])

    def test_invalid_xml_returns_empty_no_exception(self):
        self.assertEqual(parse_motogp_calendar_xml(b"<not-xml"), [])
        self.assertEqual(parse_motogp_calendar_xml(b""), [])
        self.assertEqual(parse_motogp_calendar_xml(b"<other_root/>"), [])

    def test_missing_required_fields_skipped(self):
        xml = b"<block><schedule><eventname>x</eventname></schedule></block>"
        self.assertEqual(parse_motogp_calendar_xml(xml), [])


class RugbyParserTests(unittest.TestCase):
    """parse_rugby_compfixtures_xml — ru1_compfixtures.<comp>.<season>.<ts>.xml."""

    MINIMAL_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<fixtures>
  <fixture id="999001" comp_id="204" comp_name="Top 14"
           season_id="2026" datetime="2026-04-10T19:00:00Z">
    <team home_or_away="home" team_name="Stade Toulousain"/>
    <team home_or_away="away" team_name="Racing 92"/>
  </fixture>
</fixtures>"""

    def test_minimal_fixture_parses_to_contract(self):
        result = parse_rugby_compfixtures_xml(self.MINIMAL_XML)
        self.assertEqual(len(result), 1)
        m = result[0]
        _assert_contract(self, m)
        self.assertEqual(m["matchUid"],  "rugby-999001")
        self.assertEqual(m["compId"],    "rugby-204")
        self.assertEqual(m["compName"],  "Top 14")
        self.assertEqual(m["season"],    "2026")
        self.assertEqual(m["homeTeam"],  "Stade Toulousain")
        self.assertEqual(m["awayTeam"],  "Racing 92")
        self.assertIsNone(m["weekNumber"])
        dt = _parse_iso8601_z(m["matchDate"])
        self.assertEqual(dt, datetime(2026, 4, 10, 19, 0, tzinfo=timezone.utc))

    def test_invalid_xml_returns_empty_no_exception(self):
        self.assertEqual(parse_rugby_compfixtures_xml(b"<not-xml"), [])
        self.assertEqual(parse_rugby_compfixtures_xml(b""), [])
        self.assertEqual(parse_rugby_compfixtures_xml(b"<other_root/>"), [])

    def test_missing_required_attributes_skipped(self):
        # comp_id eksik → skip
        xml = b"""<?xml version="1.0"?>
<fixtures>
  <fixture id="x1" season_id="2026" datetime="2026-04-10T19:00:00Z">
    <team home_or_away="home" team_name="A"/>
  </fixture>
</fixtures>"""
        self.assertEqual(parse_rugby_compfixtures_xml(xml), [])

    def test_unparseable_datetime_skipped(self):
        xml = b"""<?xml version="1.0"?>
<fixtures>
  <fixture id="x1" comp_id="204" season_id="2026" datetime="bozuk">
    <team home_or_away="home" team_name="A"/>
  </fixture>
</fixtures>"""
        self.assertEqual(parse_rugby_compfixtures_xml(xml), [])


class ClassifyFilenameTests(unittest.TestCase):
    """Pattern dispatch — bilinmeyen dosya None."""

    def test_srml_results(self):
        self.assertEqual(classify_filename("srml-115-2026-results.xml"), "results")

    def test_tab7(self):
        self.assertEqual(classify_filename("TAB7-336158.xml"), "tab7")
        self.assertEqual(classify_filename("TAB7-1.xml"), "tab7")

    def test_motogp_calendar(self):
        self.assertEqual(classify_filename("MOTOGP_CALENDAR_2026.xml"), "motogp")

    def test_rugby_compfixtures(self):
        self.assertEqual(classify_filename("ru1_compfixtures.204.2026.20260312192458.xml"), "rugby")

    def test_unknown(self):
        self.assertIsNone(classify_filename("foo.xml"))
        self.assertIsNone(classify_filename("srml-115-2026-squads.xml"))  # squads not handled here
        self.assertIsNone(classify_filename("MOTOGP_DRIVER_2026_1.xml"))   # driver telemetry not calendar
        self.assertIsNone(classify_filename("F1_CALENDAR_2026.xml"))       # F1 watcher kapsamında değil


class DateHelperTests(unittest.TestCase):

    def test_iso8601_with_z(self):
        dt = _parse_iso8601_z("2026-03-12T14:00:00Z")
        self.assertEqual(dt, datetime(2026, 3, 12, 14, 0, tzinfo=timezone.utc))

    def test_iso8601_with_offset(self):
        dt = _parse_iso8601_z("2026-03-12T14:00:00+03:00")
        self.assertIsNotNone(dt)
        self.assertEqual(dt.utcoffset().total_seconds(), 3 * 3600)

    def test_iso8601_empty_or_invalid(self):
        self.assertIsNone(_parse_iso8601_z(""))
        self.assertIsNone(_parse_iso8601_z("xyz"))

    def test_motogp_local_to_utc(self):
        # 15.03.2026 14:00 (UTC+3) → 2026-03-15 11:00 UTC
        dt = _parse_motogp_local_datetime("15.03.2026", "14:00", 3)
        self.assertEqual(dt, datetime(2026, 3, 15, 11, 0, tzinfo=timezone.utc))

    def test_motogp_negative_offset(self):
        # 10.06.2026 22:00 (UTC-5) → 2026-06-11 03:00 UTC
        dt = _parse_motogp_local_datetime("10.06.2026", "22:00", -5)
        self.assertEqual(dt, datetime(2026, 6, 11, 3, 0, tzinfo=timezone.utc))

    def test_motogp_invalid_returns_none(self):
        self.assertIsNone(_parse_motogp_local_datetime("bozuk", "14:00", 3))
        self.assertIsNone(_parse_motogp_local_datetime("15.03.2026", "bozuk", 3))


class PurgeStateTests(unittest.TestCase):
    """`purge_sport_state_entries` — TAB7/MOTOGP_CAL/RUGBY entry'lerini siler;
    srml-results ve bilinmeyen anahtarlar dokunulmaz.

    Bağlam: v1 öncesi watcher 72k TAB7 dosyasını state'e mtime ile yazdı ama
    parse 0 match döndü (parse_results_file pattern eşleşmemesi). Sport-aware
    parser deploy edildikten sonra aynı dosyalar tekrar parse edilmeli; bunun
    için state'ten ilgili entry'lerin silinmesi gerek.
    """

    def test_purge_removes_sport_entries(self):
        state = {
            "TAB7-336158.xml":                                    100.0,
            "TAB7-1.xml":                                         101.0,
            "MOTOGP_CALENDAR_2026.xml":                           102.0,
            "ru1_compfixtures.204.2026.20260312192458.xml":       103.0,
        }
        new_state, removed = purge_sport_state_entries(state)
        self.assertEqual(removed, 4)
        self.assertEqual(new_state, {})

    def test_purge_preserves_srml_results(self):
        state = {
            "srml-115-2026-results.xml": 200.0,
            "srml-8-2026-results.xml":   201.0,
            "TAB7-336158.xml":           300.0,
        }
        new_state, removed = purge_sport_state_entries(state)
        self.assertEqual(removed, 1)
        self.assertIn("srml-115-2026-results.xml", new_state)
        self.assertIn("srml-8-2026-results.xml",   new_state)
        self.assertNotIn("TAB7-336158.xml", new_state)
        self.assertEqual(new_state["srml-115-2026-results.xml"], 200.0)

    def test_purge_preserves_unknown_entries(self):
        """Karar: bilinmeyen entry'ler (eski/legacy/manuel) korunur — yalnızca
        bilinen sport pattern'leri silinir (defansif minimal-impact)."""
        state = {
            "TAB7-1.xml":                  100.0,
            "F1_CALENDAR_2026.xml":        200.0,  # F1: kapsamda DEĞİL
            "srml-115-2026-squads.xml":    201.0,  # squads: pattern dışında
            "manual-note.txt":             202.0,
        }
        new_state, removed = purge_sport_state_entries(state)
        self.assertEqual(removed, 1)
        self.assertNotIn("TAB7-1.xml", new_state)
        self.assertIn("F1_CALENDAR_2026.xml",     new_state)
        self.assertIn("srml-115-2026-squads.xml", new_state)
        self.assertIn("manual-note.txt",          new_state)

    def test_purge_on_empty_state_is_noop(self):
        new_state, removed = purge_sport_state_entries({})
        self.assertEqual(removed, 0)
        self.assertEqual(new_state, {})

    def test_purge_returns_new_dict_not_mutating_input(self):
        state = {"TAB7-1.xml": 1.0, "srml-115-2026-results.xml": 2.0}
        snapshot = dict(state)
        new_state, _ = purge_sport_state_entries(state)
        # Girdi mutate edilmemeli (defansif idempotency).
        self.assertEqual(state, snapshot)
        self.assertIsNot(new_state, state)


class PurgeEnvFlagTests(unittest.TestCase):
    """`OPTA_WATCHER_PURGE_SPORT_STATE_ONCE` ENV flag parse'ı.

    Önemli kontrat: flag varsayılan **kapalı**; truthy değerler dışında
    hiçbir şey purge tetiklemez. Operatör explicit set etmeden recovery
    çalışmaz (madde 4: "purge flag kapalıyken startup state değişmez").
    """

    def test_env_unset_returns_false(self):
        self.assertFalse(_purge_env_enabled({}))

    def test_env_empty_returns_false(self):
        self.assertFalse(_purge_env_enabled({"OPTA_WATCHER_PURGE_SPORT_STATE_ONCE": ""}))

    def test_env_false_returns_false(self):
        self.assertFalse(_purge_env_enabled({"OPTA_WATCHER_PURGE_SPORT_STATE_ONCE": "false"}))
        self.assertFalse(_purge_env_enabled({"OPTA_WATCHER_PURGE_SPORT_STATE_ONCE": "0"}))
        self.assertFalse(_purge_env_enabled({"OPTA_WATCHER_PURGE_SPORT_STATE_ONCE": "no"}))

    def test_env_truthy_returns_true(self):
        self.assertTrue(_purge_env_enabled({"OPTA_WATCHER_PURGE_SPORT_STATE_ONCE": "true"}))
        self.assertTrue(_purge_env_enabled({"OPTA_WATCHER_PURGE_SPORT_STATE_ONCE": "TRUE"}))
        self.assertTrue(_purge_env_enabled({"OPTA_WATCHER_PURGE_SPORT_STATE_ONCE": "1"}))
        self.assertTrue(_purge_env_enabled({"OPTA_WATCHER_PURGE_SPORT_STATE_ONCE": "yes"}))

    def test_env_whitespace_tolerated(self):
        self.assertTrue(_purge_env_enabled({"OPTA_WATCHER_PURGE_SPORT_STATE_ONCE": "  true  "}))


if __name__ == "__main__":
    unittest.main()
