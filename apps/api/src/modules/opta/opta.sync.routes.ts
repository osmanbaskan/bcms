import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import crypto from 'node:crypto';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { optaLeagueSyncTotal } from '../../plugins/metrics.js';
import { als } from '../../plugins/audit.js';
import { cascadeOptaUpdates, type CascadeMatchUpdate } from './opta-cascade.service.js';

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

interface SyncResponse {
  inserted: number;
  updated: number;
  unchanged: number;
  cascadedSchedules: number;
  /** SCHED-B3c (KO13): live_plan_entries cascade sayısı. */
  cascadedLivePlanEntries: number;
  /** Cascade tx-level error sayısı (KO1: skip yok; sadece tx fail). */
  cascadeConflicts: number;
  /** SCHED-B3c (KO13): live-plan tx fail granular counter. */
  livePlanCascadeConflicts: number;
  /** true: en az bir cascade tx fail'i var → manuel reconcile gerekir. */
  manualReconcileRequired: boolean;
  /** Outer catch fire ettiyse hata mesajı. */
  cascadeError?: string | null;
}

const EMPTY_RESPONSE: SyncResponse = {
  inserted: 0, updated: 0, unchanged: 0,
  cascadedSchedules: 0, cascadedLivePlanEntries: 0,
  cascadeConflicts: 0, livePlanCascadeConflicts: 0,
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

      // ── Audit actor (KO10): system:opta-sync ──
      // Request-scoped ALS store'u mutate ediyoruz; audit onSend flush aynı
      // store'dan pendingAuditLogs okuduğu için scoped als.run kullanılamaz.
      // Bearer auth preHandler'da userId set etmiyor (`request.user` yok);
      // mevcut fallback 'system' yerine explicit `system:opta-sync` enjekte.
      const auditStore = als.getStore();
      if (auditStore) auditStore.userId = 'system:opta-sync';

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

        // ── 2. Mevcut maçları toplu sorgula (KO4: team diff için home/away da) ──
        const uids = validMatches.map((m) => m.matchUid);
        const existing = await tx.match.findMany({
          where:  { optaUid: { in: uids } },
          select: { id: true, optaUid: true, matchDate: true, homeTeamName: true, awayTeamName: true },
        });
        const existingMap = new Map(existing.map((e) => [e.optaUid!, e]));

        // ── 3. Insert / update listelerini ayır ──
        // KO4 (2026-05-07): matchDate diff'e ek olarak homeTeam/awayTeam diff
        // de yakalanır; cascade B3c kapsamında temel event bilgisi update'i
        // tetikler.
        const toInsert: typeof validMatches = [];
        const toUpdate: Array<{
          id: number;
          matchUid: string;
          newMatchDate: Date | null;
          newHomeTeam: string | null;
          newAwayTeam: string | null;
          // Cascade için canonical güncel değerler (home/away her durumda
          // bilinir; matchDate sadece diff varsa).
          finalMatchDate: Date;
          finalHomeTeam: string;
          finalAwayTeam: string;
        }> = [];
        let unchanged = 0;

        for (const m of validMatches) {
          const ex = existingMap.get(m.matchUid);
          if (!ex) {
            toInsert.push(m);
            continue;
          }

          const newDate = new Date(m.matchDate);
          const dateDiff = ex.matchDate.getTime() !== newDate.getTime();

          const incomingHome = m.homeTeam || '?';
          const incomingAway = m.awayTeam || '?';
          const homeDiff = ex.homeTeamName !== incomingHome;
          const awayDiff = ex.awayTeamName !== incomingAway;

          if (!dateDiff && !homeDiff && !awayDiff) {
            unchanged += 1;
            continue;
          }

          toUpdate.push({
            id: ex.id,
            matchUid: m.matchUid,
            newMatchDate: dateDiff ? newDate : null,
            newHomeTeam:  homeDiff ? incomingHome : null,
            newAwayTeam:  awayDiff ? incomingAway : null,
            finalMatchDate: dateDiff ? newDate : ex.matchDate,
            finalHomeTeam:  homeDiff ? incomingHome : ex.homeTeamName,
            finalAwayTeam:  awayDiff ? incomingAway : ex.awayTeamName,
          });
        }

        // ── 4. Lig ve maç yazımlarını tek transaction içinde yap ──
        // HIGH-API-005 fix (2026-05-05): unbounded Promise.all yerine:
        //   - createMany ile insert'leri tek SQL'de batch et
        //   - update'leri 10'arlı paralel chunk'larla işle (connection pool
        //     tükenmesini ve lock thrashing'i engelle)
        if (toInsert.length > 0) {
          await tx.match.createMany({
            data: toInsert.map((m) => ({
              leagueId:     leagueMap.get(m.compId)!,
              optaUid:      m.matchUid,
              homeTeamName: m.homeTeam || '?',
              awayTeamName: m.awayTeam || '?',
              matchDate:    new Date(m.matchDate),
              weekNumber:   m.weekNumber || null,
              season:       m.season ?? '',
              venue:        m.venue || null,
            })),
            skipDuplicates: true,
          });
        }
        const UPDATE_CONCURRENCY = 10;
        for (let i = 0; i < toUpdate.length; i += UPDATE_CONCURRENCY) {
          const chunk = toUpdate.slice(i, i + UPDATE_CONCURRENCY);
          await Promise.all(chunk.map((u) => {
            // KO4: matchDate + team diff'lerin sadece değişeni yazılır
            // (audit gürültü engeli — only-changed-fields paritesi).
            const data: Prisma.MatchUpdateInput = {};
            if (u.newMatchDate) data.matchDate    = u.newMatchDate;
            if (u.newHomeTeam)  data.homeTeamName = u.newHomeTeam;
            if (u.newAwayTeam)  data.awayTeamName = u.newAwayTeam;
            return tx.match.update({ where: { id: u.id }, data });
          }));
        }

        return { inserted: toInsert.length, updated: toUpdate.length, unchanged, toUpdate };
      }),
        fastify.log,
      );

      // ── Cascade (SCHED-B3c, KO1-KO14) ─────────────────────────────────
      // Per-match $transaction; bir match cascade fail ederse diğerleri
      // etkilenmez (granular hata izolasyonu). Conflict skip YOK (KO1).
      const cascadeUpdates: CascadeMatchUpdate[] = result.toUpdate.map((u) => ({
        matchId:        u.id,
        matchUid:       u.matchUid,
        newMatchDate:   u.newMatchDate,
        homeTeamName:   u.finalHomeTeam,
        awayTeamName:   u.finalAwayTeam,
        hasFieldChange: u.newMatchDate !== null || u.newHomeTeam !== null || u.newAwayTeam !== null,
      }));

      let cascadedLivePlanEntries = 0;
      let cascadedSchedules       = 0;
      let livePlanCascadeConflicts = 0;
      let cascadeError: string | null = null;
      try {
        const r = await cascadeOptaUpdates(fastify, cascadeUpdates);
        cascadedLivePlanEntries = r.livePlanEntriesUpdated;
        cascadedSchedules       = r.schedulesUpdated;
        livePlanCascadeConflicts = r.livePlanConflicts + r.scheduleConflicts;
      } catch (err) {
        // cascadeOptaUpdates kendi içinde per-match try/catch yapar; üst-düzey
        // throw beklenmez. Yine de defansif: connection drop / unexpected error
        // → response yine başarılı bitirilir, sayım eksik olabilir.
        cascadeError = (err as Error).message;
        fastify.log.error(
          { err: cascadeError },
          'OPTA cascade — beklenmeyen üst-düzey hata, kalan cascade atlandı',
        );
      }

      // RabbitMQ direct publish (KO + B3c korunur, source='opta-sync'). Outbox
      // shadow event'leri zaten cascade service'te yazıldı (Phase 2 status=
      // published). PR-C2 cut-over sonrası direct publish kaldırılır; B3c
      // kapsamı dışı.
      if (cascadedSchedules > 0) {
        try {
          await fastify.rabbitmq.publish(QUEUES.SCHEDULE_UPDATED, {
            cascadedSchedules,
            source: 'opta-sync',
          });
        } catch (pubErr) {
          fastify.log.warn(
            { err: (pubErr as Error).message },
            'OPTA sync — SCHEDULE_UPDATED publish failed (cascade success kept)',
          );
        }
      }

      const manualReconcileRequired = livePlanCascadeConflicts > 0 || cascadeError != null;

      fastify.log.info(
        `OPTA sync — yeni:${result.inserted}, güncellenen:${result.updated}, ` +
        `değişmeyen:${result.unchanged}, schedule kaydırılan:${cascadedSchedules}, ` +
        `live-plan kaydırılan:${cascadedLivePlanEntries}, ` +
        `cascade tx-fail:${livePlanCascadeConflicts}, ` +
        `manuelReconcile:${manualReconcileRequired}`,
      );

      return {
        inserted:                 result.inserted,
        updated:                  result.updated,
        unchanged:                result.unchanged,
        cascadedSchedules,
        cascadedLivePlanEntries,
        cascadeConflicts:         livePlanCascadeConflicts,
        livePlanCascadeConflicts,
        manualReconcileRequired,
        cascadeError,
      };
    },
  );
};
