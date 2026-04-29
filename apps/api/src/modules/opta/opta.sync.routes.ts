import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const matchItemSchema = z.object({
  matchUid:   z.string().min(1),
  compId:     z.string().min(1),
  compName:   z.string().default(''),
  homeTeam:   z.string().optional(),
  awayTeam:   z.string().optional(),
  matchDate:  z.string().datetime({ offset: true }),
  weekNumber: z.number().int().nullable().optional(),
  season:     z.string().optional(),
  venue:      z.string().nullable().optional(),
});

const syncBodySchema = z.object({
  matches: z.array(matchItemSchema),
});

export const optaSyncRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/sync', { config: { rateLimit: false } }, async (request, reply) => {
    const secret = process.env.OPTA_SYNC_SECRET;
    if (!secret) {
      return reply.code(500).send({ error: 'OPTA_SYNC_SECRET yapılandırılmamış.' });
    }

    const auth = request.headers.authorization;
    if (!auth || auth !== `Bearer ${secret}`) {
      return reply.code(401).send({ error: 'Yetkisiz.' });
    }

    const parsed = syncBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Geçersiz payload.', issues: parsed.error.issues });
    }

    const validMatches = parsed.data.matches;
    if (validMatches.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };

    // 1. Benzersiz ligleri tek seferde upsert et
    const uniqueComps = new Map<string, { compId: string; compName: string }>();
    for (const m of validMatches) {
      if (!uniqueComps.has(m.compId)) uniqueComps.set(m.compId, { compId: m.compId, compName: m.compName });
    }

    const leagueMap = new Map<string, number>(); // compId → leagueId
    await Promise.all(
      Array.from(uniqueComps.values()).map(async ({ compId, compName }) => {
        const league = await fastify.prisma.league.upsert({
          where:  { code: `opta-${compId}` },
          create: { code: `opta-${compId}`, name: compName, country: '', metadata: { optaCompId: compId } },
          update: { name: compName },
          select: { id: true },
        });
        leagueMap.set(compId, league.id);
      }),
    );

    // 2. Mevcut maçları toplu sorgula
    const uids = validMatches.map((m) => m.matchUid);
    const existing = await fastify.prisma.match.findMany({
      where:  { optaUid: { in: uids } },
      select: { id: true, optaUid: true, matchDate: true },
    });
    const existingMap = new Map(existing.map((e) => [e.optaUid!, e]));

    // 3. Insert / update listelerini ayır
    const toInsert: typeof validMatches = [];
    const toUpdate: { id: number; matchDate: Date }[] = [];
    let unchanged = 0;

    for (const m of validMatches) {
      const ex = existingMap.get(m.matchUid);
      if (!ex) {
        toInsert.push(m);
      } else {
        const newDate = new Date(m.matchDate).getTime();
        if (ex.matchDate.getTime() !== newDate) {
          toUpdate.push({ id: ex.id, matchDate: new Date(m.matchDate) });
        } else {
          unchanged++;
        }
      }
    }

    // 4. Tek transaction içinde toplu yaz
    await fastify.prisma.$transaction([
      ...toInsert.map((m) =>
        fastify.prisma.match.create({
          data: {
            leagueId:     leagueMap.get(m.compId)!,
            optaUid:      m.matchUid,
            homeTeamName: m.homeTeam || '?',
            awayTeamName: m.awayTeam || '?',
            matchDate:    new Date(m.matchDate),
            weekNumber:   m.weekNumber || null,
            season:       m.season ?? '',
            venue:        m.venue || null,
          },
        }),
      ),
      ...toUpdate.map((u) =>
        fastify.prisma.match.update({
          where: { id: u.id },
          data:  { matchDate: u.matchDate },
        }),
      ),
    ]);

    fastify.log.info(
      `OPTA sync tamamlandı — yeni: ${toInsert.length}, güncellenen: ${toUpdate.length}, değişmeyen: ${unchanged}`,
    );

    return { inserted: toInsert.length, updated: toUpdate.length, unchanged };
  });
};
