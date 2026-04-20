import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import type { CreateScheduleDto, UpdateScheduleDto, ScheduleQuery } from './schedule.schema.js';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { writeAuditLog } from '../../middleware/audit.js';

export class ScheduleService {
  constructor(private readonly app: FastifyInstance) {}

  async findAll(query: ScheduleQuery) {
    const { channel, from, to, status, source, page, pageSize } = query;
    const skip = (page - 1) * pageSize;

    const where = {
      ...(channel  && { channelId: channel }),
      ...(status   && { status }),
      ...(from && { endTime:   { gte: new Date(from) } }),
      ...(to   && { startTime: { lte: new Date(to)   } }),
      ...(source === 'manual' && { createdBy: { not: 'bxf-importer' } }),
      ...(source === 'bxf'    && { createdBy: 'bxf-importer' }),
    };

    const [data, total] = await Promise.all([
      this.app.prisma.schedule.findMany({
        where,
        skip,
        take: pageSize,
        include: { channel: true },
        orderBy: { startTime: 'asc' },
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

    // ── Conflict check on time change (kanal yoksa atla) ───────────────────────
    if ((dto.startTime || dto.endTime) && existing.channelId != null) {
      const start = dto.startTime ? new Date(dto.startTime) : existing.startTime;
      const end   = dto.endTime   ? new Date(dto.endTime)   : existing.endTime;
      const conflicts = await this.checkConflicts(existing.channelId, start, end, id);
      if (conflicts.length > 0) {
        const err = Object.assign(new Error('Schedule conflict detected'), { statusCode: 409, conflicts });
        throw err;
      }
    }

    const updated = await this.app.prisma.schedule.update({
      where: { id },
      data: {
        ...(dto.startTime && { startTime: new Date(dto.startTime) }),
        ...(dto.endTime   && { endTime:   new Date(dto.endTime) }),
        ...(dto.title     && { title:     dto.title }),
        ...(dto.status    && { status:    dto.status }),
        ...(dto.contentId !== undefined && { contentId: dto.contentId }),
        ...(dto.metadata  && { metadata: dto.metadata as Prisma.InputJsonValue }),
        version: { increment: 1 },
      },
      include: { channel: true },
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
