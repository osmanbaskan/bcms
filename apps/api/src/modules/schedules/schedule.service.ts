import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import type { CreateScheduleDto, UpdateScheduleDto, ScheduleQuery } from './schedule.schema.js';
import { QUEUES } from '../../plugins/rabbitmq.js';

export const LIVE_PLAN_SOURCE = 'live-plan';
const SERIALIZABLE_RETRIES = 3;

function stringDimension(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[key];
  const text = String(value ?? '').trim();
  return text || null;
}

function weekDimension(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = Number((metadata as Record<string, unknown>)['weekNumber']);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function reportDimensions(metadata: unknown) {
  return {
    reportLeague:     stringDimension(metadata, 'league'),
    reportSeason:     stringDimension(metadata, 'season'),
    reportWeekNumber: weekDimension(metadata),
  };
}

function isSerializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

async function withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === SERIALIZABLE_RETRIES) throw error;
    }
  }
  throw new Error('Serializable transaction failed');
}

/**
 * ÖNEMLİ-API-1.2.7 fix (2026-05-04): conflict response info disclosure.
 * Eski hâlinde caller'a `{ id, channelId, startTime, endTime, title, status }`
 * dönülüyordu — başka kullanıcının schedule başlığı sızabiliyordu. Artık
 * minimum bilgi dönüyor: kaç çakışma, zaman aralığı, çakışan ID listesi.
 * Title ve status iç bilgi olarak kalıyor.
 */
type RawConflict = { id: number; channelId: number | null; startTime: Date; endTime: Date; title: string; status: string };
function sanitizeConflicts(conflicts: RawConflict[]) {
  return {
    count: conflicts.length,
    conflictIds: conflicts.map((c) => c.id),
    timeWindow: conflicts.length > 0 ? {
      earliestStart: conflicts.reduce((acc, c) => (c.startTime < acc ? c.startTime : acc), conflicts[0].startTime).toISOString(),
      latestEnd:     conflicts.reduce((acc, c) => (c.endTime   > acc ? c.endTime   : acc), conflicts[0].endTime).toISOString(),
    } : null,
  };
}

export class ScheduleService {
  constructor(private readonly app: FastifyInstance) {}

  async findAll(query: ScheduleQuery) {
    const { channel, from, to, status, source, usage, league, season, week, page, pageSize } = query;
    const skip = (page - 1) * pageSize;

    const where: Prisma.ScheduleWhereInput = {
      ...(channel  && { channelId: channel }),
      ...(status   && { status }),
      ...(from && { endTime:   { gte: new Date(from) } }),
      ...(to   && { startTime: { lte: new Date(to)   } }),
      ...(source === 'manual' && { createdBy: { not: 'bxf-importer' } }),
      ...(source === 'bxf'    && { createdBy: 'bxf-importer' }),
      ...(usage === 'live-plan' && { usageScope: 'live-plan' }),
      ...(usage === 'broadcast' && { usageScope: 'broadcast' }),
      ...(league && { reportLeague: league }),
      ...(season && { reportSeason: season }),
      ...(week && { reportWeekNumber: week }),
    };

    const [data, total] = await Promise.all([
      this.app.prisma.schedule.findMany({
        where,
        include: { channel: true },
        orderBy: { startTime: 'asc' },
        skip,
        take: pageSize,
      }),
      this.app.prisma.schedule.count({ where }),
    ]);

    const enriched = await this.attachIngestPorts(data);

    return {
      data: enriched,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async findById(id: number) {
    const schedule = await this.app.prisma.schedule.findUnique({
      where: { id },
      include: { channel: true, bookings: true, incidents: true },
    });
    if (!schedule) {
      const err = Object.assign(new Error('Schedule not found'), { statusCode: 404 });
      throw err;
    }
    const [enriched] = await this.attachIngestPorts([schedule]);
    return enriched;
  }

  /**
   * Canlı yayın schedule'larına ingest_plan_items'tan port atamalarını
   * read-only olarak ekler. Tek batch query — N+1 yok. Live olmayan
   * schedule'lar dokunulmaz; recordingPort/backupRecordingPort null gelir.
   * Edit kanalı sadece Ingest sekmesinden.
   */
  private async attachIngestPorts<T extends { id: number; usageScope: string }>(
    schedules: T[],
  ): Promise<Array<T & { recordingPort: string | null; backupRecordingPort: string | null }>> {
    const liveIds = schedules
      .filter((s) => s.usageScope === 'live-plan')
      .map((s) => s.id);

    if (liveIds.length === 0) {
      return schedules.map((s) => ({ ...s, recordingPort: null, backupRecordingPort: null }));
    }

    const sourceKeys = liveIds.map((id) => `live:${id}`);
    const planItems = await this.app.prisma.ingestPlanItem.findMany({
      where: { sourceKey: { in: sourceKeys } },
      select: {
        sourceKey: true,
        ports: { select: { portName: true, role: true } },
      },
    });

    const portsByScheduleId = new Map<number, { primary: string | null; backup: string | null }>();
    for (const item of planItems) {
      const idStr = item.sourceKey.replace(/^live:/, '');
      const id = Number(idStr);
      if (!Number.isFinite(id)) continue;
      portsByScheduleId.set(id, {
        primary: item.ports.find((p) => p.role === 'primary')?.portName ?? null,
        backup:  item.ports.find((p) => p.role === 'backup')?.portName ?? null,
      });
    }

    return schedules.map((s) => {
      const ports = portsByScheduleId.get(s.id);
      return {
        ...s,
        recordingPort: ports?.primary ?? null,
        backupRecordingPort: ports?.backup ?? null,
      };
    });
  }

  async create(dto: CreateScheduleDto, request: FastifyRequest) {
    const user = (request.user as { preferred_username: string }).preferred_username;

    const schedule = await withSerializableRetry(() => this.app.prisma.$transaction(async (tx) => {
      // ── Conflict check (kanal seçilmemişse atla) ────────────────────────────────
      if (dto.channelId != null) {
        const conflicts = await tx.schedule.findMany({
          where: {
            channelId: dto.channelId,
            status: { notIn: ['CANCELLED'] },
            AND: [
              { startTime: { lt: new Date(dto.endTime) } },
              { endTime:   { gt: new Date(dto.startTime) } },
            ],
          },
          select: { id: true, channelId: true, startTime: true, endTime: true, title: true, status: true },
        });
        if (conflicts.length > 0) {
          const err = Object.assign(
            new Error('Schedule conflict detected'),
            { statusCode: 409, conflicts: sanitizeConflicts(conflicts) },
          );
          throw err;
        }
      }

      // Madde 3 PR-3A: dual-write — optaMatchId hem kolon hem metadata.optaMatchId.
      // Kaynak: dto.optaMatchId (yeni param) öncelik; eski caller'lar metadata.optaMatchId
      // gönderiyorsa onu da kabul (transition).
      const incomingOpta =
        dto.optaMatchId
        ?? (typeof dto.metadata === 'object' && dto.metadata !== null
            ? ((dto.metadata as Record<string, unknown>).optaMatchId as string | undefined)
            : undefined);
      const mergedMetadata = (() => {
        if (incomingOpta && (!dto.metadata || typeof dto.metadata !== 'object')) {
          return { optaMatchId: incomingOpta };
        }
        if (incomingOpta && dto.metadata) {
          return { ...(dto.metadata as Record<string, unknown>), optaMatchId: incomingOpta };
        }
        return dto.metadata;
      })();

      return tx.schedule.create({
        data: {
          channelId:       dto.channelId,
          startTime:       new Date(dto.startTime),
          endTime:         new Date(dto.endTime),
          title:           dto.title,
          contentId:       dto.contentId,
          broadcastTypeId: dto.broadcastTypeId,
          usageScope:      dto.usageScope,
          optaMatchId:     incomingOpta ?? null,
          ...reportDimensions(mergedMetadata),
          metadata:        mergedMetadata as Prisma.InputJsonValue,
          createdBy:       user,
        },
        include: { channel: true },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));

    await this.app.rabbitmq.publish(QUEUES.SCHEDULE_CREATED, {
      scheduleId: schedule.id,
      channelId:  schedule.channelId,
      startTime:  schedule.startTime,
      title:      schedule.title,
    });

    return schedule;
  }

  async update(id: number, dto: UpdateScheduleDto, ifMatchVersion: number | undefined, request: FastifyRequest) {
    const existing = await this.findById(id);

    // ── Optimistic locking ──────────────────────────────────────────────────────
    if (ifMatchVersion !== undefined && existing.version !== ifMatchVersion) {
      const err = Object.assign(
        new Error(`Version conflict: expected ${ifMatchVersion}, got ${existing.version}`),
        { statusCode: 412 },
      );
      throw err;
    }

    // Madde 3 PR-3A: 3-state optaMatchId semantik (undefined/null/string).
    // Aynı zamanda metadata.optaMatchId paralel maintain — dual-write transition.
    //   undefined → kolon dokunulmaz; metadata da değiştirilmez (eğer dto.metadata yoksa).
    //   null      → kolon NULL; metadata.optaMatchId key kaldırılır.
    //   string    → kolon set; metadata.optaMatchId paralel set.
    const optaTouched = dto.optaMatchId !== undefined;
    const optaValue = dto.optaMatchId; // null | string | undefined

    // Existing metadata (mevcut kayıttan) ile DTO metadata merge edilir; sonra
    // optaMatchId 3-state'e göre üzerine yazılır/silinir.
    const baseMetadata =
      dto.metadata !== undefined
        ? (dto.metadata as Record<string, unknown>)
        : (typeof existing.metadata === 'object' && existing.metadata !== null
            ? { ...(existing.metadata as Record<string, unknown>) }
            : undefined);

    let writeMetadata: Record<string, unknown> | undefined = baseMetadata
      ? { ...baseMetadata }
      : undefined;

    if (optaTouched) {
      writeMetadata = writeMetadata ?? {};
      if (optaValue === null) {
        delete writeMetadata.optaMatchId;
      } else {
        writeMetadata.optaMatchId = optaValue;
      }
      // Tutarlılık: eğer metadata sadece optaMatchId silinmesi sonucu boş kalıyorsa
      // null bırakmak yerine boş objeye izin ver — caller'ın isteğini bozma.
    }

    const metadataPayload =
      dto.metadata !== undefined || optaTouched
        ? (writeMetadata as Prisma.InputJsonValue)
        : undefined;

    const data: Prisma.ScheduleUpdateManyMutationInput = {
      ...(dto.channelId !== undefined && { channelId: dto.channelId }),
      ...(dto.startTime && { startTime: new Date(dto.startTime) }),
      ...(dto.endTime   && { endTime:   new Date(dto.endTime) }),
      ...(dto.title     && { title:     dto.title }),
      ...(dto.status    && { status:    dto.status }),
      ...(dto.contentId !== undefined && { contentId: dto.contentId }),
      ...(dto.usageScope !== undefined && { usageScope: dto.usageScope }),
      ...(metadataPayload !== undefined && { ...reportDimensions(metadataPayload) }),
      ...(metadataPayload !== undefined && { metadata: metadataPayload }),
      ...(optaTouched && { optaMatchId: optaValue ?? null }),
      version: { increment: 1 },
    };

    const updated = await withSerializableRetry(() => this.app.prisma.$transaction(async (tx) => {
      // ── Conflict check on time/channel change (kanal yoksa atla) ───────────────
      const targetChannelId = dto.channelId !== undefined ? dto.channelId : existing.channelId;
      if ((dto.startTime || dto.endTime || dto.channelId !== undefined) && targetChannelId != null) {
        const start = dto.startTime ? new Date(dto.startTime) : existing.startTime;
        const end   = dto.endTime   ? new Date(dto.endTime)   : existing.endTime;
        const conflicts = await tx.schedule.findMany({
          where: {
            channelId: targetChannelId,
            id: { not: id },
            status: { notIn: ['CANCELLED'] },
            AND: [
              { startTime: { lt: end } },
              { endTime:   { gt: start } },
            ],
          },
          select: { id: true, channelId: true, startTime: true, endTime: true, title: true, status: true },
        });
        if (conflicts.length > 0) {
          const err = Object.assign(new Error('Schedule conflict detected'), { statusCode: 409, conflicts: sanitizeConflicts(conflicts) });
          throw err;
        }
      }

      const result = await tx.schedule.updateMany({
        where: {
          id,
          ...(ifMatchVersion !== undefined && { version: ifMatchVersion }),
        },
        data,
      });

      if (result.count !== 1) {
        throw Object.assign(new Error('Schedule version conflict'), { statusCode: ifMatchVersion !== undefined ? 412 : 404 });
      }

      return tx.schedule.findUniqueOrThrow({
        where: { id },
        include: { channel: true },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));

    await this.app.rabbitmq.publish(QUEUES.SCHEDULE_UPDATED, {
      scheduleId: updated.id,
      changes:    dto,
    });

    return updated;
  }

  async remove(id: number) {
    await this.findById(id);
    await this.app.prisma.schedule.delete({ where: { id } });
  }

}
