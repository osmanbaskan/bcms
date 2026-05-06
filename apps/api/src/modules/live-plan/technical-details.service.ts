import type { FastifyInstance } from 'fastify';
import { Prisma, type LivePlanTechnicalDetail } from '@prisma/client';
import { writeShadowEvent } from '../outbox/outbox.helpers.js';
import { validateLookupFields } from './technical-details.lookup-validation.js';
import type {
  CreateTechnicalDetailsDto,
  UpdateTechnicalDetailsDto,
} from './technical-details.schema.js';

/**
 * Madde 5 M5-B9 (scope lock U1-U12, 2026-05-07): live_plan_technical_details
 * service.
 *
 * Locked invariants:
 * - U2 If-Match own version (PATCH/DELETE).
 * - U6 explicit POST + PATCH (no PUT upsert).
 * - U7 PATCH undefined=no change, null=clear.
 * - U8 entry soft-delete cascades — burada td.delete kendi satırını siler.
 * - U9 lookup FK active/deleted validation on create/update.
 * - U10 compact outbox shadow events (live_plan.technical.{created|updated|deleted}).
 *
 * Audit subject otomatik (Prisma extension): entityType="LivePlanTechnicalDetail".
 */

const SHADOW_AGGREGATE_TYPE = 'LivePlanTechnicalDetail';

export class LivePlanTechnicalDetailService {
  constructor(private readonly app: FastifyInstance) {}

  // ── Get (singleton) — null dönebilir ─────────────────────────────────────
  async getByEntry(entryId: number): Promise<LivePlanTechnicalDetail | null> {
    await this.assertEntryExists(entryId);
    const row = await this.app.prisma.livePlanTechnicalDetail.findUnique({
      where: { livePlanEntryId: entryId },
    });
    if (!row || row.deletedAt !== null) return null;
    return row;
  }

  // ── Create (POST) — 1:1 enforce ──────────────────────────────────────────
  async create(
    entryId: number,
    dto: CreateTechnicalDetailsDto,
  ): Promise<LivePlanTechnicalDetail> {
    await this.assertEntryExists(entryId);

    // U9 lookup validation — pre-tx (read-only).
    const issues = await validateLookupFields(
      this.app.prisma,
      dto as unknown as Record<string, unknown>,
    );
    if (issues.length > 0) {
      throw Object.assign(new Error('Lookup validation failed'), {
        statusCode: 400,
        issues,
      });
    }

    return this.app.prisma.$transaction(async (tx) => {
      let created: LivePlanTechnicalDetail;
      try {
        created = await tx.livePlanTechnicalDetail.create({
          data: {
            livePlanEntryId: entryId,
            ...this.buildScalarPatch(dto),
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw Object.assign(new Error('Technical details already exists for this entry'), {
            statusCode: 409,
          });
        }
        throw err;
      }

      await writeShadowEvent(tx, {
        eventType:     'live_plan.technical.created',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   created.id,
        payload:       { livePlanEntryId: entryId, technicalDetailsId: created.id },
      });

      return created;
    });
  }

  // ── Update (PATCH) — If-Match zorunlu ────────────────────────────────────
  async update(
    entryId: number,
    dto: UpdateTechnicalDetailsDto,
    ifMatchVersion: number,
  ): Promise<LivePlanTechnicalDetail> {
    await this.assertEntryExists(entryId);

    const existing = await this.app.prisma.livePlanTechnicalDetail.findUnique({
      where: { livePlanEntryId: entryId },
    });
    if (!existing || existing.deletedAt !== null) {
      throw Object.assign(new Error('Technical details not found'), { statusCode: 404 });
    }

    this.validateMergedTimes(existing, dto);

    // U9 lookup validation — pre-tx; null/undefined skip.
    const issues = await validateLookupFields(
      this.app.prisma,
      dto as unknown as Record<string, unknown>,
    );
    if (issues.length > 0) {
      throw Object.assign(new Error('Lookup validation failed'), {
        statusCode: 400,
        issues,
      });
    }

    return this.app.prisma.$transaction(async (tx) => {
      const result = await tx.livePlanTechnicalDetail.updateMany({
        where: { id: existing.id, version: ifMatchVersion, deletedAt: null },
        data: {
          ...this.buildScalarPatch(dto),
          version: { increment: 1 },
        },
      });

      if (result.count !== 1) {
        throw Object.assign(new Error('Technical details version conflict'), {
          statusCode: 412,
        });
      }

      const refreshed = await tx.livePlanTechnicalDetail.findUniqueOrThrow({
        where: { id: existing.id },
      });

      await writeShadowEvent(tx, {
        eventType:     'live_plan.technical.updated',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   refreshed.id,
        payload:       {
          livePlanEntryId:    entryId,
          technicalDetailsId: refreshed.id,
          version:            refreshed.version,
        },
      });

      return refreshed;
    });
  }

  // ── Delete (soft) — If-Match zorunlu, sadece kendi satırı ────────────────
  async remove(
    entryId: number,
    ifMatchVersion: number,
  ): Promise<LivePlanTechnicalDetail> {
    await this.assertEntryExists(entryId);

    const existing = await this.app.prisma.livePlanTechnicalDetail.findUnique({
      where: { livePlanEntryId: entryId },
    });
    if (!existing || existing.deletedAt !== null) {
      throw Object.assign(new Error('Technical details not found'), { statusCode: 404 });
    }

    return this.app.prisma.$transaction(async (tx) => {
      const result = await tx.livePlanTechnicalDetail.updateMany({
        where: { id: existing.id, version: ifMatchVersion, deletedAt: null },
        data: {
          deletedAt: new Date(),
          version:   { increment: 1 },
        },
      });

      if (result.count !== 1) {
        throw Object.assign(new Error('Technical details version conflict'), {
          statusCode: 412,
        });
      }

      const refreshed = await tx.livePlanTechnicalDetail.findUniqueOrThrow({
        where: { id: existing.id },
      });

      await writeShadowEvent(tx, {
        eventType:     'live_plan.technical.deleted',
        aggregateType: SHADOW_AGGREGATE_TYPE,
        aggregateId:   refreshed.id,
        payload:       { livePlanEntryId: entryId, technicalDetailsId: refreshed.id },
      });

      return refreshed;
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

  /**
   * U7: undefined alanları skip; null alanlar kolonu temizler. Date string'leri
   * Date'e çevrilir. Hem create hem update path'leri tarafından spread edilir;
   * dönüş `Record<string, unknown>` — Prisma input tip darlığını caller spread
   * konumunda çözer.
   */
  private buildScalarPatch(dto: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue;
      if (k === 'plannedStartTime' || k === 'plannedEndTime') {
        out[k] = v === null ? null : new Date(v as string);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private validateMergedTimes(
    existing: LivePlanTechnicalDetail,
    dto: UpdateTechnicalDetailsDto,
  ): void {
    const startProvided = dto.plannedStartTime !== undefined;
    const endProvided   = dto.plannedEndTime   !== undefined;
    if (!startProvided && !endProvided) return;

    const mergedStart = startProvided
      ? (dto.plannedStartTime === null ? null : new Date(dto.plannedStartTime!))
      : existing.plannedStartTime;
    const mergedEnd = endProvided
      ? (dto.plannedEndTime === null ? null : new Date(dto.plannedEndTime!))
      : existing.plannedEndTime;

    if (mergedStart && mergedEnd && mergedEnd <= mergedStart) {
      throw Object.assign(
        new Error('plannedEndTime, plannedStartTime\'tan sonra olmalı'),
        { statusCode: 400 },
      );
    }
  }
}
