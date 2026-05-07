import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma, type LivePlanEntry } from '@prisma/client';
import { writeShadowEvent } from '../outbox/outbox.helpers.js';
import type {
  CreateLivePlanDto,
  ListLivePlanQuery,
  UpdateLivePlanDto,
} from './live-plan.schema.js';

/**
 * Madde 5 M5-B2 (decision §3.3): live-plan service.
 *
 * Locked invariants:
 * - K9 If-Match zorunlu (Schedule'dan bilinçli ayrışma).
 *   Schedule investigation showed If-Match is optional there. Live-plan
 *   intentionally requires it because this is a new API surface and K3
 *   optimistic locking must be enforced.
 * - K10 audit subject otomatik (Prisma model adından entityType="LivePlanEntry").
 * - K11 soft delete only (deletedAt = NOW + version++).
 * - K12 outbox shadow events: live_plan.created/updated/deleted; routing dışı
 *   (poller pick etmez — Phase 2 status='published').
 * - K14 response shape: Schedule pattern (entity DTO; list { items, total, page, pageSize }).
 *
 * Out of scope: route/UI, ingest FK, eski schedules cleanup, frontend.
 */

const SHADOW_AGGREGATE_TYPE = 'LivePlanEntry';

export interface ListLivePlanResult {
  items:    LivePlanEntry[];
  total:    number;
  page:     number;
  pageSize: number;
}

export class LivePlanService {
  constructor(private readonly app: FastifyInstance) {}

  // ── List ───────────────────────────────────────────────────────────────────
  async list(query: ListLivePlanQuery): Promise<ListLivePlanResult> {
    const where: Prisma.LivePlanEntryWhereInput = {
      deletedAt: null, // K11: soft-deleted exclude
      ...(query.status?.length ? { status: { in: query.status } } : {}),
      ...(query.matchId !== undefined ? { matchId: query.matchId } : {}),
      ...(query.optaMatchId !== undefined ? { optaMatchId: query.optaMatchId } : {}),
      ...this.buildDateRangeWhere(query.from, query.to),
    };

    const [items, total] = await Promise.all([
      this.app.prisma.livePlanEntry.findMany({
        where,
        orderBy: { eventStartTime: 'asc' },
        skip:  (query.page - 1) * query.pageSize,
        take:  query.pageSize,
      }),
      this.app.prisma.livePlanEntry.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // ── Detail ─────────────────────────────────────────────────────────────────
  async getById(id: number): Promise<LivePlanEntry> {
    const row = await this.app.prisma.livePlanEntry.findUnique({ where: { id } });
    if (!row || row.deletedAt !== null) {
      throw Object.assign(new Error('Live-plan not found'), { statusCode: 404 });
    }
    return row;
  }

  // ── Create ─────────────────────────────────────────────────────────────────
  async create(dto: CreateLivePlanDto, request: FastifyRequest): Promise<LivePlanEntry> {
    const user = (request.user as { preferred_username?: string })?.preferred_username ?? null;

    return this.app.prisma.$transaction(async (tx) => {
      const created = await tx.livePlanEntry.create({
        data: {
          title:           dto.title,
          eventStartTime:  new Date(dto.eventStartTime),
          eventEndTime:    new Date(dto.eventEndTime),
          matchId:         dto.matchId,
          optaMatchId:     dto.optaMatchId,
          status:          dto.status,
          operationNotes:  dto.operationNotes,
          // K-B3.20 follow-up: team_1/2_name canonical alanlar (SCHED-B3a
          // schedule create entry'den kopyalar).
          team1Name:       dto.team1Name,
          team2Name:       dto.team2Name,
          // metadata kolonu M5-B4'te DROP edildi (K15.1).
          createdBy:       user,
        },
      });

      // K12 outbox shadow (routing dışı; poller Phase 2'de pick etmez).
      await writeShadowEvent(tx, {
        eventType:     'live_plan.created',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   created.id,
        payload:       { livePlanEntryId: created.id },
      });

      return created;
    });
  }

  // ── Update (PATCH) — K9 If-Match zorunlu, version check ────────────────────
  async update(
    id: number,
    dto: UpdateLivePlanDto,
    ifMatchVersion: number,
    _request: FastifyRequest,
  ): Promise<LivePlanEntry> {
    // 1. Existence + soft-deleted gizleme.
    const existing = await this.app.prisma.livePlanEntry.findUnique({ where: { id } });
    if (!existing || existing.deletedAt !== null) {
      throw Object.assign(new Error('Live-plan not found'), { statusCode: 404 });
    }

    // 2. Service-level merge-aware date check (sadece biri gönderildiyse).
    this.validateMergedDates(existing, dto);

    // 3. Tx içi update + outbox shadow.
    return this.app.prisma.$transaction(async (tx) => {
      const data: Prisma.LivePlanEntryUpdateInput = {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.eventStartTime !== undefined && { eventStartTime: new Date(dto.eventStartTime) }),
        ...(dto.eventEndTime !== undefined && { eventEndTime: new Date(dto.eventEndTime) }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.matchId !== undefined && { matchId: dto.matchId }),
        ...(dto.optaMatchId !== undefined && { optaMatchId: dto.optaMatchId }),
        ...(dto.operationNotes !== undefined && { operationNotes: dto.operationNotes }),
        // K-B3.20 follow-up: team_1/2 update (null → temizle).
        ...(dto.team1Name !== undefined && { team1Name: dto.team1Name }),
        ...(dto.team2Name !== undefined && { team2Name: dto.team2Name }),
        // metadata kolonu M5-B4'te DROP edildi (K15.1).
        version: { increment: 1 },
      };

      const result = await tx.livePlanEntry.updateMany({
        where: { id, version: ifMatchVersion, deletedAt: null },
        data,
      });

      if (result.count !== 1) {
        throw Object.assign(new Error('Live-plan version conflict'), { statusCode: 412 });
      }

      const refreshed = await tx.livePlanEntry.findUniqueOrThrow({ where: { id } });

      await writeShadowEvent(tx, {
        eventType:     'live_plan.updated',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   refreshed.id,
        payload:       { livePlanEntryId: refreshed.id },
      });

      return refreshed;
    });
  }

  // ── Delete (soft) — K9 If-Match zorunlu, version check ─────────────────────
  async remove(
    id: number,
    ifMatchVersion: number,
    _request: FastifyRequest,
  ): Promise<LivePlanEntry> {
    const existing = await this.app.prisma.livePlanEntry.findUnique({ where: { id } });
    if (!existing || existing.deletedAt !== null) {
      throw Object.assign(new Error('Live-plan not found'), { statusCode: 404 });
    }

    return this.app.prisma.$transaction(async (tx) => {
      const now = new Date();

      const result = await tx.livePlanEntry.updateMany({
        where: { id, version: ifMatchVersion, deletedAt: null },
        data: {
          deletedAt: now,
          version:   { increment: 1 },
        },
      });

      if (result.count !== 1) {
        throw Object.assign(new Error('Live-plan version conflict'), { statusCode: 412 });
      }

      // M5-B9 U8: entry soft-delete aktif technical_details + segments'i de
      // soft-delete eder (DB FK CASCADE sadece hard-delete'te tetiklenir).
      // Tek tx; child shadow events parent silme bağlamını taşıyamaz, parent
      // event yeterli (consumer parent.deleted alır → child orphan inferred).
      await tx.livePlanTechnicalDetail.updateMany({
        where: { livePlanEntryId: id, deletedAt: null },
        data:  { deletedAt: now, version: { increment: 1 } },
      });
      await tx.livePlanTransmissionSegment.updateMany({
        where: { livePlanEntryId: id, deletedAt: null },
        data:  { deletedAt: now },
      });

      const refreshed = await tx.livePlanEntry.findUniqueOrThrow({ where: { id } });

      await writeShadowEvent(tx, {
        eventType:     'live_plan.deleted',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   refreshed.id,
        payload:       { livePlanEntryId: refreshed.id },
      });

      return refreshed;
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private buildDateRangeWhere(
    from: string | undefined,
    to:   string | undefined,
  ): Prisma.LivePlanEntryWhereInput {
    if (!from && !to) return {};
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = new Date(from);
    if (to)   range.lt  = new Date(to); // half-open (decision §3.3 K7)
    return { eventStartTime: range };
  }

  private validateMergedDates(existing: LivePlanEntry, dto: UpdateLivePlanDto): void {
    // K8 service-level merge-aware: sadece bir tarih gönderildiyse existing ile
    // karşılaştır. İkisi birlikte gönderildiyse Zod refine zaten kapsadı.
    const startProvided = dto.eventStartTime !== undefined;
    const endProvided   = dto.eventEndTime   !== undefined;

    if (startProvided === endProvided) return; // ikisi yoksa veya ikisi varsa skip

    const mergedStart = startProvided ? new Date(dto.eventStartTime!) : existing.eventStartTime;
    const mergedEnd   = endProvided   ? new Date(dto.eventEndTime!)   : existing.eventEndTime;

    if (mergedEnd <= mergedStart) {
      throw Object.assign(
        new Error('eventEndTime, eventStartTime\'tan sonra olmalı'),
        { statusCode: 400 },
      );
    }
  }
}
