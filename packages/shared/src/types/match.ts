export interface League {
  id: number;
  code: string;
  name: string;
  country: string;
  /** MED-SHARED-003 fix (2026-05-05): DB'de var, type'ta yoktu. */
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Match {
  id: number;
  leagueId: number;
  /** MED-SHARED-002 fix (2026-05-05): OPTA UID — DB'de UNIQUE, type'a eklendi. */
  optaUid?: string | null;
  homeTeamName: string;
  awayTeamName: string;
  matchDate: string; // ISO 8601
  weekNumber?: number | null;
  season: string;
  venue?: string | null;
  league?: League;
}

export interface MatchListItem extends Match {
  label: string; // "Galatasaray - Fenerbahçe (18 Nis 2026 19:00)"
}

// ── OPTA Arşiv Tipleri ────────────────────────────────────────────────────────
export interface OptaCompetition {
  id:      string;
  name:    string;
  seasons: string[];
}

export interface OptaMatch {
  matchId:         string;
  competitionId:   string;
  competitionName: string;
  season:          string;
  homeTeamName:    string;
  awayTeamName:    string;
  matchDate:       string; // ISO 8601
  venue?:          string;
}
