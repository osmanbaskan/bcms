import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

export const OPTA_DIR = process.env.OPTA_DIR ?? '/mnt/opta-backups/OPTAfromFTP20511';

// Yayın hakkı olan ligler (srml competition_id → görünen ad override)
const ALLOWED_COMPETITIONS: Record<string, string> = {
  '115': 'Trendyol Süper Lig',
  '8':   'İngiltere Premier Lig',
  '24':  'Fransa Ligue 1',
};

// F1 session kodları → Türkçe etiket
const F1_SESSION_LABELS: Record<string, string> = {
  RACE:          'Yarış',
  QUALI:         'Sıralama',
  SPRINTRACE:    'Sprint Yarış',
  SPRINTSHOOTOUT:'Sprint Sıralama',
  FP1:           'Antrenman 1',
  FP2:           'Antrenman 2',
  FP3:           'Antrenman 3',
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
  // MED-API-020 fix (2026-05-05): readSync throw ederse fd leak'i; try/finally
  // ile garantili close.
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(1024);
    const read = fs.readSync(fd, buf, 0, 1024, 0);
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
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

// ── srml helpers ──────────────────────────────────────────────────────────────

// srml dosyasının ilk 1 KB'ından competition_id ve competition_name oku
function readSrmlHeader(filePath: string): { id: string; name: string; season: string } | null {
  // MED-API-020 fix (2026-05-05): try/finally ile fd close garanti.
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    const read = fs.readSync(fd, buf, 0, 2048, 0);
    const chunk = buf.toString('utf-8', 0, read);
    const m = chunk.match(/competition_id="(\d+)"[^>]*competition_name="([^"]+)"[^>]*season_id="(\d+)"/);
    if (!m) return null;
    return { id: m[1], name: m[2], season: m[3] };
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* best-effort */ }
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

  // 448K dosyayı listelemek yerine bilinen comp ID + yakın sezonlar için doğrudan dene
  const currentYear = new Date().getFullYear();
  const seasons = [String(currentYear + 1), String(currentYear), String(currentYear - 1)];

  const seen    = new Set<string>();
  const results: FixtureCompetition[] = [];

  for (const compId of Object.keys(ALLOWED_COMPETITIONS)) {
    for (const season of seasons) {
      const file = `srml-${compId}-${season}-results.xml`;
      const fullPath = path.join(OPTA_DIR, file);

      if (!fs.existsSync(fullPath)) continue;

      const key = `${compId}-${season}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (!content.includes('Period="PreMatch"')) continue;
      } catch {
        continue;
      }

      results.push({ id: compId, name: ALLOWED_COMPETITIONS[compId], season });
    }
  }

  // F1 takvimi varsa ekle
  const f1Path = path.join(OPTA_DIR, 'F1_CALENDAR_2026.xml');
  if (fs.existsSync(f1Path)) {
    const f1Fixtures = loadF1Fixtures();
    const now = new Date();
    if (f1Fixtures.some((f) => new Date(f.matchDate) >= now)) {
      results.push({ id: 'f1', name: 'Formula 1', season: '2026' });
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  fixtureCompCache = results;
  return results;
}

// ── Belirli bir comp+season için gelecek fikstürleri yükle ───────────────────
export function loadFixtures(compId: string, season: string, afterDate?: Date): OptaFixture[] {
  // F1 özel durumu
  if (compId === 'f1') {
    const fixtures = loadF1Fixtures();
    return afterDate ? fixtures.filter((f) => new Date(f.matchDate) >= afterDate) : fixtures;
  }

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

  // readdirSync yerine glob benzeri yaklaşım: match ID'lerini DB'den bilmiyoruz,
  // bu yüzden sadece matchCache doluysa kullan, yoksa boş dön (f24 maçları DB'den geliyor)
  let files: string[];
  try {
    const prefix = `f24-${competitionId}-${season}-`;
    const suffix = '-eventdetails.xml';
    // Sadece ALLOWED_COMPETITIONS içinse dene, 448K dosya listeleme
    files = fs.readdirSync(OPTA_DIR).filter(
      (f) => f.startsWith(prefix) && f.endsWith(suffix),
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

// ── Formula 1 ─────────────────────────────────────────────────────────────────

let f1FixtureCache: OptaFixture[] | null = null;

function parseF1Date(dateStr: string, startStr: string, utcOffset: number): Date | null {
  // date = "DD.MM.YYYY", start = "HH:MM", utcOffset = local hours ahead of UTC
  const dm = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const tm = startStr.match(/^(\d{2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const [, dd, mm, yyyy] = dm;
  const [, hh, min]      = tm;
  // Local time → UTC: subtract utcOffset
  const localMs = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min));
  return new Date(localMs - utcOffset * 60 * 60 * 1000);
}

function loadF1Fixtures(): OptaFixture[] {
  if (f1FixtureCache) return f1FixtureCache;

  const filePath = path.join(OPTA_DIR, 'F1_CALENDAR_2026.xml');
  f1FixtureCache = [];

  try {
    const xml    = fs.readFileSync(filePath, 'utf-8');
    const parser = new XMLParser({
      ignoreAttributes:    false,
      attributeNamePrefix: '@_',
      isArray: (name) => ['schedule'].includes(name),
    });
    const parsed   = parser.parse(xml);
    const rawSessions = parsed?.block?.schedule ?? [];
    const sessions = Array.isArray(rawSessions) ? rawSessions : [];

    for (const s of sessions) {
      if (typeof s !== 'object' || s === null) continue;
      const item = s as Record<string, unknown>;
      const session   = String(item.session ?? '');
      const eventname = String(item.eventname ?? '');
      const dateStr   = String(item.date ?? '');
      const startStr  = String(item.start ?? '');
      const utcOffset = Number(item.utc ?? 0);
      const gpno      = Number(item.gpno ?? 0);
      const schedId   = String(item['@_id'] ?? '');

      if (!dateStr || !startStr || !session || !eventname) continue;

      // Tamamlanmış session'ları dahil et (filtreleme afterDate ile yapılır)
      const matchDate = parseF1Date(dateStr, startStr, utcOffset);
      if (!matchDate) continue;

      const sessionLabel = F1_SESSION_LABELS[session] ?? session;
      const label = `${eventname} — ${sessionLabel} (${matchDate.getUTCDate().toString().padStart(2,'0')}.${(matchDate.getUTCMonth()+1).toString().padStart(2,'0')}.${matchDate.getUTCFullYear()} ${matchDate.getUTCHours().toString().padStart(2,'0')}:${matchDate.getUTCMinutes().toString().padStart(2,'0')})`;

      f1FixtureCache.push({
        matchId:         `f1-${schedId}`,
        competitionId:   'f1',
        competitionName: 'Formula 1',
        season:          '2026',
        homeTeamName:    eventname,
        awayTeamName:    sessionLabel,
        matchDate:       matchDate.toISOString(),
        weekNumber:      gpno || null,
        label,
      });
    }

    f1FixtureCache.sort((a, b) => a.matchDate.localeCompare(b.matchDate));
  } catch {
    // dosya yoksa boş döner
  }

  return f1FixtureCache;
}

// ── Cache temizle ─────────────────────────────────────────────────────────────
export function clearOptaCache() {
  competitionCache.clear();
  matchCache.clear();
  fixtureCache.clear();
  teamNameCache.clear();
  fixtureCompCache = null;
  f1FixtureCache   = null;
}
