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

  // GET /api/v1/opta/matches?competitionId=X&season=Y
  app.get<{ Querystring: { competitionId: string; season: string } }>('/matches', {
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
        },
      },
    },
  }, async (request) => {
    const { competitionId, season } = request.query;
    return loadMatches(competitionId, season);
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
