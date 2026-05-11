import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { writeShadowEvent } from '../outbox/outbox.helpers.js';

/**
 * SCHED-B3c (KO1-KO14, 2026-05-07): OPTA sync cascade core.
 *
 * Lock referansı: `ops/REQUIREMENTS-SCHEDULE-OPTA-SYNC-V1.md`.
 *
 * Sorumluluk:
 * - Existing live_plan_entries (sourceType='OPTA', eventKey='opta:<uid>') güncelle.
 *   - Filtre: status NOT IN ('COMPLETED', 'CANCELLED')  (KO14)
 *   - Aynı event_key duplicate satırların hepsi update edilir              (KO7)
 *   - Alanlar: eventStartTime, eventEndTime (duration korunur), team1/2,
 *     optaMatchId (match.optaUid canonical), matchId, version++           (KO9)
 *   - Conflict skip YOK; concurrent user write varsa son commit kazanır   (KO1)
 * - Existing schedules (eventKey='opta:<uid>') güncelle (canonical alanlar).
 *   - Filtre: status NOT IN ('COMPLETED', 'CANCELLED')                  (KO14)
 *     [ON_AIR hard delete 2026-05-11; enum'dan çıkarıldı]
 *   - Alanlar: title (`<home> vs <away>`), team_1/2_name, schedule_date,
 *     schedule_time, version++                                            (KO3)
 *   - Legacy start_time/end_time placeholder dual-write (canonical değil;
 *     B5 destructive cleanup'a kadar NOT NULL doyurma)                    (KO3)
 *   - metadata.transStart/transEnd shift YOK                              (KO5)
 * - Per-match transaction; bir match cascade'i fail ederse diğer match'leri
 *   etkilemez (granular hata izolasyonu).
 * - Only-changed-fields: diff yoksa update YOK + outbox YOK              (KO12)
 * - Outbox shadow events: live_plan.updated + schedule.updated per
 *   gerçekten değişen aggregate; status='published' (Phase 2 paritesi)   (KO11)
 *
 * Out of scope (KO8): technical_details, transmission_segments, channel slots,
 * commercial/logo/format options, ingest_plan_items, status, operationNotes.
 *
 * NOT: live-plan service.update method'u ÇAĞRILMAZ (KO2 — HTTP loop / yan
 * etki riski). Cascade mantığı bu service'te canonical olarak yazılır.
 */

const FROZEN_LIVE_PLAN_STATUSES = ['COMPLETED', 'CANCELLED'] as const;
const FROZEN_SCHEDULE_STATUSES  = ['COMPLETED', 'CANCELLED'] as const;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export interface CascadeMatchUpdate {
  /** matches.id (DB FK kaynağı) */
  matchId:      number;
  /** match.optaUid (canonical event_key string'i) */
  matchUid:     string;
  /** matchDate diff yoksa null — eventStartTime cascade tetiklenmez */
  newMatchDate: Date | null;
  /** Match.homeTeamName güncel (live-plan/schedule team1Name kaynağı) */
  homeTeamName: string;
  /** Match.awayTeamName güncel */
  awayTeamName: string;
  /** matchDate VEYA team adlarından en az biri değişmişse true */
  hasFieldChange: boolean;
}

export interface CascadeResult {
  livePlanEntriesUpdated: number;
  schedulesUpdated:       number;
  livePlanConflicts:      number;
  scheduleConflicts:      number;
}

const EMPTY_RESULT: CascadeResult = {
  livePlanEntriesUpdated: 0,
  schedulesUpdated:       0,
  livePlanConflicts:      0,
  scheduleConflicts:      0,
};

/**
 * Match update set'i için cascade çalıştır. Per-match $transaction; bir match
 * fail ederse diğerleri etkilenmez.
 */
export async function cascadeOptaUpdates(
  app: FastifyInstance,
  updates: CascadeMatchUpdate[],
): Promise<CascadeResult> {
  if (updates.length === 0) return EMPTY_RESULT;

  const totals: CascadeResult = { ...EMPTY_RESULT };

  for (const u of updates) {
    if (!u.hasFieldChange) continue;
    try {
      const r = await app.prisma.$transaction(async (tx) => cascadeSingleMatch(tx, u));
      totals.livePlanEntriesUpdated += r.livePlanEntriesUpdated;
      totals.schedulesUpdated       += r.schedulesUpdated;
    } catch (err) {
      // Tek match cascade fail: rollback otomatik; counter conflict++ ile
      // raporla; loop devam eder. (KO13 livePlanCascadeConflicts/scheduleConflicts
      // ayrımı için: bu noktada granular değil — cascade fail tx hatası,
      // route layer'da manualReconcileRequired sinyali tetiklenir.)
      totals.livePlanConflicts += 1;
      app.log.warn(
        { matchUid: u.matchUid, err: (err as Error).message },
        'OPTA cascade — match cascade tx failed (rolled back)',
      );
    }
  }

  return totals;
}

async function cascadeSingleMatch(
  tx: Prisma.TransactionClient,
  u: CascadeMatchUpdate,
): Promise<CascadeResult> {
  const eventKey = `opta:${u.matchUid}`;
  const result: CascadeResult = { ...EMPTY_RESULT };

  // ── 1. Live-plan cascade ──────────────────────────────────────────────
  const entries = await tx.livePlanEntry.findMany({
    where: {
      sourceType: 'OPTA',
      eventKey,
      deletedAt:  null, // defansif (hard-delete sonrası no-op)
      status:     { notIn: [...FROZEN_LIVE_PLAN_STATUSES] },
    },
  });

  for (const entry of entries) {
    const patch = buildLivePlanPatch(entry, u);
    if (!patch) continue; // KO12 only-changed-fields

    await tx.livePlanEntry.update({
      where: { id: entry.id },
      data: {
        ...patch.data,
        version: { increment: 1 },
      },
    });

    await writeShadowEvent(tx, {
      eventType:     'live_plan.updated',
      aggregateType: 'LivePlanEntry',
      aggregateId:   entry.id,
      payload: {
        livePlanEntryId: entry.id,
        matchId:         u.matchId,
        matchUid:        u.matchUid,
        source:          'opta-sync',
        changedFields:   patch.changedFields,
      },
    });

    result.livePlanEntriesUpdated += 1;
  }

  // ── 2. Schedule cascade ───────────────────────────────────────────────
  const schedules = await tx.schedule.findMany({
    where: {
      eventKey,
      status: { notIn: [...FROZEN_SCHEDULE_STATUSES] },
    },
  });

  for (const sch of schedules) {
    const patch = buildSchedulePatch(sch, u);
    if (!patch) continue; // KO12

    await tx.schedule.update({
      where: { id: sch.id },
      data: {
        ...patch.data,
        version: { increment: 1 },
      },
    });

    await writeShadowEvent(tx, {
      eventType:     'schedule.updated',
      aggregateType: 'Schedule',
      aggregateId:   sch.id,
      payload: {
        scheduleId:    sch.id,
        matchUid:      u.matchUid,
        source:        'opta-sync',
        changedFields: patch.changedFields,
      },
    });

    result.schedulesUpdated += 1;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Patch builders (KO12 only-changed-fields)
// ─────────────────────────────────────────────────────────────────────────

interface LivePlanPatch {
  data: Prisma.LivePlanEntryUpdateInput;
  changedFields: string[];
}

function buildLivePlanPatch(
  entry: { eventStartTime: Date; eventEndTime: Date; team1Name: string | null; team2Name: string | null; optaMatchId: string | null; matchId: number | null },
  u: CascadeMatchUpdate,
): LivePlanPatch | null {
  const data: Prisma.LivePlanEntryUpdateInput = {};
  const changed: string[] = [];

  if (u.newMatchDate && entry.eventStartTime.getTime() !== u.newMatchDate.getTime()) {
    // KO9: eventStartTime = match.matchDate; eventEndTime = newStart + duration.
    const duration = entry.eventEndTime.getTime() - entry.eventStartTime.getTime();
    const newEnd = new Date(
      u.newMatchDate.getTime() + (duration > 0 ? duration : TWO_HOURS_MS),
    );
    data.eventStartTime = u.newMatchDate;
    data.eventEndTime   = newEnd;
    changed.push('eventStartTime', 'eventEndTime');
  }

  if (entry.team1Name !== u.homeTeamName) {
    data.team1Name = u.homeTeamName;
    changed.push('team1Name');
  }

  if (entry.team2Name !== u.awayTeamName) {
    data.team2Name = u.awayTeamName;
    changed.push('team2Name');
  }

  // optaMatchId / matchId B3b paritesi: match.optaUid canonical, request input
  // değil — sourceType='OPTA' satırlarda zaten dolu olmalı, defansif sync.
  if (entry.optaMatchId !== u.matchUid) {
    data.optaMatchId = u.matchUid;
    changed.push('optaMatchId');
  }

  if (entry.matchId !== u.matchId) {
    // Prisma update: scalar FK yerine relation connect tip-güvenli yol.
    data.match = { connect: { id: u.matchId } };
    changed.push('matchId');
  }

  return changed.length > 0 ? { data, changedFields: changed } : null;
}

interface SchedulePatch {
  data: Prisma.ScheduleUpdateInput;
  changedFields: string[];
}

function buildSchedulePatch(
  sch: {
    title: string;
    team1Name: string | null;
    team2Name: string | null;
    scheduleDate: Date | null;
    scheduleTime: Date | null;
    startTime: Date;
    endTime:   Date;
  },
  u: CascadeMatchUpdate,
): SchedulePatch | null {
  const data: Prisma.ScheduleUpdateInput = {};
  const changed: string[] = [];

  // KO3 title cascade: B3b createFromOpta paritesi (`<home> vs <away>`).
  const newTitle = `${u.homeTeamName} vs ${u.awayTeamName}`;
  if (sch.title !== newTitle) {
    data.title = newTitle;
    changed.push('title');
  }

  if (sch.team1Name !== u.homeTeamName) {
    data.team1Name = u.homeTeamName;
    changed.push('team1Name');
  }

  if (sch.team2Name !== u.awayTeamName) {
    data.team2Name = u.awayTeamName;
    changed.push('team2Name');
  }

  // KO3 canonical date/time: matchDate UTC tarih + saat parçaları.
  if (u.newMatchDate) {
    const newScheduleDate = floorToUtcDate(u.newMatchDate);
    if (!sch.scheduleDate || sch.scheduleDate.getTime() !== newScheduleDate.getTime()) {
      data.scheduleDate = newScheduleDate;
      changed.push('scheduleDate');
    }

    const newScheduleTime = utcTimeOnlyDate(u.newMatchDate);
    if (!sch.scheduleTime || sch.scheduleTime.getTime() !== newScheduleTime.getTime()) {
      data.scheduleTime = newScheduleTime;
      changed.push('scheduleTime');
    }

    // Legacy start_time/end_time placeholder dual-write (B5'e kadar; canonical
    // DEĞİL — sadece NOT NULL doyurma; export/report bunlardan gerçek yayın
    // saatini ÇIKARMASIN). SCHED-B3a paritesi (createBroadcastFlow).
    const newStart = u.newMatchDate;
    const newEnd   = new Date(newStart.getTime() + TWO_HOURS_MS);
    if (sch.startTime.getTime() !== newStart.getTime()) {
      data.startTime = newStart;
      changed.push('startTime');
    }
    if (sch.endTime.getTime() !== newEnd.getTime()) {
      data.endTime = newEnd;
      changed.push('endTime');
    }
  }

  return changed.length > 0 ? { data, changedFields: changed } : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────

/** UTC midnight of given date (Prisma `@db.Date` kolonu ile uyumlu). */
function floorToUtcDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/**
 * UTC time-of-day (1970-01-01 epoch base) — Prisma `@db.Time(6)` kolonu için
 * standart pattern. SCHED-B3a `normalizeTime` paritesi ama Date input.
 */
function utcTimeOnlyDate(d: Date): Date {
  return new Date(Date.UTC(1970, 0, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), 0));
}
