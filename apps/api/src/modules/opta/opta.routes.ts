import type { FastifyInstance } from 'fastify';
import { buildCompetitionList, loadMatches, clearOptaCache } from './opta.parser.js';
import { PERMISSIONS } from '@bcms/shared';

export async function optaRoutes(app: FastifyInstance) {

  // GET /api/v1/opta/competitions
  app.get('/competitions', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['OPTA'],
      summary: 'SMB arşivindeki competition listesi',
    },
  }, async () => {
    return buildCompetitionList();
  });

  // GET /api/v1/opta/matches?competitionId=X&season=Y[&unscheduled=false]
  app.get<{ Querystring: { competitionId: string; season: string; unscheduled?: string } }>('/matches', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.read),
    schema: {
      tags: ['OPTA'],
      summary: 'Belirli bir competition + season için maç listesi',
      querystring: {
        type: 'object',
        required: ['competitionId', 'season'],
        properties: {
          competitionId: { type: 'string' },
          season:        { type: 'string' },
          unscheduled:   { type: 'string', enum: ['true', 'false'], default: 'true' },
        },
      },
    },
  }, async (request) => {
    const { competitionId, season, unscheduled = 'true' } = request.query;
    const matches = loadMatches(competitionId, season);
    if (unscheduled === 'false') return matches;

    // Zaten yayın planına eklenmiş optaMatchId'leri çek
    const scheduled = await app.prisma.schedule.findMany({
      where: { metadata: { path: ['optaMatchId'], not: null } },
      select: { metadata: true },
    });
    const scheduledIds = new Set(
      scheduled.map((s) => (s.metadata as Record<string, unknown>)?.optaMatchId).filter(Boolean),
    );

    return matches.filter((m) => !scheduledIds.has(m.matchId));
  });

  // POST /api/v1/opta/cache/clear — cache'i zorla yenile
  app.post('/cache/clear', {
    preHandler: app.requireRole(...PERMISSIONS.schedules.write),
    schema: { tags: ['OPTA'], summary: 'OPTA dosya cache\'ini temizle' },
  }, async () => {
    clearOptaCache();
    return { ok: true };
  });
}
