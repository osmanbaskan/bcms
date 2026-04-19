import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── Helper ────────────────────────────────────────────────────────────────────
function dt(dateStr: string): Date {
  return new Date(dateStr);
}

async function main() {
  console.log('Seeding database...');

  // ── Broadcast types ──────────────────────────────────────────────────────────
  await prisma.broadcastType.createMany({
    data: [
      { code: 'LIVE',     description: 'Canlı yayın' },
      { code: 'DEFERRED', description: 'Banttan yayın' },
      { code: 'RERUN',    description: 'Tekrar yayın' },
      { code: 'NEWS',     description: 'Haber bülteni' },
    ],
    skipDuplicates: true,
  });

  // ── Channels ─────────────────────────────────────────────────────────────────
  await prisma.channel.createMany({
    data: [
      { name: 'beIN Sports 1',     type: 'HD',  frequency: 'DVB-S2 12380 V' },
      { name: 'beIN Sports 2',     type: 'HD',  frequency: 'DVB-S2 12380 V' },
      { name: 'beIN Sports 3',     type: 'HD',  frequency: 'DVB-S2 12380 V' },
      { name: 'beIN Sports 4',     type: 'HD',  frequency: 'DVB-S2 12380 V' },
      { name: 'beIN Sports 5',     type: 'HD',  frequency: 'DVB-S2 12380 V' },
      { name: 'beIN Sports Max 1', type: 'HD',  frequency: 'DVB-S2 12522 H' },
      { name: 'beIN Sports Max 2', type: 'HD',  frequency: 'DVB-S2 12522 H' },
      { name: 'beIN Haber',        type: 'HD',  frequency: 'DVB-S2 12522 H' },
      { name: 'beIN Digital 1',    type: 'OTT' },
      { name: 'beIN Digital 2',    type: 'OTT' },
      { name: 'beIN Digital 3',    type: 'OTT' },
      { name: 'beIN Digital 4',    type: 'OTT' },
    ],
    skipDuplicates: true,
  });

  // ── Leagues ──────────────────────────────────────────────────────────────────
  const leagueSuperLig = await prisma.league.upsert({
    where:  { code: 'SUPERLIG' },
    update: {},
    create: { code: 'SUPERLIG', name: 'Trendyol Süper Lig', country: 'Türkiye' },
  });

  const leaguePremier = await prisma.league.upsert({
    where:  { code: 'PREM' },
    update: {},
    create: { code: 'PREM', name: 'İngiltere Premier Lig', country: 'İngiltere' },
  });

  const leagueLig1 = await prisma.league.upsert({
    where:  { code: 'LIG1' },
    update: {},
    create: { code: 'LIG1', name: 'Fransa Ligue 1', country: 'Fransa' },
  });

  const leagueBSL = await prisma.league.upsert({
    where:  { code: 'BSL' },
    update: {},
    create: { code: 'BSL', name: 'Türkiye Basketbol Süper Ligi', country: 'Türkiye' },
  });

  // ── Teams ────────────────────────────────────────────────────────────────────
  // Süper Lig takımları
  await prisma.team.createMany({
    data: [
      { leagueId: leagueSuperLig.id, name: 'Galatasaray',        shortName: 'GS'  },
      { leagueId: leagueSuperLig.id, name: 'Fenerbahçe',         shortName: 'FB'  },
      { leagueId: leagueSuperLig.id, name: 'Beşiktaş',           shortName: 'BJK' },
      { leagueId: leagueSuperLig.id, name: 'Trabzonspor',        shortName: 'TS'  },
      { leagueId: leagueSuperLig.id, name: 'Başakşehir',         shortName: 'IBB' },
      { leagueId: leagueSuperLig.id, name: 'Sivasspor',          shortName: 'SİV' },
      { leagueId: leagueSuperLig.id, name: 'Konyaspor',          shortName: 'KON' },
      { leagueId: leagueSuperLig.id, name: 'Kasımpaşa',          shortName: 'KAS' },
      { leagueId: leagueSuperLig.id, name: 'Antalyaspor',        shortName: 'ANT' },
      { leagueId: leagueSuperLig.id, name: 'Kayserispor',        shortName: 'KAY' },
      { leagueId: leagueSuperLig.id, name: 'Gaziantep FK',       shortName: 'GFK' },
      { leagueId: leagueSuperLig.id, name: 'Alanyaspor',         shortName: 'ALN' },
      { leagueId: leagueSuperLig.id, name: 'Adana Demirspor',    shortName: 'ADS' },
      { leagueId: leagueSuperLig.id, name: 'Hatayspor',          shortName: 'HTY' },
      { leagueId: leagueSuperLig.id, name: 'Eyüpspor',           shortName: 'EYP' },
      { leagueId: leagueSuperLig.id, name: 'Rizespor',           shortName: 'RİZ' },
      { leagueId: leagueSuperLig.id, name: 'Samsunspor',         shortName: 'SAM' },
      { leagueId: leagueSuperLig.id, name: 'Bodrum FK',          shortName: 'BDR' },
      { leagueId: leagueSuperLig.id, name: 'Göztepe',            shortName: 'GZT' },
    ],
    skipDuplicates: true,
  });

  // Premier Lig takımları
  await prisma.team.createMany({
    data: [
      { leagueId: leaguePremier.id, name: 'Arsenal',           shortName: 'ARS' },
      { leagueId: leaguePremier.id, name: 'Manchester City',   shortName: 'MCI' },
      { leagueId: leaguePremier.id, name: 'Liverpool',         shortName: 'LIV' },
      { leagueId: leaguePremier.id, name: 'Chelsea',           shortName: 'CHE' },
      { leagueId: leaguePremier.id, name: 'Manchester United', shortName: 'MUN' },
      { leagueId: leaguePremier.id, name: 'Tottenham',         shortName: 'TOT' },
      { leagueId: leaguePremier.id, name: 'Newcastle United',  shortName: 'NEW' },
      { leagueId: leaguePremier.id, name: 'Aston Villa',       shortName: 'AVL' },
      { leagueId: leaguePremier.id, name: 'Brighton',          shortName: 'BHA' },
      { leagueId: leaguePremier.id, name: 'West Ham',          shortName: 'WHU' },
      { leagueId: leaguePremier.id, name: 'Everton',           shortName: 'EVE' },
      { leagueId: leaguePremier.id, name: 'Crystal Palace',    shortName: 'CRY' },
      { leagueId: leaguePremier.id, name: 'Fulham',            shortName: 'FUL' },
      { leagueId: leaguePremier.id, name: 'Wolves',            shortName: 'WOL' },
      { leagueId: leaguePremier.id, name: 'Nottm Forest',      shortName: 'NFO' },
      { leagueId: leaguePremier.id, name: 'Brentford',         shortName: 'BRE' },
      { leagueId: leaguePremier.id, name: 'Leicester City',    shortName: 'LEI' },
      { leagueId: leaguePremier.id, name: 'Ipswich Town',      shortName: 'IPS' },
      { leagueId: leaguePremier.id, name: 'Southampton',       shortName: 'SOU' },
      { leagueId: leaguePremier.id, name: 'Bournemouth',       shortName: 'BOU' },
    ],
    skipDuplicates: true,
  });

  // Ligue 1 takımları
  await prisma.team.createMany({
    data: [
      { leagueId: leagueLig1.id, name: 'PSG',             shortName: 'PSG' },
      { leagueId: leagueLig1.id, name: 'Monaco',          shortName: 'MON' },
      { leagueId: leagueLig1.id, name: 'Marseille',       shortName: 'OM'  },
      { leagueId: leagueLig1.id, name: 'Nice',            shortName: 'NIC' },
      { leagueId: leagueLig1.id, name: 'Lyon',            shortName: 'OL'  },
      { leagueId: leagueLig1.id, name: 'Lens',            shortName: 'RCL' },
      { leagueId: leagueLig1.id, name: 'Rennes',          shortName: 'REN' },
      { leagueId: leagueLig1.id, name: 'Strasbourg',      shortName: 'STR' },
      { leagueId: leagueLig1.id, name: 'Toulouse',        shortName: 'TOU' },
      { leagueId: leagueLig1.id, name: 'Reims',           shortName: 'REI' },
      { leagueId: leagueLig1.id, name: 'Nantes',          shortName: 'FCN' },
      { leagueId: leagueLig1.id, name: 'Le Havre',        shortName: 'HAC' },
      { leagueId: leagueLig1.id, name: 'Montpellier',     shortName: 'MHC' },
      { leagueId: leagueLig1.id, name: 'Saint-Étienne',   shortName: 'ASS' },
      { leagueId: leagueLig1.id, name: 'Auxerre',         shortName: 'AJA' },
      { leagueId: leagueLig1.id, name: 'Brest',           shortName: 'SB29'},
      { leagueId: leagueLig1.id, name: 'Angers',          shortName: 'SCO' },
      { leagueId: leagueLig1.id, name: 'Metz',            shortName: 'FCM' },
    ],
    skipDuplicates: true,
  });

  // BSL takımları
  await prisma.team.createMany({
    data: [
      { leagueId: leagueBSL.id, name: 'Anadolu Efes',        shortName: 'EFS' },
      { leagueId: leagueBSL.id, name: 'Fenerbahçe Beko',     shortName: 'FBK' },
      { leagueId: leagueBSL.id, name: 'Galatasaray Nef',     shortName: 'GNF' },
      { leagueId: leagueBSL.id, name: 'Beşiktaş',            shortName: 'BJB' },
      { leagueId: leagueBSL.id, name: 'Türk Telekom',        shortName: 'TTB' },
      { leagueId: leagueBSL.id, name: 'Tofaş',               shortName: 'TOF' },
      { leagueId: leagueBSL.id, name: 'Pınar Karşıyaka',     shortName: 'PKY' },
      { leagueId: leagueBSL.id, name: 'Bahçeşehir Koleji',   shortName: 'BHC' },
      { leagueId: leagueBSL.id, name: 'Büyükçekmece',        shortName: 'BYK' },
      { leagueId: leagueBSL.id, name: 'Onvo Büyükşehir B.K', shortName: 'OBB' },
      { leagueId: leagueBSL.id, name: 'Merkezefendi',        shortName: 'MRK' },
      { leagueId: leagueBSL.id, name: 'Aliağa Petkimspor',   shortName: 'APK' },
    ],
    skipDuplicates: true,
  });

  // ── Fixtures ─────────────────────────────────────────────────────────────────
  // Trendyol Süper Lig 2025-26 — Kalan Haftalar (29-36)
  await prisma.match.createMany({
    data: [
      // Hafta 29 (18-20 Nisan 2026)
      { leagueId: leagueSuperLig.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Galatasaray',     awayTeamName: 'Trabzonspor',    matchDate: dt('2026-04-18T19:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Fenerbahçe',      awayTeamName: 'Konyaspor',      matchDate: dt('2026-04-18T20:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Beşiktaş',        awayTeamName: 'Sivasspor',      matchDate: dt('2026-04-19T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Başakşehir',      awayTeamName: 'Antalyaspor',    matchDate: dt('2026-04-19T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Kasımpaşa',       awayTeamName: 'Kayserispor',    matchDate: dt('2026-04-19T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Alanyaspor',      awayTeamName: 'Rizespor',       matchDate: dt('2026-04-19T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Adana Demirspor', awayTeamName: 'Hatayspor',      matchDate: dt('2026-04-20T14:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Samsunspor',      awayTeamName: 'Eyüpspor',       matchDate: dt('2026-04-20T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Gaziantep FK',    awayTeamName: 'Göztepe',        matchDate: dt('2026-04-20T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Bodrum FK',       awayTeamName: 'Fenerbahçe',     matchDate: dt('2026-04-20T20:00:00+03:00') },

      // Hafta 30 (25-27 Nisan 2026)
      { leagueId: leagueSuperLig.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Trabzonspor',     awayTeamName: 'Beşiktaş',       matchDate: dt('2026-04-25T19:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Konyaspor',       awayTeamName: 'Galatasaray',    matchDate: dt('2026-04-25T20:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Sivasspor',       awayTeamName: 'Başakşehir',     matchDate: dt('2026-04-26T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Antalyaspor',     awayTeamName: 'Adana Demirspor',matchDate: dt('2026-04-26T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Kayserispor',     awayTeamName: 'Samsunspor',     matchDate: dt('2026-04-26T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Rizespor',        awayTeamName: 'Kasımpaşa',      matchDate: dt('2026-04-26T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Hatayspor',       awayTeamName: 'Alanyaspor',     matchDate: dt('2026-04-27T14:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Eyüpspor',        awayTeamName: 'Gaziantep FK',   matchDate: dt('2026-04-27T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Göztepe',         awayTeamName: 'Bodrum FK',      matchDate: dt('2026-04-27T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Fenerbahçe',      awayTeamName: 'Hatayspor',      matchDate: dt('2026-04-27T20:00:00+03:00') },

      // Hafta 31 (2-4 Mayıs 2026)
      { leagueId: leagueSuperLig.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Galatasaray',     awayTeamName: 'Beşiktaş',       matchDate: dt('2026-05-02T20:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Trabzonspor',     awayTeamName: 'Fenerbahçe',     matchDate: dt('2026-05-02T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Başakşehir',      awayTeamName: 'Kayserispor',    matchDate: dt('2026-05-03T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Kasımpaşa',       awayTeamName: 'Sivasspor',      matchDate: dt('2026-05-03T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Alanyaspor',      awayTeamName: 'Adana Demirspor',matchDate: dt('2026-05-03T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Samsunspor',      awayTeamName: 'Antalyaspor',    matchDate: dt('2026-05-04T14:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Bodrum FK',       awayTeamName: 'Rizespor',       matchDate: dt('2026-05-04T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Gaziantep FK',    awayTeamName: 'Konyaspor',      matchDate: dt('2026-05-04T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Eyüpspor',        awayTeamName: 'Hatayspor',      matchDate: dt('2026-05-04T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Göztepe',         awayTeamName: 'Fenerbahçe',     matchDate: dt('2026-05-04T20:00:00+03:00') },

      // Hafta 32 (9-11 Mayıs 2026)
      { leagueId: leagueSuperLig.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Fenerbahçe',      awayTeamName: 'Galatasaray',    matchDate: dt('2026-05-09T20:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Beşiktaş',        awayTeamName: 'Trabzonspor',    matchDate: dt('2026-05-09T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Sivasspor',       awayTeamName: 'Alanyaspor',     matchDate: dt('2026-05-10T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Kayserispor',     awayTeamName: 'Kasımpaşa',      matchDate: dt('2026-05-10T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Konyaspor',       awayTeamName: 'Eyüpspor',       matchDate: dt('2026-05-10T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Antalyaspor',     awayTeamName: 'Başakşehir',     matchDate: dt('2026-05-11T14:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Hatayspor',       awayTeamName: 'Samsunspor',     matchDate: dt('2026-05-11T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Adana Demirspor', awayTeamName: 'Bodrum FK',      matchDate: dt('2026-05-11T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Rizespor',        awayTeamName: 'Gaziantep FK',   matchDate: dt('2026-05-11T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Göztepe',         awayTeamName: 'Beşiktaş',       matchDate: dt('2026-05-11T20:00:00+03:00') },

      // Hafta 33 (16-18 Mayıs 2026)
      { leagueId: leagueSuperLig.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Galatasaray',     awayTeamName: 'Kayserispor',    matchDate: dt('2026-05-16T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Fenerbahçe',      awayTeamName: 'Beşiktaş',       matchDate: dt('2026-05-16T20:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Trabzonspor',     awayTeamName: 'Konyaspor',      matchDate: dt('2026-05-17T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Başakşehir',      awayTeamName: 'Göztepe',        matchDate: dt('2026-05-17T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Kasımpaşa',       awayTeamName: 'Adana Demirspor',matchDate: dt('2026-05-17T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Alanyaspor',      awayTeamName: 'Eyüpspor',       matchDate: dt('2026-05-18T14:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Samsunspor',      awayTeamName: 'Rizespor',       matchDate: dt('2026-05-18T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Antalyaspor',     awayTeamName: 'Sivasspor',      matchDate: dt('2026-05-18T16:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Bodrum FK',       awayTeamName: 'Hatayspor',      matchDate: dt('2026-05-18T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Gaziantep FK',    awayTeamName: 'Başakşehir',     matchDate: dt('2026-05-18T20:00:00+03:00') },

      // Hafta 34 — Son Hafta (24 Mayıs 2026, eşzamanlı)
      { leagueId: leagueSuperLig.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Beşiktaş',        awayTeamName: 'Galatasaray',    matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Trabzonspor',     awayTeamName: 'Fenerbahçe',     matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Konyaspor',       awayTeamName: 'Başakşehir',     matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Sivasspor',       awayTeamName: 'Samsunspor',     matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Eyüpspor',        awayTeamName: 'Bodrum FK',      matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Kayserispor',     awayTeamName: 'Alanyaspor',     matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Kasımpaşa',       awayTeamName: 'Antalyaspor',    matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Adana Demirspor', awayTeamName: 'Rizespor',       matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Hatayspor',       awayTeamName: 'Göztepe',        matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leagueSuperLig.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Gaziantep FK',    awayTeamName: 'Kasımpaşa',      matchDate: dt('2026-05-24T18:00:00+03:00') },
    ],
    skipDuplicates: true,
  });

  // Premier Lig 2025-26 — Kalan Haftalar (32-38)
  await prisma.match.createMany({
    data: [
      // Hafta 32 (19-20 Nisan 2026)
      { leagueId: leaguePremier.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Arsenal',           awayTeamName: 'Chelsea',          matchDate: dt('2026-04-19T19:30:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Manchester City',   awayTeamName: 'Liverpool',         matchDate: dt('2026-04-19T18:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Tottenham',         awayTeamName: 'Manchester United', matchDate: dt('2026-04-19T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Newcastle United',  awayTeamName: 'Aston Villa',       matchDate: dt('2026-04-19T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Brighton',          awayTeamName: 'Wolves',            matchDate: dt('2026-04-20T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 32, season: '2025-26', homeTeamName: 'West Ham',          awayTeamName: 'Nottm Forest',      matchDate: dt('2026-04-20T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Everton',           awayTeamName: 'Brentford',         matchDate: dt('2026-04-20T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Fulham',            awayTeamName: 'Leicester City',    matchDate: dt('2026-04-20T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Crystal Palace',    awayTeamName: 'Ipswich Town',      matchDate: dt('2026-04-20T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Bournemouth',       awayTeamName: 'Southampton',       matchDate: dt('2026-04-20T16:00:00+03:00') },

      // Hafta 33 (25-26 Nisan 2026)
      { leagueId: leaguePremier.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Liverpool',         awayTeamName: 'Arsenal',           matchDate: dt('2026-04-25T19:30:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Chelsea',           awayTeamName: 'Manchester City',   matchDate: dt('2026-04-25T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Manchester United', awayTeamName: 'Newcastle United',  matchDate: dt('2026-04-25T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Aston Villa',       awayTeamName: 'Tottenham',         matchDate: dt('2026-04-26T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Wolves',            awayTeamName: 'Brighton',          matchDate: dt('2026-04-26T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Nottm Forest',      awayTeamName: 'Everton',           matchDate: dt('2026-04-26T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Brentford',         awayTeamName: 'Crystal Palace',    matchDate: dt('2026-04-26T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Leicester City',    awayTeamName: 'West Ham',          matchDate: dt('2026-04-26T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Ipswich Town',      awayTeamName: 'Fulham',            matchDate: dt('2026-04-26T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Southampton',       awayTeamName: 'Bournemouth',       matchDate: dt('2026-04-26T16:00:00+03:00') },

      // Hafta 34 (2-3 Mayıs 2026)
      { leagueId: leaguePremier.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Arsenal',           awayTeamName: 'Manchester United', matchDate: dt('2026-05-02T19:30:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Manchester City',   awayTeamName: 'Tottenham',         matchDate: dt('2026-05-02T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Newcastle United',  awayTeamName: 'Liverpool',         matchDate: dt('2026-05-02T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Chelsea',           awayTeamName: 'West Ham',          matchDate: dt('2026-05-03T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Aston Villa',       awayTeamName: 'Brighton',          matchDate: dt('2026-05-03T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Everton',           awayTeamName: 'Wolves',            matchDate: dt('2026-05-03T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Nottm Forest',      awayTeamName: 'Leicester City',    matchDate: dt('2026-05-03T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Fulham',            awayTeamName: 'Brentford',         matchDate: dt('2026-05-03T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Crystal Palace',    awayTeamName: 'Southampton',       matchDate: dt('2026-05-03T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Bournemouth',       awayTeamName: 'Ipswich Town',      matchDate: dt('2026-05-03T16:00:00+03:00') },

      // Hafta 35 (9-10 Mayıs 2026)
      { leagueId: leaguePremier.id, weekNumber: 35, season: '2025-26', homeTeamName: 'Liverpool',         awayTeamName: 'Chelsea',           matchDate: dt('2026-05-09T19:30:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 35, season: '2025-26', homeTeamName: 'Manchester United', awayTeamName: 'Manchester City',   matchDate: dt('2026-05-09T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 35, season: '2025-26', homeTeamName: 'Tottenham',         awayTeamName: 'Arsenal',           matchDate: dt('2026-05-09T18:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 35, season: '2025-26', homeTeamName: 'Brighton',          awayTeamName: 'Newcastle United',  matchDate: dt('2026-05-10T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 35, season: '2025-26', homeTeamName: 'West Ham',          awayTeamName: 'Aston Villa',       matchDate: dt('2026-05-10T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 35, season: '2025-26', homeTeamName: 'Wolves',            awayTeamName: 'Nottm Forest',      matchDate: dt('2026-05-10T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 35, season: '2025-26', homeTeamName: 'Leicester City',    awayTeamName: 'Everton',           matchDate: dt('2026-05-10T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 35, season: '2025-26', homeTeamName: 'Brentford',         awayTeamName: 'Fulham',            matchDate: dt('2026-05-10T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 35, season: '2025-26', homeTeamName: 'Ipswich Town',      awayTeamName: 'Crystal Palace',    matchDate: dt('2026-05-10T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 35, season: '2025-26', homeTeamName: 'Southampton',       awayTeamName: 'Bournemouth',       matchDate: dt('2026-05-10T16:00:00+03:00') },

      // Hafta 36 (16-17 Mayıs 2026)
      { leagueId: leaguePremier.id, weekNumber: 36, season: '2025-26', homeTeamName: 'Arsenal',           awayTeamName: 'Liverpool',         matchDate: dt('2026-05-16T19:30:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 36, season: '2025-26', homeTeamName: 'Chelsea',           awayTeamName: 'Tottenham',         matchDate: dt('2026-05-16T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 36, season: '2025-26', homeTeamName: 'Manchester City',   awayTeamName: 'Brighton',          matchDate: dt('2026-05-17T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 36, season: '2025-26', homeTeamName: 'Newcastle United',  awayTeamName: 'Manchester United', matchDate: dt('2026-05-17T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 36, season: '2025-26', homeTeamName: 'Aston Villa',       awayTeamName: 'Chelsea',           matchDate: dt('2026-05-17T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 36, season: '2025-26', homeTeamName: 'Everton',           awayTeamName: 'West Ham',          matchDate: dt('2026-05-17T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 36, season: '2025-26', homeTeamName: 'Nottm Forest',      awayTeamName: 'Brentford',         matchDate: dt('2026-05-17T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 36, season: '2025-26', homeTeamName: 'Fulham',            awayTeamName: 'Wolves',            matchDate: dt('2026-05-17T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 36, season: '2025-26', homeTeamName: 'Crystal Palace',    awayTeamName: 'Leicester City',    matchDate: dt('2026-05-17T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 36, season: '2025-26', homeTeamName: 'Bournemouth',       awayTeamName: 'Ipswich Town',      matchDate: dt('2026-05-17T16:00:00+03:00') },

      // Hafta 37 (23-24 Mayıs 2026)
      { leagueId: leaguePremier.id, weekNumber: 37, season: '2025-26', homeTeamName: 'Liverpool',         awayTeamName: 'Manchester City',   matchDate: dt('2026-05-23T19:30:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 37, season: '2025-26', homeTeamName: 'Tottenham',         awayTeamName: 'Newcastle United',  matchDate: dt('2026-05-23T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 37, season: '2025-26', homeTeamName: 'Manchester United', awayTeamName: 'Arsenal',           matchDate: dt('2026-05-23T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 37, season: '2025-26', homeTeamName: 'Brighton',          awayTeamName: 'Everton',           matchDate: dt('2026-05-24T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 37, season: '2025-26', homeTeamName: 'Wolves',            awayTeamName: 'Crystal Palace',    matchDate: dt('2026-05-24T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 37, season: '2025-26', homeTeamName: 'Brentford',         awayTeamName: 'West Ham',          matchDate: dt('2026-05-24T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 37, season: '2025-26', homeTeamName: 'Leicester City',    awayTeamName: 'Nottm Forest',      matchDate: dt('2026-05-24T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 37, season: '2025-26', homeTeamName: 'Ipswich Town',      awayTeamName: 'Southampton',       matchDate: dt('2026-05-24T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 37, season: '2025-26', homeTeamName: 'Aston Villa',       awayTeamName: 'Fulham',            matchDate: dt('2026-05-24T16:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 37, season: '2025-26', homeTeamName: 'Bournemouth',       awayTeamName: 'Chelsea',           matchDate: dt('2026-05-24T16:00:00+03:00') },

      // Hafta 38 — Son Hafta (24 Mayıs 2026, eşzamanlı)
      { leagueId: leaguePremier.id, weekNumber: 38, season: '2025-26', homeTeamName: 'Manchester City',   awayTeamName: 'Arsenal',           matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 38, season: '2025-26', homeTeamName: 'Liverpool',         awayTeamName: 'Tottenham',         matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 38, season: '2025-26', homeTeamName: 'Chelsea',           awayTeamName: 'Manchester United', matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 38, season: '2025-26', homeTeamName: 'Newcastle United',  awayTeamName: 'Everton',           matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 38, season: '2025-26', homeTeamName: 'Aston Villa',       awayTeamName: 'Leicester City',    matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 38, season: '2025-26', homeTeamName: 'Brighton',          awayTeamName: 'West Ham',          matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 38, season: '2025-26', homeTeamName: 'Wolves',            awayTeamName: 'Brentford',         matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 38, season: '2025-26', homeTeamName: 'Nottm Forest',      awayTeamName: 'Crystal Palace',    matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 38, season: '2025-26', homeTeamName: 'Fulham',            awayTeamName: 'Southampton',       matchDate: dt('2026-05-24T18:00:00+03:00') },
      { leagueId: leaguePremier.id, weekNumber: 38, season: '2025-26', homeTeamName: 'Ipswich Town',      awayTeamName: 'Bournemouth',       matchDate: dt('2026-05-24T18:00:00+03:00') },
    ],
    skipDuplicates: true,
  });

  // Fransa Ligue 1 2025-26 — Kalan Haftalar (29-34)
  await prisma.match.createMany({
    data: [
      // Hafta 29 (18-19 Nisan 2026)
      { leagueId: leagueLig1.id, weekNumber: 29, season: '2025-26', homeTeamName: 'PSG',           awayTeamName: 'Monaco',        matchDate: dt('2026-04-18T22:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Marseille',     awayTeamName: 'Nice',          matchDate: dt('2026-04-18T20:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Lyon',          awayTeamName: 'Rennes',        matchDate: dt('2026-04-19T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Lens',          awayTeamName: 'Strasbourg',    matchDate: dt('2026-04-19T20:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Toulouse',      awayTeamName: 'Reims',         matchDate: dt('2026-04-19T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Nantes',        awayTeamName: 'Le Havre',      matchDate: dt('2026-04-19T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Montpellier',   awayTeamName: 'Saint-Étienne', matchDate: dt('2026-04-19T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Auxerre',       awayTeamName: 'Brest',         matchDate: dt('2026-04-19T20:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 29, season: '2025-26', homeTeamName: 'Angers',        awayTeamName: 'Metz',          matchDate: dt('2026-04-19T18:00:00+03:00') },

      // Hafta 30 (25-26 Nisan 2026)
      { leagueId: leagueLig1.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Monaco',        awayTeamName: 'Marseille',     matchDate: dt('2026-04-25T22:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Nice',          awayTeamName: 'PSG',           matchDate: dt('2026-04-25T20:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Rennes',        awayTeamName: 'Lens',          matchDate: dt('2026-04-26T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Strasbourg',    awayTeamName: 'Lyon',          matchDate: dt('2026-04-26T20:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Reims',         awayTeamName: 'Nantes',        matchDate: dt('2026-04-26T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Saint-Étienne', awayTeamName: 'Auxerre',       matchDate: dt('2026-04-26T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Brest',         awayTeamName: 'Toulouse',      matchDate: dt('2026-04-26T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Metz',          awayTeamName: 'Montpellier',   matchDate: dt('2026-04-26T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 30, season: '2025-26', homeTeamName: 'Le Havre',      awayTeamName: 'Angers',        matchDate: dt('2026-04-26T18:00:00+03:00') },

      // Hafta 31 (2-3 Mayıs 2026)
      { leagueId: leagueLig1.id, weekNumber: 31, season: '2025-26', homeTeamName: 'PSG',           awayTeamName: 'Lyon',          matchDate: dt('2026-05-02T22:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Marseille',     awayTeamName: 'Monaco',        matchDate: dt('2026-05-02T20:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Lens',          awayTeamName: 'Rennes',        matchDate: dt('2026-05-03T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Nice',          awayTeamName: 'Strasbourg',    matchDate: dt('2026-05-03T20:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Toulouse',      awayTeamName: 'Saint-Étienne', matchDate: dt('2026-05-03T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Nantes',        awayTeamName: 'Brest',         matchDate: dt('2026-05-03T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Reims',         awayTeamName: 'Auxerre',       matchDate: dt('2026-05-03T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Montpellier',   awayTeamName: 'Le Havre',      matchDate: dt('2026-05-03T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 31, season: '2025-26', homeTeamName: 'Angers',        awayTeamName: 'Metz',          matchDate: dt('2026-05-03T18:00:00+03:00') },

      // Hafta 32 (9-10 Mayıs 2026)
      { leagueId: leagueLig1.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Monaco',        awayTeamName: 'PSG',           matchDate: dt('2026-05-09T22:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Lyon',          awayTeamName: 'Marseille',     matchDate: dt('2026-05-09T20:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Rennes',        awayTeamName: 'Nice',          matchDate: dt('2026-05-10T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Strasbourg',    awayTeamName: 'Lens',          matchDate: dt('2026-05-10T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Auxerre',       awayTeamName: 'Toulouse',      matchDate: dt('2026-05-10T20:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Saint-Étienne', awayTeamName: 'Reims',         matchDate: dt('2026-05-10T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Brest',         awayTeamName: 'Montpellier',   matchDate: dt('2026-05-10T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Le Havre',      awayTeamName: 'Nantes',        matchDate: dt('2026-05-10T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 32, season: '2025-26', homeTeamName: 'Metz',          awayTeamName: 'Angers',        matchDate: dt('2026-05-10T18:00:00+03:00') },

      // Hafta 33 (16-17 Mayıs 2026)
      { leagueId: leagueLig1.id, weekNumber: 33, season: '2025-26', homeTeamName: 'PSG',           awayTeamName: 'Lens',          matchDate: dt('2026-05-16T22:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Marseille',     awayTeamName: 'Lyon',          matchDate: dt('2026-05-16T20:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Monaco',        awayTeamName: 'Nice',          matchDate: dt('2026-05-17T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Rennes',        awayTeamName: 'Toulouse',      matchDate: dt('2026-05-17T20:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Strasbourg',    awayTeamName: 'Reims',         matchDate: dt('2026-05-17T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Nantes',        awayTeamName: 'Saint-Étienne', matchDate: dt('2026-05-17T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Auxerre',       awayTeamName: 'Angers',        matchDate: dt('2026-05-17T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Brest',         awayTeamName: 'Le Havre',      matchDate: dt('2026-05-17T18:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 33, season: '2025-26', homeTeamName: 'Montpellier',   awayTeamName: 'Metz',          matchDate: dt('2026-05-17T18:00:00+03:00') },

      // Hafta 34 — Son Hafta (24 Mayıs 2026, eşzamanlı)
      { leagueId: leagueLig1.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Lyon',          awayTeamName: 'PSG',           matchDate: dt('2026-05-24T22:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Lens',          awayTeamName: 'Marseille',     matchDate: dt('2026-05-24T22:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Nice',          awayTeamName: 'Monaco',        matchDate: dt('2026-05-24T22:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Toulouse',      awayTeamName: 'Rennes',        matchDate: dt('2026-05-24T22:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Reims',         awayTeamName: 'Strasbourg',    matchDate: dt('2026-05-24T22:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Saint-Étienne', awayTeamName: 'Brest',         matchDate: dt('2026-05-24T22:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Le Havre',      awayTeamName: 'Auxerre',       matchDate: dt('2026-05-24T22:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Metz',          awayTeamName: 'Nantes',        matchDate: dt('2026-05-24T22:00:00+03:00') },
      { leagueId: leagueLig1.id, weekNumber: 34, season: '2025-26', homeTeamName: 'Angers',        awayTeamName: 'Montpellier',   matchDate: dt('2026-05-24T22:00:00+03:00') },
    ],
    skipDuplicates: true,
  });

  // Türkiye Basketbol Süper Ligi 2025-26 — Play-off Aşaması
  await prisma.match.createMany({
    data: [
      // Çeyrek Final (18-26 Nisan 2026) — Best of 5
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Anadolu Efes',      awayTeamName: 'Pınar Karşıyaka',   matchDate: dt('2026-04-18T20:00:00+03:00'), venue: 'Sinan Erdem Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Fenerbahçe Beko',   awayTeamName: 'Büyükçekmece',      matchDate: dt('2026-04-18T18:00:00+03:00'), venue: 'Ülker Spor ve Etkinlik Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Galatasaray Nef',   awayTeamName: 'Tofaş',             matchDate: dt('2026-04-19T18:00:00+03:00'), venue: 'Abdi İpekçi Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Türk Telekom',      awayTeamName: 'Bahçeşehir Koleji', matchDate: dt('2026-04-19T20:00:00+03:00'), venue: 'Ankara Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Pınar Karşıyaka',   awayTeamName: 'Anadolu Efes',      matchDate: dt('2026-04-21T20:00:00+03:00'), venue: 'Pınar Arena' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Büyükçekmece',      awayTeamName: 'Fenerbahçe Beko',   matchDate: dt('2026-04-21T18:00:00+03:00'), venue: 'Spor Toto Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Tofaş',             awayTeamName: 'Galatasaray Nef',   matchDate: dt('2026-04-22T20:00:00+03:00'), venue: 'Tofaş Nilüfer Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Bahçeşehir Koleji', awayTeamName: 'Türk Telekom',      matchDate: dt('2026-04-22T18:00:00+03:00'), venue: 'Bahçeşehir Koleji Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Anadolu Efes',      awayTeamName: 'Pınar Karşıyaka',   matchDate: dt('2026-04-24T20:00:00+03:00'), venue: 'Sinan Erdem Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Fenerbahçe Beko',   awayTeamName: 'Büyükçekmece',      matchDate: dt('2026-04-24T18:00:00+03:00'), venue: 'Ülker Spor ve Etkinlik Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Galatasaray Nef',   awayTeamName: 'Tofaş',             matchDate: dt('2026-04-25T18:00:00+03:00'), venue: 'Abdi İpekçi Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Türk Telekom',      awayTeamName: 'Bahçeşehir Koleji', matchDate: dt('2026-04-25T20:00:00+03:00'), venue: 'Ankara Spor Salonu' },

      // Yarı Final (2-12 Mayıs 2026) — Best of 5
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Anadolu Efes',      awayTeamName: 'Fenerbahçe Beko',   matchDate: dt('2026-05-02T20:00:00+03:00'), venue: 'Sinan Erdem Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Galatasaray Nef',   awayTeamName: 'Türk Telekom',      matchDate: dt('2026-05-02T18:00:00+03:00'), venue: 'Abdi İpekçi Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Fenerbahçe Beko',   awayTeamName: 'Anadolu Efes',      matchDate: dt('2026-05-05T20:00:00+03:00'), venue: 'Ülker Spor ve Etkinlik Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Türk Telekom',      awayTeamName: 'Galatasaray Nef',   matchDate: dt('2026-05-05T18:00:00+03:00'), venue: 'Ankara Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Anadolu Efes',      awayTeamName: 'Fenerbahçe Beko',   matchDate: dt('2026-05-08T20:00:00+03:00'), venue: 'Sinan Erdem Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Galatasaray Nef',   awayTeamName: 'Türk Telekom',      matchDate: dt('2026-05-08T18:00:00+03:00'), venue: 'Abdi İpekçi Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Fenerbahçe Beko',   awayTeamName: 'Anadolu Efes',      matchDate: dt('2026-05-11T20:00:00+03:00'), venue: 'Ülker Spor ve Etkinlik Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Türk Telekom',      awayTeamName: 'Galatasaray Nef',   matchDate: dt('2026-05-11T18:00:00+03:00'), venue: 'Ankara Spor Salonu' },

      // Final (17-28 Mayıs 2026) — Best of 5
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Anadolu Efes',      awayTeamName: 'Galatasaray Nef',   matchDate: dt('2026-05-17T18:00:00+03:00'), venue: 'Sinan Erdem Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Galatasaray Nef',   awayTeamName: 'Anadolu Efes',      matchDate: dt('2026-05-20T18:00:00+03:00'), venue: 'Abdi İpekçi Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Anadolu Efes',      awayTeamName: 'Galatasaray Nef',   matchDate: dt('2026-05-23T18:00:00+03:00'), venue: 'Sinan Erdem Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Galatasaray Nef',   awayTeamName: 'Anadolu Efes',      matchDate: dt('2026-05-26T18:00:00+03:00'), venue: 'Abdi İpekçi Spor Salonu' },
      { leagueId: leagueBSL.id, weekNumber: null, season: '2025-26', homeTeamName: 'Anadolu Efes',      awayTeamName: 'Galatasaray Nef',   matchDate: dt('2026-05-28T18:00:00+03:00'), venue: 'Sinan Erdem Spor Salonu' },
    ],
    skipDuplicates: true,
  });

  console.log('Seed complete.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
