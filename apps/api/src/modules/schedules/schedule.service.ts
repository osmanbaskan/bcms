import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import type { CreateScheduleDto, UpdateScheduleDto, ScheduleQuery } from './schedule.schema.js';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { writeAuditLog } from '../../middleware/audit.js';

export const LIVE_PLAN_SOURCE = 'live-plan';
export const LIVE_PLAN_DB_USAGE_SCOPE = 'live-plan';

export class ScheduleService {
  constructor(private readonly app: FastifyInstance) {}

  async findAll(query: ScheduleQuery) {
    const { channel, from, to, status, source, usage, page, pageSize } = query;
    const skip = (page - 1) * pageSize;

    const where: Prisma.ScheduleWhereInput = {
      ...(channel  && { channelId: channel }),
      ...(status   && { status }),
      ...(from && { endTime:   { gte: new Date(from) } }),
      ...(to   && { startTime: { lte: new Date(to)   } }),
      ...(source === 'manual' && { createdBy: { not: 'bxf-importer' } }),
      ...(source === 'bxf'    && { createdBy: 'bxf-importer' }),
    };

    const whereSql = this.buildUsageAwareWhereSql({ channel, from, to, status, source, usage });
    const rawIds = await this.app.prisma.$queryRaw<Array<{ id: number }>>`
      SELECT "id"
      FROM "schedules"
      WHERE ${whereSql}
      ORDER BY "start_time" ASC
      LIMIT ${pageSize} OFFSET ${skip}
    `;
    const ids = rawIds.map((row) => row.id);
    const rawTotal = await this.app.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
      FROM "schedules"
      WHERE ${whereSql}
    `;
    const total = Number(rawTotal[0]?.count ?? 0);

    const data = ids.length === 0
      ? []
      : await this.app.prisma.schedule.findMany({
        where: { ...where, id: { in: ids } },
        include: { channel: true },
      });
    const order = new Map(ids.map((id, index) => [id, index]));
    const usageScopes = await this.getUsageScopes(ids);
    const sortedData = data
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((schedule) => ({ ...schedule, usageScope: usageScopes.get(schedule.id) ?? 'broadcast' }));

    return {
      data: sortedData,
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
    const usageScope = await this.getUsageScope(id);
    return { ...schedule, usageScope };
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
    await this.setUsageScope(schedule.id, dto.usageScope);

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

    return { ...schedule, usageScope: dto.usageScope };
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

    const updated = await this.app.prisma.schedule.update({
      where: { id },
      data: {
        ...(dto.channelId !== undefined && { channelId: dto.channelId }),
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
    if (dto.usageScope !== undefined) await this.setUsageScope(id, dto.usageScope);
    const usageScope = dto.usageScope ?? await this.getUsageScope(id);

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

    return { ...updated, usageScope };
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

  private buildUsageAwareWhereSql(query: Pick<ScheduleQuery, 'channel' | 'from' | 'to' | 'status' | 'source' | 'usage'>) {
    const clauses: Prisma.Sql[] = [];

    if (query.channel) clauses.push(Prisma.sql`"channel_id" = ${query.channel}`);
    if (query.status) clauses.push(Prisma.sql`"status" = ${query.status}::"ScheduleStatus"`);
    if (query.from) clauses.push(Prisma.sql`"end_time" >= ${new Date(query.from)}`);
    if (query.to) clauses.push(Prisma.sql`"start_time" <= ${new Date(query.to)}`);
    if (query.source === 'manual') clauses.push(Prisma.sql`"created_by" <> 'bxf-importer'`);
    if (query.source === 'bxf') clauses.push(Prisma.sql`"created_by" = 'bxf-importer'`);
    if (query.usage === 'live-plan') clauses.push(Prisma.sql`"usage_scope" = ${LIVE_PLAN_DB_USAGE_SCOPE}`);
    if (query.usage === 'broadcast') clauses.push(Prisma.sql`"usage_scope" = 'broadcast'`);

    return clauses.length ? Prisma.join(clauses, ' AND ') : Prisma.sql`TRUE`;
  }

  private async setUsageScope(id: number, usageScope = 'broadcast') {
    await this.app.prisma.$executeRaw`
      UPDATE "schedules"
      SET "usage_scope" = ${usageScope}
      WHERE "id" = ${id}
    `;
  }

  private async getUsageScope(id: number): Promise<string> {
    const rows = await this.getUsageScopes([id]);
    return rows.get(id) ?? 'broadcast';
  }

  private async getUsageScopes(ids: number[]): Promise<Map<number, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.app.prisma.$queryRaw<Array<{ id: number; usageScope: string }>>`
      SELECT "id", "usage_scope" AS "usageScope"
      FROM "schedules"
      WHERE "id" IN (${Prisma.join(ids)})
    `;
    return new Map(rows.map((row) => [row.id, row.usageScope]));
  }
}
