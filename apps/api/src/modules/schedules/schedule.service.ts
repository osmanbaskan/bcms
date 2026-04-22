import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import type { CreateScheduleDto, UpdateScheduleDto, ScheduleQuery } from './schedule.schema.js';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { writeAuditLog } from '../../middleware/audit.js';

export const LIVE_PLAN_SOURCE = 'live-plan';

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

    return {
      data,
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
    return schedule;
  }

  async create(dto: CreateScheduleDto, request: FastifyRequest) {
    const user = (request.user as { preferred_username: string }).preferred_username;

    // ── Conflict check (kanal seçilmemişse atla) ────────────────────────────────
    if (dto.channelId != null) {
      const conflicts = await this.checkConflicts(
        dto.channelId,
        new Date(dto.startTime),
        new Date(dto.endTime),
      );
      if (conflicts.length > 0) {
        const err = Object.assign(
          new Error('Schedule conflict detected'),
          { statusCode: 409, conflicts },
        );
        throw err;
      }
    }

    const schedule = await this.app.prisma.schedule.create({
      data: {
        channelId:       dto.channelId,
        startTime:       new Date(dto.startTime),
        endTime:         new Date(dto.endTime),
        title:           dto.title,
        contentId:       dto.contentId,
        broadcastTypeId: dto.broadcastTypeId,
        usageScope:      dto.usageScope,
        ...reportDimensions(dto.metadata),
        metadata:        dto.metadata as Prisma.InputJsonValue,
        createdBy:       user,
      },
      include: { channel: true },
    });

    // ── Audit + Message ─────────────────────────────────────────────────────────
    await writeAuditLog(this.app, {
      entityType: 'Schedule',
      entityId:   schedule.id,
      action:     'CREATE',
      after:      schedule,
      request,
    });

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

    // ── Conflict check on time/channel change (kanal yoksa atla) ───────────────
    const targetChannelId = dto.channelId !== undefined ? dto.channelId : existing.channelId;
    if ((dto.startTime || dto.endTime || dto.channelId !== undefined) && targetChannelId != null) {
      const start = dto.startTime ? new Date(dto.startTime) : existing.startTime;
      const end   = dto.endTime   ? new Date(dto.endTime)   : existing.endTime;
      const conflicts = await this.checkConflicts(targetChannelId, start, end, id);
      if (conflicts.length > 0) {
        const err = Object.assign(new Error('Schedule conflict detected'), { statusCode: 409, conflicts });
        throw err;
      }
    }

    const data: Prisma.ScheduleUpdateManyMutationInput = {
      ...(dto.channelId !== undefined && { channelId: dto.channelId }),
      ...(dto.startTime && { startTime: new Date(dto.startTime) }),
      ...(dto.endTime   && { endTime:   new Date(dto.endTime) }),
      ...(dto.title     && { title:     dto.title }),
      ...(dto.status    && { status:    dto.status }),
      ...(dto.contentId !== undefined && { contentId: dto.contentId }),
      ...(dto.usageScope !== undefined && { usageScope: dto.usageScope }),
      ...(dto.metadata && { ...reportDimensions(dto.metadata) }),
      ...(dto.metadata  && { metadata: dto.metadata as Prisma.InputJsonValue }),
      version: { increment: 1 },
    };

    const updated = await this.app.prisma.$transaction(async (tx) => {
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
    });

    await writeAuditLog(this.app, {
      entityType: 'Schedule',
      entityId:   id,
      action:     'UPDATE',
      before:     existing,
      after:      updated,
      request,
    });

    await this.app.rabbitmq.publish(QUEUES.SCHEDULE_UPDATED, {
      scheduleId: updated.id,
      changes:    dto,
    });

    return updated;
  }

  async remove(id: number, request: FastifyRequest) {
    const existing = await this.findById(id);

    await this.app.prisma.schedule.delete({ where: { id } });

    await writeAuditLog(this.app, {
      entityType: 'Schedule',
      entityId:   id,
      action:     'DELETE',
      before:     existing,
      request,
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────────
  private async checkConflicts(
    channelId: number,
    start: Date,
    end: Date,
    excludeId?: number,
  ) {
    return this.app.prisma.schedule.findMany({
      where: {
        channelId,
        id: excludeId ? { not: excludeId } : undefined,
        status: { notIn: ['CANCELLED'] },
        AND: [
          { startTime: { lt: end } },
          { endTime:   { gt: start } },
        ],
      },
      select: { id: true, channelId: true, startTime: true, endTime: true, title: true, status: true },
    });
  }

}
