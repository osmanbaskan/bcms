import { FastifyPluginAsync } from 'fastify';

export const optaSyncRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/sync', async (request, reply) => {
    const body = request.body as { matches: any[] };
    
    if (!body || !Array.isArray(body.matches)) {
      return reply.code(400).send({ error: 'Geçersiz payload, matches dizisi zorunludur.' });
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;

    // Gelen her Opta maçı için DB Prisma Upsert işlemlerini yapıyoruz
    for (const match of body.matches) {
      if (!match.matchUid) continue;

      // 1. Lig (Competition) bilgisini Upsert et
      const leagueCode = `opta-${match.compId}`;
      const league = await fastify.prisma.league.upsert({
        where: { code: leagueCode },
        create: {
          code: leagueCode,
          name: match.compName,
          country: '',
          metadata: { optaCompId: match.compId },
        },
        update: {
          name: match.compName,
        },
      });

      // 2. Maç (Match) bilgisini Upsert et
      const existingMatch = await fastify.prisma.match.findUnique({
        where: { optaUid: match.matchUid },
      });

      if (!existingMatch) {
        await fastify.prisma.match.create({
          data: {
            leagueId: league.id,
            optaUid: match.matchUid,
            homeTeamName: match.homeTeam || '?',
            awayTeamName: match.awayTeam || '?',
            matchDate: new Date(match.matchDate),
            weekNumber: match.weekNumber || null,
            season: match.season,
            venue: match.venue || null,
          },
        });
        inserted++;
      } else {
        const oldDate = existingMatch.matchDate.getTime();
        const newDate = new Date(match.matchDate).getTime();

        if (oldDate !== newDate) {
          await fastify.prisma.match.update({
            where: { id: existingMatch.id },
            data: { matchDate: new Date(match.matchDate) },
          });
          updated++;
        } else {
          unchanged++;
        }
      }
    }

    fastify.log.info(`OPTA Senkronizasyonu Tamamlandı - Yeni: ${inserted}, Güncellenen: ${updated}, Değişmeyen: ${unchanged}`);
    
    return { inserted, updated, unchanged };
  });
};