/**
 * Türkiye Basketbol Ligi (TBL) manuel takım listesi seed.
 *
 * 2026-05-14: TBL OPTA fixture/team feed'i kapsam dışında. Yayın Planlama
 * "Yeni Ekle / Manuel Giriş" lig select'i için DB-backed takım listesi.
 * Kaynak: 2025-26 sezon puan tablosu (operatör görseli).
 *
 * Idempotent: lig `code='custom-tbl'` upsert; her takım için
 * `findFirst({leagueId, name}) + create` — Team modelinde (leagueId, name)
 * composite unique YOK, bu yüzden `createMany({skipDuplicates: true})`
 * gerçek duplicate engeli vermez.
 *
 * Çalıştırma:
 *   docker exec bcms_api node /app/dist/prisma/seed-tbl-teams.js
 *   veya
 *   docker exec bcms_api npx tsx /app/prisma/seed-tbl-teams.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TBL_LEAGUE_CODE = 'custom-tbl';
const TBL_LEAGUE_NAME = 'Türkiye Basketbol Ligi';

const TBL_TEAMS: Array<{ name: string; shortName: string }> = [
  { name: 'Fenerbahçe Beko',          shortName: 'FB Beko'   },
  { name: 'Beşiktaş GAİN',            shortName: 'BJK GAİN'  },
  { name: 'Bahçeşehir Koleji',        shortName: 'BHC'       },
  { name: 'Trabzonspor',              shortName: 'TS'        },
  { name: 'Türk Telekom',             shortName: 'TTel'      },
  { name: 'Anadolu Efes',             shortName: 'EFS'       },
  { name: 'Esenler Erokspor',         shortName: 'ESN'       },
  { name: 'Galatasaray MCT Technic',  shortName: 'GS MCT'    },
  { name: 'Tofaş',                    shortName: 'TOF'       },
  { name: 'Mersin Spor',              shortName: 'MER'       },
  { name: 'Yukatel Merkezefendi Bld.',shortName: 'MRK'       },
  { name: 'Manisa Basket',            shortName: 'MNS'       },
  { name: 'Aliağa Petkim Spor',       shortName: 'ALP'       },
  { name: 'Bursaspor Basketbol',      shortName: 'BRS'       },
  { name: 'Karşıyaka',                shortName: 'KSK'       },
  { name: 'ONVO Büyükçekmece',        shortName: 'BYK'       },
];

async function main(): Promise<void> {
  // `leagues.code` partial unique index (WHERE deleted_at IS NULL) →
  // Prisma `upsert({where:{code}})` ON CONFLICT desteklemez. findFirst +
  // create/update fallback. (Migration ile partial → tam unique yapmak
  // ayrı PR; emir kapsamında migration yok.)
  let league = await prisma.league.findFirst({
    where:  { code: TBL_LEAGUE_CODE, deleted_at: null },
    select: { id: true, code: true, name: true, sportGroup: true, visible: true },
  });
  if (!league) {
    league = await prisma.league.create({
      data: {
        code: TBL_LEAGUE_CODE, name: TBL_LEAGUE_NAME, country: 'Türkiye',
        sportGroup: 'basketball', visible: true,
      },
      select: { id: true, code: true, name: true, sportGroup: true, visible: true },
    });
    console.log(`[tbl-teams] league created: id=${league.id} code=${league.code}`);
  } else {
    console.log(`[tbl-teams] league exists: id=${league.id} code=${league.code} (no change)`);
  }

  let created = 0;
  let skipped = 0;
  for (const t of TBL_TEAMS) {
    const name = t.name.trim();
    const shortName = t.shortName.trim();
    const exists = await prisma.team.findFirst({
      where:  { leagueId: league.id, name, deleted_at: null },
      select: { id: true },
    });
    if (exists) {
      skipped++;
      continue;
    }
    await prisma.team.create({
      data: { leagueId: league.id, name, shortName },
    });
    created++;
  }
  console.log(`[tbl-teams] created=${created} skipped=${skipped} total=${TBL_TEAMS.length}`);
}

main()
  .catch((err) => {
    console.error('[tbl-teams] seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
