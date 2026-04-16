import type { FastifyInstance } from 'fastify';
import { PERMISSIONS } from '@bcms/shared';

export async function matchRoutes(app: FastifyInstance) {
  // GET /api/v1/matches/leagues — Tüm ligleri döndür
  app.get('/leagues', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
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
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
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
    const q = request.query as {
      leagueId?: number;
      from?: string;
      to?: string;
      season?: string;
    };

    const matches = await app.prisma.match.findMany({
      where: {
        ...(q.leagueId ? { leagueId: Number(q.leagueId) } : {}),
        ...(q.season   ? { season: q.season }               : {}),
        matchDate: {
          ...(q.from ? { gte: new Date(q.from) } : {}),
          ...(q.to   ? { lte: new Date(q.to)   } : {}),
        },
      },
      include: {
        league: { select: { id: true, code: true, name: true, country: true } },
      },
      orderBy: [{ matchDate: 'asc' }, { id: 'asc' }],
    });

    return matches.map((m) => ({
      ...m,
      matchDate: m.matchDate.toISOString(),
      createdAt: m.createdAt.toISOString(),
      label: buildLabel(m.homeTeamName, m.awayTeamName, m.matchDate, m.weekNumber),
    }));
  });
}

function buildLabel(home: string, away: string, date: Date, week: number | null): string {
  const d = new Date(date);
  const pad = (n: number) => String(n).padStart(2, '0');
  const months = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
  const dateStr = `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const weekStr = week ? ` | H${week}` : '';
  return `${home} - ${away} (${dateStr}${weekStr})`;
}
