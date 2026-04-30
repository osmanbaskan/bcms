import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import crypto from 'node:crypto';

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

    const auth = request.headers.authorization ?? '';
    const expected = `Bearer ${secret}`;
    if (
      !auth ||
      auth.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
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

    const result = await fastify.prisma.$transaction(async (tx) => {
      const leagueMap = new Map<string, number>(); // compId → leagueId
      await Promise.all(
        Array.from(uniqueComps.values()).map(async ({ compId, compName }) => tx.league.upsert({
          where:  { code: `opta-${compId}` },
          create: { code: `opta-${compId}`, name: compName, country: '', metadata: { optaCompId: compId } },
          update: { name: compName },
          select: { id: true },
        }).then((league) => {
          leagueMap.set(compId, league.id);
        })),
      );

      // 2. Mevcut maçları toplu sorgula
      const uids = validMatches.map((m) => m.matchUid);
      const existing = await tx.match.findMany({
        where:  { optaUid: { in: uids } },
        select: { id: true, optaUid: true, matchDate: true },
      });
      const existingMap = new Map(existing.map((e) => [e.optaUid!, e]));

      // 3. Insert / update listelerini ayır
      const toInsert: typeof validMatches = [];
      // Schedule cascade için matchUid + oldMatchDate da takip edilir.
      const toUpdate: { id: number; matchUid: string; oldMatchDate: Date; newMatchDate: Date }[] = [];
      let unchanged = 0;

      for (const m of validMatches) {
        const ex = existingMap.get(m.matchUid);
        if (!ex) {
          toInsert.push(m);
        } else {
          const newDate = new Date(m.matchDate);
          if (ex.matchDate.getTime() !== newDate.getTime()) {
            toUpdate.push({
              id: ex.id,
              matchUid: m.matchUid,
              oldMatchDate: ex.matchDate,
              newMatchDate: newDate,
            });
          } else {
            unchanged++;
          }
        }
      }

      // 4. Lig ve maç yazımlarını tek transaction içinde yap
      await Promise.all([
        ...toInsert.map((m) => tx.match.create({
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
        })),
        ...toUpdate.map((u) => tx.match.update({
          where: { id: u.id },
          data:  { matchDate: u.newMatchDate },
        })),
      ]);

      return { inserted: toInsert.length, updated: toUpdate.length, unchanged, toUpdate };
    });

    // ── Schedule cascade ────────────────────────────────────────────────
    // OPTA tarafından zaman değişen her maç için, o maça bağlı schedule'ları
    // (orijinal + duplicate'ler — hepsi aynı metadata.optaMatchId taşır)
    // delta-based shift et. Manuel ayarlar (örn. yayın 30dk önce başlar)
    // korunur. COMPLETED / CANCELLED dokunulmaz. Channel-overlap çakışması
    // olursa o schedule skip + warn — OPTA tx zaten commit oldu, rollback yok.
    const cascade = { shifted: 0, conflicts: 0 };
    for (const u of result.toUpdate) {
      const deltaMs = u.newMatchDate.getTime() - u.oldMatchDate.getTime();
      if (deltaMs === 0) continue;

      const dependents = await fastify.prisma.schedule.findMany({
        where: {
          usageScope: 'live-plan',
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
          metadata: { path: ['optaMatchId'], equals: u.matchUid },
        },
        select: { id: true, startTime: true, endTime: true },
      });

      for (const dep of dependents) {
        const newStart = new Date(dep.startTime.getTime() + deltaMs);
        const newEnd   = new Date(dep.endTime.getTime()   + deltaMs);
        try {
          await fastify.prisma.schedule.update({
            where: { id: dep.id },
            data: {
              startTime: newStart,
              endTime:   newEnd,
              version:   { increment: 1 },
            },
          });
          cascade.shifted++;
        } catch (err) {
          // Channel overlap exclusion (schedules_no_channel_time_overlap) veya
          // optimistic lock conflict — schedule kaydırılamadı, log ve devam.
          if (err instanceof Prisma.PrismaClientKnownRequestError
              || (err instanceof Error && /overlap|exclude/i.test(err.message))) {
            cascade.conflicts++;
            fastify.log.warn(
              { scheduleId: dep.id, matchUid: u.matchUid, deltaMs, err: (err as Error).message },
              'OPTA cascade — schedule shift skipped (conflict)',
            );
          } else {
            throw err;
          }
        }
      }
    }

    fastify.log.info(
      `OPTA sync — yeni:${result.inserted}, güncellenen:${result.updated}, değişmeyen:${result.unchanged}, ` +
      `schedule kaydırılan:${cascade.shifted}, çakışma:${cascade.conflicts}`,
    );

    return {
      inserted:          result.inserted,
      updated:           result.updated,
      unchanged:         result.unchanged,
      cascadedSchedules: cascade.shifted,
      cascadeConflicts:  cascade.conflicts,
    };
  });
};
