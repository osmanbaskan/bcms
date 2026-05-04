import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import crypto from 'node:crypto';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { optaLeagueSyncTotal } from '../../plugins/metrics.js';

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

/** HIGH-API-007 fix (2026-05-05) — DoS payload koruması.
 *  Ölçüm (2026-05-05): total 34811 maç, 67 lig, max single league=4180,
 *  avg league=520, last 30d daily bulk max=266 row. 5000 sınırı tek bir
 *  ligin maksimumunu (~4180) +20% buffer ile karşılar; çok ligli batch'lerde
 *  watcher kendi içinde lig başına chunk'a bölmek zorunda kalır. */
const OPTA_SYNC_MAX_MATCHES = 5000;
const syncBodySchema = z.object({
  matches: z.array(matchItemSchema).max(OPTA_SYNC_MAX_MATCHES, {
    message: `matches dizisi en fazla ${OPTA_SYNC_MAX_MATCHES} öğe içerebilir`,
  }),
});

/** Cascade'in dokunmayacağı schedule durumları.
 *  ON_AIR (yayında olan) kaydı OPTA shift sebebiyle kaydırmak operasyonel risk
 *  (MCR ekibi için sürpriz). COMPLETED + CANCELLED da frozen — geçmiş yayın. */
const FROZEN_STATUSES = ['COMPLETED', 'CANCELLED', 'ON_AIR'] as const;

/** "HH:MM" string'ini deltaMs kadar kaydır. Format eşleşmiyorsa veya
 *  range geçersizse (hours>=24 || mins>=60) null döner — caller dokunmaz,
 *  silent corruption riskini önler. Geçerli aralık için 24h modulo wrap. */
function shiftTimeOfDay(value: unknown, deltaMs: number): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins  = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return null;
  if (hours >= 24 || mins >= 60) return null;
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
  /** Cascade conflict (version mismatch / channel-overlap) yaşandı mı?
   *  true ise log'lardaki scheduleId/matchUid bilgisi ile manuel reconcile
   *  gerekir — drift correction otomatik DEĞİL. */
  manualReconcileRequired: boolean;
  /** Outer catch fire ettiyse hata mesajı; cascade sayımı tam değildir. */
  cascadeError?: string | null;
}

const EMPTY_RESPONSE: SyncResponse = {
  inserted: 0, updated: 0, unchanged: 0,
  cascadedSchedules: 0, cascadeConflicts: 0,
  manualReconcileRequired: false,
  cascadeError: null,
};

/** P2002 sadece `leagues.code` kaynaklı ise true. Concurrent OPTA sync
 *  ikinci tx'in `findMany` → `create` arasındaki pencerede aynı `code`'u
 *  insert ettiyse retry doğru aksiyon. Match.create'in P2002'sini (matchUid)
 *  retry etmek gereksiz double-work + log spam üretirdi — bu yüzden filter dar. */
function isLeagueCodeUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.includes('code');
  if (typeof target === 'string') return target === 'code' || target.includes('leagues_code');
  return false;
}

/** Yalnızca League.code unique conflict için outer retry. Inline catch + continue
 *  PG aborted-tx state'i nedeniyle güvenilir değil; tüm $transaction'ı tekrarla.
 *  Max 2 deneme yeterli — concurrent insert ikinci attempt'te `findMany`'da görülür. */
async function withLeagueCreateConflictRetry<T>(
  operation: () => Promise<T>,
  log: { warn: (obj: unknown, msg: string) => void },
  maxAttempts = 2,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isLeagueCodeUniqueConflict(error) || attempt === maxAttempts) throw error;
      const meta = (error as Prisma.PrismaClientKnownRequestError).meta;
      log.warn({ attempt, target: meta?.target }, 'opta sync league code conflict, retrying transaction');
    }
  }
  throw new Error('League create conflict retry exhausted');
}

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

      const result = await withLeagueCreateConflictRetry(
        () => fastify.prisma.$transaction(async (tx) => {
        const leagueMap = new Map<string, number>(); // compId → leagueId

        // ── 1a. Mevcut league'leri toplu çek (audit log dedupe için) ──
        // Eski kod her sync'te tüm league'leri tx.league.upsert ile çağırıyordu;
        // idempotent çağrılarda bile audit_logs satır yazılıyordu.
        // 2026-04-30 6.5 saatlik burst'te ~205k audit satırı bunun sonucu.
        // Yeni: name değişmemiş ise upsert ATLA → audit log yok.
        // HIGH-003 audit raporu detayında.
        const compCodes = Array.from(uniqueComps.values()).map((c) => `opta-${c.compId}`);
        const existingLeagues = compCodes.length > 0
          ? await tx.league.findMany({
              where: { code: { in: compCodes } },
              select: { id: true, code: true, name: true },
            })
          : [];
        const existingByCode = new Map(existingLeagues.map((l) => [l.code, l]));

        // ── 1b. Her unique comp için: create / update (name diff) / skip ──
        await Promise.all(
          Array.from(uniqueComps.values()).map(async ({ compId, compName }) => {
            const code = `opta-${compId}`;
            const existing = existingByCode.get(code);

            if (!existing) {
              // Yeni lig — create + audit yazılır (gerçek değişiklik)
              const league = await tx.league.create({
                data: { code, name: compName, country: '', metadata: { optaCompId: compId } },
                select: { id: true },
              });
              leagueMap.set(compId, league.id);
              optaLeagueSyncTotal.inc({ action: 'create' });
              return;
            }

            if (existing.name === compName) {
              // No-op: idempotent çağrı, audit log üretme
              leagueMap.set(compId, existing.id);
              optaLeagueSyncTotal.inc({ action: 'skip' });
              return;
            }

            // Name değişmiş — gerçek update + audit yazılır
            const league = await tx.league.update({
              where: { id: existing.id },
              data: { name: compName },
              select: { id: true },
            });
            leagueMap.set(compId, league.id);
            optaLeagueSyncTotal.inc({ action: 'update' });
          }),
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
      }),
        fastify.log,
      );

      // ── Schedule cascade ────────────────────────────────────────────────
      // OPTA tx commit'i sonrası best-effort cascade. Ana transaction dışında
      // tutulur ki bir schedule çakışsa OPTA upsert rollback olmasın.
      // Tüm exception'lar yakalanır — response asla cascade hatası nedeniyle
      // 500 dönmez.
      let cascadedSchedules = 0;
      let cascadeConflicts = 0;
      let cascadeError: string | null = null;
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
              // skip eder, user write korunur.
              //
              // ⚠ KALICI DRIFT RİSKİ: skip edilen schedule kalıcı olarak
              // OPTA'dan geri kalır. Sonraki OPTA sync match.matchDate'i
              // tekrar değiştirmedikçe cascade tetiklenmez. Çözüm: manuel
              // reconcile (response.manualReconcileRequired=true sinyali +
              // log'da scheduleId/matchUid/delta). Otomatik drift scan
              // ayrı bir PR'da; o zaman applied-date metadata + her sync'te
              // tarama tek atomik introduction olarak gelir.
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
        // Beklenmeyen hata (DB connection drop, findMany failure vs.) —
        // kalan cascade atlanır, response yine başarılı bitirilir. Sayım
        // eksik kalabilir → cascadeError ile caller'a sinyal verilir.
        cascadeError = (err as Error).message;
        fastify.log.error(
          { err: cascadeError },
          'OPTA cascade — beklenmeyen hata, kalan cascade atlandı',
        );
      }

      // Conflict veya outer-catch fire ettiyse manuel reconcile gerekir
      // (otomatik drift correction yok — drift scan PR'ı follow-up olacak).
      const manualReconcileRequired = cascadeConflicts > 0 || cascadeError != null;

      fastify.log.info(
        `OPTA sync — yeni:${result.inserted}, güncellenen:${result.updated}, ` +
        `değişmeyen:${result.unchanged}, schedule kaydırılan:${cascadedSchedules}, ` +
        `çakışma:${cascadeConflicts}, manuelReconcile:${manualReconcileRequired}`,
      );

      return {
        inserted:          result.inserted,
        updated:           result.updated,
        unchanged:         result.unchanged,
        cascadedSchedules,
        cascadeConflicts,
        manualReconcileRequired,
        cascadeError,
      };
    },
  );
};
