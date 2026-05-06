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
          metadata:        dto.metadata as Prisma.InputJsonValue | undefined,
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
        ...(dto.metadata !== undefined && {
          metadata: dto.metadata === null
            ? Prisma.JsonNull
            : (dto.metadata as Prisma.InputJsonValue),
        }),
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
      const result = await tx.livePlanEntry.updateMany({
        where: { id, version: ifMatchVersion, deletedAt: null },
        data: {
          deletedAt: new Date(),
          version:   { increment: 1 },
        },
      });

      if (result.count !== 1) {
        throw Object.assign(new Error('Live-plan version conflict'), { statusCode: 412 });
      }

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
