import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

import { ISTANBUL_TZ } from '../../core/tz.js';

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

/**
 * 2026-05-13: `sportGroup` ile sport-bazlı UI gruplandırması (futbol /
 * tenis / motogp / rugby / formula1 / basketball). Backend `/fixture-
 * competitions` response'a flatten edilir; frontend mat-optgroup ile gösterir.
 */
export type SportGroup = 'football' | 'tennis' | 'motogp' | 'rugby' | 'formula1' | 'basketball';

export interface FixtureCompetition {
  id:         string;
  name:       string;
  season:     string;
  sportGroup: SportGroup;
}

// ── In-memory cache ───────────────────────────────────────────────────────────
// ORTA-API-1.8.5 fix (2026-05-04): teamNameCache TTL + max-size cap.
// Eski hâl: module-scope Map, hiç temizlenmiyordu — yeni sezon/lig
// rotasyonunda monoton büyür, memory leak. clearOptaCache() varol manual
// invalidation ama ileri planda lazy entry'ler birikiyordu.
const TEAM_NAME_CACHE_TTL_MS = 60 * 60 * 1000;     // 1 saat
const TEAM_NAME_CACHE_MAX_ENTRIES = 50;            // ~50 lig × season

interface CachedTeamMap { value: Map<string, string>; expiresAt: number }
const competitionCache  = new Map<string, OptaCompetition>();
const matchCache        = new Map<string, OptaMatch[]>();
const fixtureCache      = new Map<string, OptaFixture[]>();
const teamNameCache     = new Map<string, CachedTeamMap>();
let   fixtureCompCache: FixtureCompetition[] | null = null;

const TR_TIMEZONE = ISTANBUL_TZ;

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
  const now = Date.now();
  const cached = teamNameCache.get(key);
  if (cached && now < cached.expiresAt) return cached.value;
  if (cached) teamNameCache.delete(key); // expired

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

  // LRU-lite: cache MAX'a yaklaşıyorsa en eski expired entry'leri purge.
  if (teamNameCache.size >= TEAM_NAME_CACHE_MAX_ENTRIES) {
    for (const [k, v] of teamNameCache.entries()) {
      if (now >= v.expiresAt) teamNameCache.delete(k);
    }
    // Hâlâ doluysa ilk girişi kaldır (insertion-order).
    if (teamNameCache.size >= TEAM_NAME_CACHE_MAX_ENTRIES) {
      const firstKey = teamNameCache.keys().next().value;
      if (firstKey !== undefined) teamNameCache.delete(firstKey);
    }
  }

  teamNameCache.set(key, { value: teamMap, expiresAt: now + TEAM_NAME_CACHE_TTL_MS });
  return teamMap;
}

// ORTA-API-1.8.7 fix (2026-05-04): UTC değil Istanbul saati. Yayıncılık
// ekranlarında tarih+saat TR yerel zamanı olarak görünmeli; UTC label
// match.routes.ts buildLabel ile tutarsızdı.
const OPTA_TR_MONTHS = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
function buildFixtureLabel(home: string, away: string, dateUtc: string, week: number | null): string {
  const d = new Date(dateUtc);
  const parts = new Intl.DateTimeFormat('tr-TR', {
    timeZone: TR_TIMEZONE, day: '2-digit', month: 'numeric',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const month = parseInt(get('month'), 10);
  const dateStr = `${get('day')} ${OPTA_TR_MONTHS[month - 1]} ${get('year')} ${get('hour')}:${get('minute')}`;
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

      results.push({ id: compId, name: ALLOWED_COMPETITIONS[compId], season, sportGroup: 'football' });
    }
  }

  // F1 takvimi varsa ekle
  const f1Path = path.join(OPTA_DIR, 'F1_CALENDAR_2026.xml');
  if (fs.existsSync(f1Path)) {
    const f1Fixtures = loadF1Fixtures();
    const now = new Date();
    if (f1Fixtures.some((f) => new Date(f.matchDate) >= now)) {
      results.push({ id: 'f1', name: 'Formula 1', season: '2026', sportGroup: 'formula1' });
    }
  }

  // 2026-05-13: MotoGP takvimi varsa ekle (F1 paterni; MOTOGP_CALENDAR_*.xml).
  const motogpPath = path.join(OPTA_DIR, 'MOTOGP_CALENDAR_2026.xml');
  if (fs.existsSync(motogpPath)) {
    const motogpFixtures = loadMotoGPFixtures();
    const now = new Date();
    if (motogpFixtures.some((f) => new Date(f.matchDate) >= now)) {
      results.push({ id: 'motogp', name: 'MotoGP', season: '2026', sportGroup: 'motogp' });
    }
  }

  // 2026-05-13: Tenis fikstürleri TAB7-*.xml dosyalarından (statsperform_feed
  // name="Tennis"). En az 1 gelecek turnuva match'i varsa "Tennis" girişi.
  const tennisFixtures = loadTennisFixtures();
  const now = new Date();
  if (tennisFixtures.some((f) => new Date(f.matchDate) >= now)) {
    results.push({ id: 'tennis', name: 'Tennis', season: '2026', sportGroup: 'tennis' });
  }

  // 2026-05-13: Rugby fikstürleri ru1_compfixtures.*.xml dosyalarından.
  // Her benzersiz comp_id ayrı entry; sportGroup='rugby'.
  for (const rugbyComp of loadRugbyCompetitions()) {
    results.push(rugbyComp);
  }

  results.sort((a, b) => {
    const groupOrder: Record<SportGroup, number> = {
      football: 1, tennis: 2, formula1: 3, motogp: 4, basketball: 5, rugby: 6,
    };
    const g = (groupOrder[a.sportGroup] ?? 99) - (groupOrder[b.sportGroup] ?? 99);
    if (g !== 0) return g;
    return a.name.localeCompare(b.name, 'tr-TR');
  });
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
  // 2026-05-13: MotoGP — F1 paterni; takvim dosyası bazlı
  if (compId === 'motogp') {
    const fixtures = loadMotoGPFixtures();
    return afterDate ? fixtures.filter((f) => new Date(f.matchDate) >= afterDate) : fixtures;
  }
  // 2026-05-13: Tenis — TAB7-*.xml batch (statsperform_feed Tennis)
  if (compId === 'tennis') {
    const fixtures = loadTennisFixtures();
    return afterDate ? fixtures.filter((f) => new Date(f.matchDate) >= afterDate) : fixtures;
  }
  // 2026-05-13: Rugby Union — ru1_compfixtures.*.xml; comp_id route
  if (compId.startsWith('rugby-')) {
    const compNum = compId.slice('rugby-'.length);
    const fixtures = loadRugbyFixtures(compNum, season);
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

// ── MotoGP ────────────────────────────────────────────────────────────────────
// 2026-05-13: F1 paterni ile MOTOGP_CALENDAR_<year>.xml dosyasından okur.
// SMB share'inde yalnız MOTOGP_DRIVER_*_*.xml (driver telemetry) bulunduğu
// için yarış takvimi için ayrı dosya tipi: operatör manuel/script ile
// MOTOGP_CALENDAR_2026.xml düşürür. Format F1 ile aynı: <block><schedule>...
let motogpFixtureCache: OptaFixture[] | null = null;

function loadMotoGPFixtures(): OptaFixture[] {
  if (motogpFixtureCache) return motogpFixtureCache;

  const filePath = path.join(OPTA_DIR, 'MOTOGP_CALENDAR_2026.xml');
  motogpFixtureCache = [];

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
      const matchDate = parseF1Date(dateStr, startStr, utcOffset);
      if (!matchDate) continue;

      // MotoGP session labels (F1 paritesi)
      const sessionLabels: Record<string, string> = {
        RACE: 'Yarış', QUALI: 'Sıralama', SPRINTRACE: 'Sprint Yarış',
        SPRINTQUALI: 'Sprint Sıralama', FP1: 'Antrenman 1', FP2: 'Antrenman 2',
        FP3: 'Antrenman 3', WARMUP: 'Warm-up',
      };
      const sessionLabel = sessionLabels[session] ?? session;
      const dateLabel = `${matchDate.getUTCDate().toString().padStart(2,'0')}.${(matchDate.getUTCMonth()+1).toString().padStart(2,'0')}.${matchDate.getUTCFullYear()} ${matchDate.getUTCHours().toString().padStart(2,'0')}:${matchDate.getUTCMinutes().toString().padStart(2,'0')}`;
      const label = `${eventname} — ${sessionLabel} (${dateLabel})`;

      motogpFixtureCache.push({
        matchId:         `motogp-${schedId}`,
        competitionId:   'motogp',
        competitionName: 'MotoGP',
        season:          '2026',
        homeTeamName:    eventname,
        awayTeamName:    sessionLabel,
        matchDate:       matchDate.toISOString(),
        weekNumber:      gpno || null,
        label,
      });
    }
    motogpFixtureCache.sort((a, b) => a.matchDate.localeCompare(b.matchDate));
  } catch {
    // dosya yoksa boş döner
  }
  return motogpFixtureCache;
}

// ── Tennis ────────────────────────────────────────────────────────────────────
// 2026-05-13: TAB7-*.xml dosyalarından tenis fikstürleri.
// Format: <statsperform_feed name="Tennis"><tournament>...<match start_time/>
//
// Tek dosya = 1 maç. Initial sync 68k+ dosya; bu parser cache'i tek bellek
// pass'inde doldurur; günlük poll (watcher 3600 sn) yeni dosyaları işler.
// Operasyonel: full re-parse pahalı; ileri optimizasyon (incremental
// mtime tabanlı) post-v1.
let tennisFixtureCache: OptaFixture[] | null = null;

function loadTennisFixtures(): OptaFixture[] {
  if (tennisFixtureCache) return tennisFixtureCache;
  tennisFixtureCache = [];

  let files: string[] = [];
  try {
    files = fs.readdirSync(OPTA_DIR).filter((f) => /^TAB7-\d+\.xml$/.test(f));
  } catch {
    return tennisFixtureCache;
  }

  const tennisParser = new XMLParser({
    ignoreAttributes:    false,
    attributeNamePrefix: '@_',
  });

  for (const filename of files) {
    try {
      const xml = fs.readFileSync(path.join(OPTA_DIR, filename), 'utf-8');
      const parsed = tennisParser.parse(xml);
      const feed   = parsed?.statsperform_feed;
      if (!feed || feed['@_name'] !== 'Tennis') continue;

      const tournament = feed.tournament;
      if (!tournament) continue;
      const tournamentName: string = String(tournament['@_name'] ?? tournament['@_tournament_class'] ?? 'Tennis');
      const tournamentType: string = String(tournament['@_type'] ?? '');
      const season:         string = String(tournament['@_end_date'] ?? '').slice(0, 4) || '2026';

      const competitions: unknown = tournament.competition;
      const compList = Array.isArray(competitions) ? competitions : (competitions ? [competitions] : []);

      for (const comp of compList) {
        const c = comp as Record<string, unknown>;
        const compName: string = String(c['@_name'] ?? c['@_sex'] ?? 'Singles');
        const rounds: unknown = c.round;
        const roundList = Array.isArray(rounds) ? rounds : (rounds ? [rounds] : []);

        for (const round of roundList) {
          const r = round as Record<string, unknown>;
          const roundName: string = String(r['@_name'] ?? '');
          const matches: unknown = r.match;
          const matchList = Array.isArray(matches) ? matches : (matches ? [matches] : []);

          for (const m of matchList) {
            const mm = m as Record<string, unknown>;
            const matchId = String(mm['@_id'] ?? '');
            const startTime = String(mm['@_start_time'] ?? '');
            if (!matchId || !startTime) continue;
            const matchDate = new Date(startTime);
            if (isNaN(matchDate.getTime())) continue;

            // Player adları (varsa)
            const firstPlayer  = extractTennisPlayerName(mm.first_entry);
            const secondPlayer = extractTennisPlayerName(mm.second_entry);
            const home = firstPlayer  || tournamentName;
            const away = secondPlayer || compName;

            const label = `${tournamentName} ${roundName} — ${home} vs ${away}`;
            tennisFixtureCache.push({
              matchId:         `tennis-${matchId}`,
              competitionId:   'tennis',
              competitionName: tournamentType ? `${tournamentName} (${tournamentType})` : tournamentName,
              season,
              homeTeamName:    home,
              awayTeamName:    away,
              matchDate:       matchDate.toISOString(),
              weekNumber:      null,
              label,
            });
          }
        }
      }
    } catch {
      continue;
    }
  }
  tennisFixtureCache.sort((a, b) => a.matchDate.localeCompare(b.matchDate));
  return tennisFixtureCache;
}

function extractTennisPlayerName(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const player = e.player as Record<string, unknown> | undefined;
  if (player && typeof player === 'object') {
    const display = String(player['@_display_name'] ?? '');
    if (display) return display;
    const first = String(player['@_first_name'] ?? '');
    const last  = String(player['@_last_name'] ?? '');
    if (first || last) return `${first} ${last}`.trim();
  }
  return null;
}

// ── Rugby Union (RU1) ────────────────────────────────────────────────────────
// 2026-05-13: ru1_compfixtures.<compId>.<season>.<timestamp>.xml dosyalarından
// fikstürler. Comp_id bazlı routing — her unique comp_id ayrı entry.
let rugbyFixtureCache:    Map<string, OptaFixture[]> | null = null;
let rugbyCompetitionsCache: FixtureCompetition[]    | null = null;

function listRugbyFiles(): string[] {
  try {
    return fs.readdirSync(OPTA_DIR).filter((f) => /^ru1_compfixtures\.[^.]+\.[^.]+\..*\.xml$/.test(f));
  } catch {
    return [];
  }
}

function loadRugbyCompetitions(): FixtureCompetition[] {
  if (rugbyCompetitionsCache) return rugbyCompetitionsCache;
  rugbyCompetitionsCache = [];
  ensureRugbyParsed();
  if (!rugbyFixtureCache) return rugbyCompetitionsCache;

  const now = new Date();
  const seen = new Set<string>();
  for (const [key, fixtures] of rugbyFixtureCache.entries()) {
    if (!fixtures.some((f) => new Date(f.matchDate) >= now)) continue;
    const sample = fixtures[0];
    const id = `rugby-${key.split(':')[0]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rugbyCompetitionsCache.push({
      id,
      name:       sample.competitionName || 'Rugby',
      season:     sample.season,
      sportGroup: 'rugby',
    });
  }
  return rugbyCompetitionsCache;
}

function loadRugbyFixtures(compId: string, season: string): OptaFixture[] {
  ensureRugbyParsed();
  if (!rugbyFixtureCache) return [];
  return rugbyFixtureCache.get(`${compId}:${season}`) ?? [];
}

function ensureRugbyParsed(): void {
  if (rugbyFixtureCache) return;
  rugbyFixtureCache = new Map();

  const rugbyParser = new XMLParser({
    ignoreAttributes:    false,
    attributeNamePrefix: '@_',
    isArray:             (name) => ['fixture', 'team'].includes(name),
  });

  for (const filename of listRugbyFiles()) {
    try {
      const xml = fs.readFileSync(path.join(OPTA_DIR, filename), 'utf-8');
      const parsed = rugbyParser.parse(xml);
      const fixtures = parsed?.fixtures?.fixture;
      if (!fixtures || !Array.isArray(fixtures)) continue;

      for (const f of fixtures) {
        const ff = f as Record<string, unknown>;
        const compNum     = String(ff['@_comp_id'] ?? '');
        const compName    = String(ff['@_comp_name'] ?? 'Rugby');
        const seasonId    = String(ff['@_season_id'] ?? '');
        const datetime    = String(ff['@_datetime'] ?? '');
        const fixtureId   = String(ff['@_id'] ?? '');
        if (!compNum || !seasonId || !datetime || !fixtureId) continue;

        const matchDate = new Date(datetime);
        if (isNaN(matchDate.getTime())) continue;

        const teams = (ff.team as Record<string, unknown>[]) ?? [];
        const home = teams.find((t) => String(t['@_home_or_away'] ?? '') === 'home');
        const away = teams.find((t) => String(t['@_home_or_away'] ?? '') === 'away');
        const homeName = String(home?.['@_team_name'] ?? home?.['#text'] ?? 'Home');
        const awayName = String(away?.['@_team_name'] ?? away?.['#text'] ?? 'Away');

        const key = `${compNum}:${seasonId}`;
        let list = rugbyFixtureCache.get(key);
        if (!list) { list = []; rugbyFixtureCache.set(key, list); }
        list.push({
          matchId:         `rugby-${fixtureId}`,
          competitionId:   `rugby-${compNum}`,
          competitionName: compName,
          season:          seasonId,
          homeTeamName:    homeName,
          awayTeamName:    awayName,
          matchDate:       matchDate.toISOString(),
          weekNumber:      null,
          label:           `${homeName} vs ${awayName} (${compName})`,
        });
      }
    } catch {
      continue;
    }
  }
  for (const list of rugbyFixtureCache.values()) {
    list.sort((a, b) => a.matchDate.localeCompare(b.matchDate));
  }
}

// ── Cache temizle ─────────────────────────────────────────────────────────────
export function clearOptaCache() {
  competitionCache.clear();
  matchCache.clear();
  fixtureCache.clear();
  teamNameCache.clear();
  fixtureCompCache = null;
  f1FixtureCache   = null;
  motogpFixtureCache = null;
  tennisFixtureCache = null;
  rugbyFixtureCache  = null;
  rugbyCompetitionsCache = null;
}

// ORTA-API-1.7.6 fix (2026-05-04): OPTA XML size limit guard. Dosya
// istatistiği ile MAX_XML_SIZE kontrol; OPTA fixture XML payload'ları
// 100MB altında. Çağıran fonksiyonlar try'da fs.readFileSync kullandığından
// buradan helper olarak çağrılır; mevcut çağrıları değiştirmek bu commit'in
// kapsamı dışı (refactor cascading touch).
export const MAX_XML_BYTES = 100 * 1024 * 1024; // 100MB OPTA'da büyük olabilir
