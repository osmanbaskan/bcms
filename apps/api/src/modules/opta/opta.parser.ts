import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

export const OPTA_DIR = process.env.OPTA_DIR ?? '/home/ubuntu/opta';

// Yayın hakkı olan ligler (srml competition_id → görünen ad override)
const ALLOWED_COMPETITIONS: Record<string, string> = {
  '115': 'Trendyol Süper Lig',
  '8':   'İngiltere Premier Lig',
  '24':  'Fransa Ligue 1',
};

export interface OptaCompetition {
  id: string;
  name: string;
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

export interface OptaFixture {
  matchId:         string;  // e.g. "g2562216"
  competitionId:   string;
  competitionName: string;
  season:          string;
  homeTeamName:    string;
  awayTeamName:    string;
  matchDate:       string;  // ISO 8601 UTC
  weekNumber:      number | null;
  label:           string;
}

export interface FixtureCompetition {
  id:     string;
  name:   string;
  season: string;
}

// ── In-memory cache ───────────────────────────────────────────────────────────
const competitionCache  = new Map<string, OptaCompetition>();
const matchCache        = new Map<string, OptaMatch[]>();
const fixtureCache      = new Map<string, OptaFixture[]>();
const teamNameCache     = new Map<string, Map<string, string>>();
let   fixtureCompCache: FixtureCompetition[] | null = null;

const xmlParser = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: '@_',
  stopNodes:           ['Game'],
});

const srmlParser = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['MatchData', 'TeamData', 'Team', 'Stat', 'MatchOfficials', 'MatchOfficial'].includes(name),
});

// ── f24 helpers ───────────────────────────────────────────────────────────────
function parseFilename(filename: string): { comp: string; season: string; matchId: string } | null {
  const m = filename.match(/^f24-(\d+)-(\w+)-(\d+)-eventdetails\.xml$/);
  if (!m) return null;
  return { comp: m[1], season: m[2], matchId: m[3] };
}

function readGameAttrs(filePath: string): Record<string, string> | null {
  try {
    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(1024);
    const read = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    const chunk = buf.toString('utf-8', 0, read);
    const gameMatch = chunk.match(/<Game\s([^>]+)>/s);
    if (!gameMatch) return null;
    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(gameMatch[1])) !== null) attrs[a[1]] = a[2];
    return attrs;
  } catch {
    return null;
  }
}

// ── srml helpers ──────────────────────────────────────────────────────────────

// srml dosyasının ilk 1 KB'ından competition_id ve competition_name oku
function readSrmlHeader(filePath: string): { id: string; name: string; season: string } | null {
  try {
    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    const read = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    const chunk = buf.toString('utf-8', 0, read);
    const m = chunk.match(/competition_id="(\d+)"[^>]*competition_name="([^"]+)"[^>]*season_id="(\d+)"/);
    if (!m) return null;
    return { id: m[1], name: m[2], season: m[3] };
  } catch {
    return null;
  }
}

// srml-{compId}-{season}-squads.xml → Map<teamId, teamName>
function loadTeamNames(compId: string, season: string): Map<string, string> {
  const key = `${compId}-${season}`;
  if (teamNameCache.has(key)) return teamNameCache.get(key)!;

  const filePath = path.join(OPTA_DIR, `srml-${compId}-${season}-squads.xml`);
  const teamMap  = new Map<string, string>();

  try {
    const xml     = fs.readFileSync(filePath, 'utf-8');
    const parsed  = srmlParser.parse(xml);
    const teams   = parsed?.SoccerFeed?.SoccerDocument?.Team ?? [];
    for (const team of teams) {
      const uid   = team['@_uID'] as string;
      const name  = (team['@_short_club_name'] as string) || (team.Name as string) || uid;
      if (uid) teamMap.set(uid, name);
    }
  } catch {
    // squads dosyası yoksa boş map döner
  }

  teamNameCache.set(key, teamMap);
  return teamMap;
}

function buildFixtureLabel(home: string, away: string, dateUtc: string, week: number | null): string {
  const d = new Date(dateUtc);
  const pad = (n: number) => String(n).padStart(2, '0');
  const months = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
  const dateStr = `${pad(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const weekStr = week ? ` | H${week}` : '';
  return `${home} - ${away} (${dateStr}${weekStr})`;
}

// ── Fixture competition listesi (srml-*-results.xml dosyalarından) ─────────────
export function buildFixtureCompetitions(): FixtureCompetition[] {
  if (fixtureCompCache) return fixtureCompCache;

  let files: string[];
  try {
    files = fs.readdirSync(OPTA_DIR).filter((f) => /^srml-\d+-\d+-results\.xml$/.test(f));
  } catch {
    return [];
  }

  const seen    = new Set<string>();
  const results: FixtureCompetition[] = [];

  for (const file of files) {
    const m = file.match(/^srml-(\d+)-(\d+)-results\.xml$/);
    if (!m) continue;
    const [, compId, season] = m;

    // Sadece izin verilen ligler
    if (!ALLOWED_COMPETITIONS[compId]) continue;

    const key = `${compId}-${season}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const header = readSrmlHeader(path.join(OPTA_DIR, file));
    if (!header) continue;

    try {
      const content = fs.readFileSync(path.join(OPTA_DIR, file), 'utf-8');
      if (!content.includes('Period="PreMatch"')) continue;
    } catch {
      continue;
    }

    // OPTA'nın İngilizce adı yerine Türkçe adı kullan
    results.push({ id: compId, name: ALLOWED_COMPETITIONS[compId], season });
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  fixtureCompCache = results;
  return results;
}

// ── Belirli bir comp+season için gelecek fikstürleri yükle ───────────────────
export function loadFixtures(compId: string, season: string, afterDate?: Date): OptaFixture[] {
  const cacheKey = `${compId}-${season}`;
  let cached = fixtureCache.get(cacheKey);

  if (!cached) {
    const filePath = path.join(OPTA_DIR, `srml-${compId}-${season}-results.xml`);
    cached = [];

    try {
      const xml    = fs.readFileSync(filePath, 'utf-8');
      const parsed = srmlParser.parse(xml);
      const doc    = parsed?.SoccerFeed?.SoccerDocument;
      if (!doc) throw new Error('no doc');

      const compName: string = doc['@_competition_name'] ?? '';
      const teamMap = loadTeamNames(compId, season);

      const matchList: any[] = Array.isArray(doc.MatchData) ? doc.MatchData : (doc.MatchData ? [doc.MatchData] : []);

      for (const md of matchList) {
        const info = md.MatchInfo;
        if (!info || info['@_Period'] !== 'PreMatch') continue;

        const dateUtcStr: string = info.DateUtc ?? info.Date ?? '';
        if (!dateUtcStr) continue;

        // DateUtc format: "2026-04-18 11:30:00" — treat as UTC
        const utcStr     = dateUtcStr.trim().replace(' ', 'T') + 'Z';
        const matchDate  = new Date(utcStr);
        if (isNaN(matchDate.getTime())) continue;

        const weekNumber: number | null = info['@_MatchDay'] ? Number(info['@_MatchDay']) : null;
        const matchId: string = md['@_uID'] ?? '';

        // Takım adlarını squads'tan çek
        const teamDataArr: any[] = Array.isArray(md.TeamData) ? md.TeamData : (md.TeamData ? [md.TeamData] : []);
        let homeRef = '', awayRef = '';
        for (const td of teamDataArr) {
          if (td['@_Side'] === 'Home') homeRef = td['@_TeamRef'] ?? '';
          if (td['@_Side'] === 'Away') awayRef = td['@_TeamRef'] ?? '';
        }

        const homeTeamName = teamMap.get(homeRef) ?? homeRef;
        const awayTeamName = teamMap.get(awayRef) ?? awayRef;

        cached.push({
          matchId,
          competitionId:   compId,
          competitionName: compName,
          season,
          homeTeamName,
          awayTeamName,
          matchDate: matchDate.toISOString(),
          weekNumber,
          label: buildFixtureLabel(homeTeamName, awayTeamName, matchDate.toISOString(), weekNumber),
        });
      }

      cached.sort((a, b) => a.matchDate.localeCompare(b.matchDate));
    } catch {
      // dosya yoksa ya da parse hatası
    }

    fixtureCache.set(cacheKey, cached);
  }

  if (afterDate) {
    return cached.filter((f) => new Date(f.matchDate) >= afterDate);
  }
  return cached;
}

// ── f24 competition list ──────────────────────────────────────────────────────
export function buildCompetitionList(): OptaCompetition[] {
  if (competitionCache.size > 0) {
    return Array.from(competitionCache.values());
  }

  let files: string[];
  try {
    files = fs.readdirSync(OPTA_DIR).filter((f) => /^f24-\d+-\w+-\d+-eventdetails\.xml$/.test(f));
  } catch {
    return [];
  }

  const seen = new Set<string>();
  for (const filename of files) {
    const info = parseFilename(filename);
    if (!info) continue;

    if (!seen.has(info.comp)) {
      seen.add(info.comp);
      const attrs = readGameAttrs(path.join(OPTA_DIR, filename));
      if (!attrs?.competition_name) continue;

      const existing = competitionCache.get(info.comp);
      if (existing) {
        if (!existing.seasons.includes(info.season)) existing.seasons.push(info.season);
      } else {
        competitionCache.set(info.comp, {
          id:      info.comp,
          name:    attrs.competition_name,
          seasons: [info.season],
        });
      }
    } else {
      const entry = competitionCache.get(info.comp);
      if (entry && !entry.seasons.includes(info.season)) {
        entry.seasons.push(info.season);
      }
    }
  }

  return Array.from(competitionCache.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ── f24 matches ───────────────────────────────────────────────────────────────
export function loadMatches(competitionId: string, season: string): OptaMatch[] {
  const cacheKey = `${competitionId}-${season}`;
  if (matchCache.has(cacheKey)) return matchCache.get(cacheKey)!;

  let files: string[];
  try {
    files = fs.readdirSync(OPTA_DIR).filter(
      (f) => f.startsWith(`f24-${competitionId}-${season}-`) && f.endsWith('-eventdetails.xml'),
    );
  } catch {
    return [];
  }

  const matches: OptaMatch[] = [];
  for (const filename of files) {
    const info = parseFilename(filename);
    if (!info) continue;
    const attrs = readGameAttrs(path.join(OPTA_DIR, filename));
    if (!attrs?.game_date || !attrs?.home_team_name || !attrs?.away_team_name) continue;
    matches.push({
      matchId:         info.matchId,
      competitionId:   info.comp,
      competitionName: attrs.competition_name ?? '',
      season:          info.season,
      homeTeamName:    attrs.home_team_name,
      awayTeamName:    attrs.away_team_name,
      matchDate:       new Date(attrs.game_date).toISOString(),
      venue:           attrs.venue ?? undefined,
    });
  }

  matches.sort((a, b) => a.matchDate.localeCompare(b.matchDate));
  matchCache.set(cacheKey, matches);
  return matches;
}

// ── Cache temizle ─────────────────────────────────────────────────────────────
export function clearOptaCache() {
  competitionCache.clear();
  matchCache.clear();
  fixtureCache.clear();
  teamNameCache.clear();
  fixtureCompCache = null;
}
