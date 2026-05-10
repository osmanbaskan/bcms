import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';
import { ISTANBUL_TZ } from '../../core/tz.js';

const matchListQuerySchema = z.object({
  leagueId: z.coerce.number().int().positive().optional(),
  from:     z.string().datetime({ offset: true }).optional(),
  to:       z.string().datetime({ offset: true }).optional(),
  season:   z.string().optional(),
  // ORTA-API-1.4.6 fix (2026-05-04): take limit eklendi — boş filter ile
  // tüm fixture döndürmek response bombası. Default 200, üst sınır 1000.
  take:     z.coerce.number().int().min(1).max(1000).optional().default(200),
});

export async function matchRoutes(app: FastifyInstance) {
  // GET /api/v1/matches/leagues — Tüm ligleri döndür
  app.get('/leagues', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['Matches'],
      summary: 'Mevcut ligleri listele',
    },
  }, async () => {
    return app.prisma.league.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, country: true },
    });
  });

  // GET /api/v1/matches — Fikstür maçlarını listele (leagueId, from, to filtresi)
  app.get('/', {
    preHandler: app.requireGroup(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['Matches'],
      summary: 'Fikstür maçlarını listele',
      querystring: {
        type: 'object',
        properties: {
          leagueId: { type: 'number' },
          from:     { type: 'string', format: 'date-time' },
          to:       { type: 'string', format: 'date-time' },
          season:   { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const q = matchListQuerySchema.parse(request.query);

    const matches = await app.prisma.match.findMany({
      where: {
        ...(q.leagueId ? { leagueId: q.leagueId } : {}),
        ...(q.season   ? { season: q.season }      : {}),
        matchDate: {
          ...(q.from ? { gte: new Date(q.from) } : {}),
          ...(q.to   ? { lte: new Date(q.to)   } : {}),
        },
      },
      include: {
        league: { select: { id: true, code: true, name: true, country: true } },
      },
      orderBy: [{ matchDate: 'asc' }, { id: 'asc' }],
      take: q.take,
    });

    return matches.map((m) => ({
      ...m,
      matchDate: m.matchDate.toISOString(),
      createdAt: m.createdAt.toISOString(),
      label: buildLabel(m.homeTeamName, m.awayTeamName, m.matchDate, m.weekNumber),
    }));
  });
}

// LOW-API-016 fix (2026-05-05): timezone-aware Istanbul format.
const MATCH_TR_MONTHS = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
function buildLabel(home: string, away: string, date: Date, week: number | null): string {
  const parts = new Intl.DateTimeFormat('tr-TR', {
    timeZone: ISTANBUL_TZ, day: '2-digit', month: 'numeric',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const month = parseInt(get('month'), 10);
  const dateStr = `${get('day')} ${MATCH_TR_MONTHS[month - 1]} ${get('year')} ${get('hour')}:${get('minute')}`;
  const weekStr = week ? ` | H${week}` : '';
  return `${home} - ${away} (${dateStr}${weekStr})`;
}
