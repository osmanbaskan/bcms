import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

export const OPTA_DIR = process.env.OPTA_DIR
  ?? `/run/user/${process.getuid?.() ?? 1000}/gvfs/smb-share:server=172.26.33.245,share=backups2/OPTA20062025_BCK`;

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

// ── In-memory cache ───────────────────────────────────────────────────────────
const competitionCache = new Map<string, OptaCompetition>();
const matchCache       = new Map<string, OptaMatch[]>(); // key: `${compId}-${season}`

const xmlParser = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: '@_',
  stopNodes:           ['Game'],        // event detaylarını parse etme
});

// ── Dosya adından comp/season/match bilgisi çıkar ─────────────────────────────
// f24-{comp}-{season}-{matchId}-eventdetails.xml
function parseFilename(filename: string): { comp: string; season: string; matchId: string } | null {
  const m = filename.match(/^f24-(\d+)-(\w+)-(\d+)-eventdetails\.xml$/);
  if (!m) return null;
  return { comp: m[1], season: m[2], matchId: m[3] };
}

// ── Tek bir f24 dosyasından <Game> attribute'larını oku ───────────────────────
function readGameAttrs(filePath: string): Record<string, string> | null {
  try {
    // Sadece ilk 1 KB oku — <Game> tag'i buradadır
    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(1024);
    const read = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    const chunk = buf.toString('utf-8', 0, read);

    // <Game ... > bloğunu regex ile çıkar
    const gameMatch = chunk.match(/<Game\s([^>]+)>/s);
    if (!gameMatch) return null;

    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(gameMatch[1])) !== null) {
      attrs[a[1]] = a[2];
    }
    return attrs;
  } catch {
    return null;
  }
}

// ── Dosya sistemini tara, competition listesini oluştur ───────────────────────
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

  // Her benzersiz comp-season için bir örnek dosyadan isim al
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
      // Sezon ekleme
      const entry = competitionCache.get(info.comp);
      if (entry && !entry.seasons.includes(info.season)) {
        entry.seasons.push(info.season);
      }
    }
  }

  return Array.from(competitionCache.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Belirli bir competition + season için maçları yükle ───────────────────────
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

// ── Cache temizle (gerekirse) ─────────────────────────────────────────────────
export function clearOptaCache() {
  competitionCache.clear();
  matchCache.clear();
}
