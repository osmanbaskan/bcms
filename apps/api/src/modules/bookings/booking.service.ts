import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import type { CreateBookingDto, UpdateBookingDto } from './booking.schema.js';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { writeAuditLog } from '../../middleware/audit.js';
import type { EmailPayload } from '../notifications/notification.consumer.js';
import { readFirstWorksheetRows, rowsToObjects } from '../../lib/excel.js';

const STATUS_LABELS: Record<string, string> = {
  APPROVED: 'onaylandı',
  REJECTED: 'reddedildi',
};

export interface ImportResult {
  created: number;
  skipped: number;
  errors: { row: number; reason: string }[];
}

export class BookingService {
  constructor(private readonly app: FastifyInstance) {}

  async findAll(scheduleId?: number, page = 1, pageSize = 50) {
    const skip = (page - 1) * pageSize;
    const where = scheduleId ? { scheduleId } : {};
    const [data, total] = await Promise.all([
      this.app.prisma.booking.findMany({
        where,
        skip,
        take: pageSize,
        include: { team: true, schedule: { include: { channel: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.app.prisma.booking.count({ where }),
    ]);
    return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  async findById(id: number) {
    const booking = await this.app.prisma.booking.findUnique({
      where: { id },
      include: { team: true, schedule: { include: { channel: true } } },
    });
    if (!booking) throw Object.assign(new Error('Booking not found'), { statusCode: 404 });
    return booking;
  }

  async create(dto: CreateBookingDto, request: FastifyRequest) {
    const user = (request.user as { preferred_username: string }).preferred_username;

    const schedule = await this.app.prisma.schedule.findUnique({ where: { id: dto.scheduleId } });
    if (!schedule) throw Object.assign(new Error('Schedule not found'), { statusCode: 404 });

    const booking = await this.app.prisma.booking.create({
      data: {
        scheduleId:  dto.scheduleId,
        requestedBy: user,
        teamId:      dto.teamId,
        matchId:     dto.matchId,
        notes:       dto.notes,
        metadata:    dto.metadata as Prisma.InputJsonValue,
      },
      include: { team: true },
    });

    await writeAuditLog(this.app, { entityType: 'Booking', entityId: booking.id, action: 'CREATE', after: booking, request });
    await this.app.rabbitmq.publish(QUEUES.BOOKING_CREATED, { bookingId: booking.id, scheduleId: booking.scheduleId });

    return booking;
  }

  async update(id: number, dto: UpdateBookingDto, ifMatchVersion: number | undefined, request: FastifyRequest) {
    const existing = await this.findById(id);

    if (ifMatchVersion !== undefined && existing.version !== ifMatchVersion) {
      throw Object.assign(
        new Error(`Version conflict: expected ${ifMatchVersion}, got ${existing.version}`),
        { statusCode: 412 },
      );
    }

    const data: Prisma.BookingUpdateManyMutationInput = {
      ...(dto.status   && { status: dto.status }),
      ...(dto.notes    !== undefined && { notes: dto.notes }),
      ...(dto.metadata && { metadata: dto.metadata as Prisma.InputJsonValue }),
      version: { increment: 1 },
    };

    const updated = await this.app.prisma.$transaction(async (tx) => {
      const result = await tx.booking.updateMany({
        where: {
          id,
          ...(ifMatchVersion !== undefined && { version: ifMatchVersion }),
        },
        data,
      });

      if (result.count !== 1) {
        throw Object.assign(new Error('Booking version conflict'), { statusCode: ifMatchVersion !== undefined ? 412 : 404 });
      }

      return tx.booking.findUniqueOrThrow({
        where: { id },
        include: { team: true },
      });
    });

    await writeAuditLog(this.app, { entityType: 'Booking', entityId: id, action: 'UPDATE', before: existing, after: updated, request });

    // APPROVED veya REJECTED olduğunda talep edene bildirim gönder
    if (dto.status && STATUS_LABELS[dto.status]) {
      const label = STATUS_LABELS[dto.status];
      const emailPayload: EmailPayload = {
        to: existing.requestedBy,
        subject: `Rezervasyonunuz ${label}`,
        body: `Merhaba ${existing.requestedBy},\n\n${id} numaralı rezervasyonunuz ${label}.\n\nBCMS`,
      };
      await this.app.rabbitmq.publish(QUEUES.NOTIFICATIONS_EMAIL, emailPayload);
    }

    return updated;
  }

  async remove(id: number) {
    await this.findById(id);
    await this.app.prisma.booking.delete({ where: { id } });
  }

  // ── Excel toplu import ────────────────────────────────────────────────────────

  async importFromBuffer(buffer: Buffer, request: FastifyRequest): Promise<ImportResult> {
    const user = (request.user as { preferred_username: string }).preferred_username;

    const rows = rowsToObjects(await readFirstWorksheetRows(buffer));
    if (rows.length === 0) throw Object.assign(new Error('Excel dosyası boş'), { statusCode: 400 });

    const result: ImportResult = { created: 0, skipped: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // 1-indexed + başlık satırı

      const scheduleId = Number(row['scheduleId'] ?? row['schedule_id']);
      if (!scheduleId || isNaN(scheduleId)) {
        result.errors.push({ row: rowNum, reason: 'scheduleId eksik veya geçersiz' });
        continue;
      }

      const schedule = await this.app.prisma.schedule.findUnique({ where: { id: scheduleId } });
      if (!schedule) {
        result.errors.push({ row: rowNum, reason: `scheduleId=${scheduleId} bulunamadı` });
        continue;
      }

      try {
        const booking = await this.app.prisma.booking.create({
          data: {
            scheduleId,
            requestedBy: user,
            teamId:  row['teamId']  ? Number(row['teamId'])  : undefined,
            matchId: row['matchId'] ? Number(row['matchId']) : undefined,
            notes:   row['notes']   ? String(row['notes'])   : undefined,
          },
        });
        await this.app.rabbitmq.publish(QUEUES.BOOKING_CREATED, { bookingId: booking.id, scheduleId });
        result.created++;
      } catch (err) {
        result.errors.push({ row: rowNum, reason: (err as Error).message });
      }
    }

    return result;
  }
}
