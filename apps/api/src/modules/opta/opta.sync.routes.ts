import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import crypto from 'node:crypto';
import { QUEUES } from '../../plugins/rabbitmq.js';

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

/** Cascade'in dokunmayacağı schedule durumları.
 *  ON_AIR (yayında olan) kaydı OPTA shift sebebiyle kaydırmak operasyonel risk
 *  (MCR ekibi için sürpriz). COMPLETED + CANCELLED da frozen — geçmiş yayın. */
const FROZEN_STATUSES = ['COMPLETED', 'CANCELLED', 'ON_AIR'] as const;

/** "HH:MM" string'ini deltaMs kadar kaydır. Format eşleşmiyorsa null döner
 *  (caller dokunmaz). Gün sınırı wraps (24h+ → modulo 24h). */
function shiftTimeOfDay(value: unknown, deltaMs: number): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins  = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return null;
  const totalMins = hours * 60 + mins;
  const deltaMins = Math.round(deltaMs / 60000);
  let nextMins = (totalMins + deltaMins) % 1440;
  if (nextMins < 0) nextMins += 1440;
  const h = Math.floor(nextMins / 60);
  const m = nextMins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

interface SyncResponse {
  inserted: number;
  updated: number;
  unchanged: number;
  cascadedSchedules: number;
  cascadeConflicts: number;
}

const EMPTY_RESPONSE: SyncResponse = {
  inserted: 0, updated: 0, unchanged: 0,
  cascadedSchedules: 0, cascadeConflicts: 0,
};

export const optaSyncRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Reply: SyncResponse | { error: string; issues?: unknown } }>(
    '/sync',
    { config: { rateLimit: false } },
    async (request, reply) => {
      // ── Auth ──
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

      // ── Dedupe matchUid (defensive — schema garanti etmiyor) ──
      const dedupedMap = new Map<string, typeof parsed.data.matches[number]>();
      for (const m of parsed.data.matches) {
        dedupedMap.set(m.matchUid, m); // last wins
      }
      const validMatches = Array.from(dedupedMap.values());

      if (validMatches.length === 0) return EMPTY_RESPONSE;

      // ── 1. Benzersiz ligleri tek seferde upsert et ──
      const uniqueComps = new Map<string, { compId: string; compName: string }>();
      for (const m of validMatches) {
        if (!uniqueComps.has(m.compId)) {
          uniqueComps.set(m.compId, { compId: m.compId, compName: m.compName });
        }
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

        // ── 2. Mevcut maçları toplu sorgula ──
        const uids = validMatches.map((m) => m.matchUid);
        const existing = await tx.match.findMany({
          where:  { optaUid: { in: uids } },
          select: { id: true, optaUid: true, matchDate: true },
        });
        const existingMap = new Map(existing.map((e) => [e.optaUid!, e]));

        // ── 3. Insert / update listelerini ayır ──
        const toInsert: typeof validMatches = [];
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

        // ── 4. Lig ve maç yazımlarını tek transaction içinde yap ──
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
      // OPTA tx commit'i sonrası best-effort cascade. Ana transaction dışında
      // tutulur ki bir schedule çakışsa OPTA upsert rollback olmasın.
      // Tüm exception'lar yakalanır — response asla cascade hatası nedeniyle
      // 500 dönmez.
      let cascadedSchedules = 0;
      let cascadeConflicts = 0;
      try {
        for (const u of result.toUpdate) {
          const deltaMs = u.newMatchDate.getTime() - u.oldMatchDate.getTime();
          if (deltaMs === 0) continue;

          const dependents = await fastify.prisma.schedule.findMany({
            where: {
              usageScope: 'live-plan',
              status: { notIn: [...FROZEN_STATUSES] },
              metadata: { path: ['optaMatchId'], equals: u.matchUid },
            },
            select: { id: true, startTime: true, endTime: true, version: true, metadata: true },
          });

          for (const dep of dependents) {
            const newStart = new Date(dep.startTime.getTime() + deltaMs);
            const newEnd   = new Date(dep.endTime.getTime()   + deltaMs);

            // metadata.transStart / transEnd: kullanıcının manuel "yayın
            // saati" alanları. Cascade aynı delta'yı buraya da uygular —
            // tabloda görünen saatlerin de OPTA shift'iyle hareket etmesi için.
            const m = (dep.metadata ?? {}) as Record<string, unknown>;
            const shiftedTransStart = shiftTimeOfDay(m['transStart'], deltaMs);
            const shiftedTransEnd   = shiftTimeOfDay(m['transEnd'],   deltaMs);
            const metadataChanges: Record<string, string> = {};
            if (shiftedTransStart != null) metadataChanges.transStart = shiftedTransStart;
            if (shiftedTransEnd   != null) metadataChanges.transEnd   = shiftedTransEnd;
            const newMetadata = Object.keys(metadataChanges).length > 0
              ? { ...m, ...metadataChanges }
              : null;

            try {
              // Real optimistic lock: version match + count check.
              // Kullanıcı eş zamanlı edit ediyorsa (version moved) cascade
              // skip eder, user write korunur. Retry yok — sonraki OPTA
              // sync (1 saat) tekrar dener.
              const updated = await fastify.prisma.schedule.updateMany({
                where: { id: dep.id, version: dep.version },
                data: {
                  startTime: newStart,
                  endTime:   newEnd,
                  version:   { increment: 1 },
                  ...(newMetadata != null && { metadata: newMetadata as Prisma.InputJsonValue }),
                },
              });

              if (updated.count !== 1) {
                cascadeConflicts++;
                fastify.log.warn(
                  { scheduleId: dep.id, expectedVersion: dep.version, matchUid: u.matchUid },
                  'OPTA cascade — schedule shift skipped (version conflict)',
                );
                continue;
              }

              cascadedSchedules++;

              // Event publish — best-effort. Audit zaten Prisma extension
              // ile kapsandı; event bus ayrı sorumluluk.
              try {
                await fastify.rabbitmq.publish(QUEUES.SCHEDULE_UPDATED, {
                  scheduleId: dep.id,
                  changes: {
                    startTime: newStart.toISOString(),
                    endTime:   newEnd.toISOString(),
                    ...(Object.keys(metadataChanges).length > 0 && { metadata: metadataChanges }),
                    source: 'opta-cascade',
                  },
                });
              } catch (pubErr) {
                fastify.log.warn(
                  { scheduleId: dep.id, err: (pubErr as Error).message },
                  'OPTA cascade — SCHEDULE_UPDATED publish failed (cascade success kept)',
                );
              }
            } catch (err) {
              // Channel-overlap exclusion (schedules_no_channel_time_overlap),
              // FK violation, vs. — schedule kaydırılamadı, devam et.
              cascadeConflicts++;
              fastify.log.warn(
                { scheduleId: dep.id, matchUid: u.matchUid, deltaMs, err: (err as Error).message },
                'OPTA cascade — schedule shift skipped (DB conflict)',
              );
            }
          }
        }
      } catch (err) {
        // Beklenmeyen hata (DB connection drop vs.) — kalan cascade atlanır,
        // response yine başarılı bitirilir. Sonraki OPTA sync (1 saat) retry yapar.
        fastify.log.error(
          { err: (err as Error).message },
          'OPTA cascade — beklenmeyen hata, kalan cascade atlandı',
        );
      }

      fastify.log.info(
        `OPTA sync — yeni:${result.inserted}, güncellenen:${result.updated}, ` +
        `değişmeyen:${result.unchanged}, schedule kaydırılan:${cascadedSchedules}, ` +
        `çakışma:${cascadeConflicts}`,
      );

      return {
        inserted:          result.inserted,
        updated:           result.updated,
        unchanged:         result.unchanged,
        cascadedSchedules,
        cascadeConflicts,
      };
    },
  );
};
