import type { FastifyInstance } from 'fastify';
import { Prisma, type LivePlanTransmissionSegment } from '@prisma/client';
import { writeShadowEvent } from '../outbox/outbox.helpers.js';
import type {
  CreateSegmentDto,
  ListSegmentQuery,
  UpdateSegmentDto,
} from './segments.schema.js';

/**
 * Madde 5 M5-B9 (scope lock U1-U12, 2026-05-07): live_plan_transmission_segments
 * service.
 *
 * Locked invariants:
 * - U3 version YOK V1 (last-write-wins).
 * - U6 explicit POST + PATCH.
 * - U7 PATCH undefined=no change; description null=clear.
 * - U8 entry hard-delete cascades (FK `onDelete: Cascade`); standalone segment
 *   delete kendi satırını hard-delete eder (cleanup 2026-05-07).
 * - U10 compact outbox shadow events (live_plan.segment.{created|updated|deleted}).
 *
 * Audit subject otomatik: entityType="LivePlanTransmissionSegment".
 */

const SHADOW_AGGREGATE_TYPE = 'LivePlanTransmissionSegment';

export class LivePlanTransmissionSegmentService {
  constructor(private readonly app: FastifyInstance) {}

  // ── List (entry'ye göre) ─────────────────────────────────────────────────
  async list(
    entryId: number,
    query: ListSegmentQuery,
  ): Promise<LivePlanTransmissionSegment[]> {
    await this.assertEntryExists(entryId);
    return this.app.prisma.livePlanTransmissionSegment.findMany({
      where: {
        livePlanEntryId: entryId,
        deletedAt:       null,
        ...(query.feedRole ? { feedRole: query.feedRole } : {}),
        ...(query.kind     ? { kind:     query.kind     } : {}),
      },
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
    });
  }

  // ── Create (POST) ────────────────────────────────────────────────────────
  async create(
    entryId: number,
    dto: CreateSegmentDto,
  ): Promise<LivePlanTransmissionSegment> {
    await this.assertEntryExists(entryId);

    return this.app.prisma.$transaction(async (tx) => {
      const created = await tx.livePlanTransmissionSegment.create({
        data: {
          livePlanEntryId: entryId,
          feedRole:        dto.feedRole,
          kind:            dto.kind,
          startTime:       new Date(dto.startTime),
          endTime:         new Date(dto.endTime),
          description:     dto.description,
        },
      });

      await writeShadowEvent(tx, {
        eventType:     'live_plan.segment.created',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   created.id,
        payload:       {
          livePlanEntryId: entryId,
          segmentId:       created.id,
          feedRole:        created.feedRole,
          kind:            created.kind,
        },
      });

      return created;
    });
  }

  // ── Update (PATCH) — version yok V1, last-write-wins ─────────────────────
  async update(
    entryId: number,
    segmentId: number,
    dto: UpdateSegmentDto,
  ): Promise<LivePlanTransmissionSegment> {
    const existing = await this.fetchActiveSegment(entryId, segmentId);

    this.validateMergedTimes(existing, dto);

    return this.app.prisma.$transaction(async (tx) => {
      const updated = await tx.livePlanTransmissionSegment.update({
        where: { id: segmentId },
        data:  this.buildPatch(dto),
      });

      await writeShadowEvent(tx, {
        eventType:     'live_plan.segment.updated',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   updated.id,
        payload:       {
          livePlanEntryId: entryId,
          segmentId:       updated.id,
          feedRole:        updated.feedRole,
          kind:            updated.kind,
        },
      });

      return updated;
    });
  }

  // ── Delete (HARD) ────────────────────────────────────────────────────────
  // Hard-delete cleanup (2026-05-07): silindiğinde DB'de row kalmaz.
  // List sonrası segment yok; aynı entry'ye yeni segment eklenebilir.
  async remove(
    entryId: number,
    segmentId: number,
  ): Promise<LivePlanTransmissionSegment> {
    const existing = await this.fetchActiveSegment(entryId, segmentId);

    return this.app.prisma.$transaction(async (tx) => {
      // Shadow event önce.
      await writeShadowEvent(tx, {
        eventType:     'live_plan.segment.deleted',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   existing.id,
        payload:       { livePlanEntryId: entryId, segmentId: existing.id },
      });

      await tx.livePlanTransmissionSegment.delete({ where: { id: existing.id } });
      return existing;
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  private async assertEntryExists(entryId: number): Promise<void> {
    const entry = await this.app.prisma.livePlanEntry.findUnique({
      where: { id: entryId },
    });
    if (!entry || entry.deletedAt !== null) {
      throw Object.assign(new Error('Live-plan entry not found'), { statusCode: 404 });
    }
  }

  private async fetchActiveSegment(
    entryId: number,
    segmentId: number,
  ): Promise<LivePlanTransmissionSegment> {
    await this.assertEntryExists(entryId);
    const seg = await this.app.prisma.livePlanTransmissionSegment.findUnique({
      where: { id: segmentId },
    });
    if (!seg || seg.deletedAt !== null || seg.livePlanEntryId !== entryId) {
      throw Object.assign(new Error('Segment not found'), { statusCode: 404 });
    }
    return seg;
  }

  private buildPatch(
    dto: UpdateSegmentDto,
  ): Prisma.LivePlanTransmissionSegmentUpdateInput {
    const out: Prisma.LivePlanTransmissionSegmentUpdateInput = {};
    if (dto.feedRole    !== undefined) out.feedRole    = dto.feedRole;
    if (dto.kind        !== undefined) out.kind        = dto.kind;
    if (dto.startTime   !== undefined) out.startTime   = new Date(dto.startTime);
    if (dto.endTime     !== undefined) out.endTime     = new Date(dto.endTime);
    if (dto.description !== undefined) out.description = dto.description; // null OK
    return out;
  }

  private validateMergedTimes(
    existing: LivePlanTransmissionSegment,
    dto: UpdateSegmentDto,
  ): void {
    const startProvided = dto.startTime !== undefined;
    const endProvided   = dto.endTime   !== undefined;
    if (!startProvided && !endProvided) return;

    const mergedStart = startProvided ? new Date(dto.startTime!) : existing.startTime;
    const mergedEnd   = endProvided   ? new Date(dto.endTime!)   : existing.endTime;

    if (mergedEnd <= mergedStart) {
      throw Object.assign(
        new Error('endTime, startTime\'tan sonra olmalı'),
        { statusCode: 400 },
      );
    }
  }
}
