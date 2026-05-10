import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import type {
  ScheduleQuery,
  CreateBroadcastScheduleDto, UpdateBroadcastScheduleDto,
} from './schedule.schema.js';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { createEnvelope } from '../outbox/outbox.types.js';

// SCHED-B5a (Y5-4): legacy LIVE_PLAN_SOURCE export, withSerializableRetry,
// reportDimensions, sanitizeConflicts helper'ları silindi (legacy create/
// update/remove ile birlikte; canonical broadcast flow kendi flow'unu kullanır).

export class ScheduleService {
  constructor(private readonly app: FastifyInstance) {}

  /** SCHED-B5a (Y5-4 canonical filter): reporting/export/ingest-candidates
   *  endpoint'leri için legacy `usage_scope='live-plan'` filter yerine
   *  canonical `eventKey IS NOT NULL` (broadcast flow row guarantee).
   *  `start_time/end_time` order ve filter B5b'de canonicalize. `metadata`
   *  okuma reporting tarafında korunur (B5b). */
  async findAll(query: ScheduleQuery) {
    const { channel, from, to, status, league, season, week, page, pageSize } = query;
    const skip = (page - 1) * pageSize;

    const where: Prisma.ScheduleWhereInput = {
      eventKey: { not: null }, // canonical broadcast row guarantee
      ...(channel  && { channelId: channel }),
      ...(status   && { status }),
      ...(from && { endTime:   { gte: new Date(from) } }),
      ...(to   && { startTime: { lte: new Date(to)   } }),
      ...(league && { reportLeague: league }),
      ...(season && { reportSeason: season }),
      ...(week && { reportWeekNumber: week }),
    };

    const [data, total] = await Promise.all([
      this.app.prisma.schedule.findMany({
        where,
        include: { channel: true },
        orderBy: { startTime: 'asc' }, // B5b'de canonical scheduleDate/Time order
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

  /** SCHED-B4-prep (2026-05-08): Yayın Planlama list endpoint için broadcast-
   *  complete row guarantee. Server-side filter (frontend pagination'da yanlış
   *  sonuç veren `eventKey != null` post-filter'ı önler):
   *    eventKey != null AND selectedLivePlanEntryId != null
   *    AND scheduleDate != null AND scheduleTime != null
   *  Query: eventKey?, from?, to?, status?, page, pageSize (max 200). */
  async findBroadcastList(query: import('./schedule.schema.js').BroadcastScheduleListQuery) {
    const { eventKey, from, to, status, page, pageSize } = query;
    const skip = (page - 1) * pageSize;

    // canonical scheduleDate range filter (B5'te legacy start_time/end_time
    // DROP olduğunda da doğru çalışır). YYYY-MM-DD UTC midnight olarak Date'e
    // çevrilir; Prisma `@db.Date` ile karşılaştırılır.
    const dateRange = (from || to) ? {
      ...(from && { gte: new Date(`${from}T00:00:00.000Z`) }),
      ...(to   && { lte: new Date(`${to}T00:00:00.000Z`) }),
    } : undefined;

    const where: Prisma.ScheduleWhereInput = {
      eventKey:                { not: null },
      selectedLivePlanEntryId: { not: null },
      scheduleTime:            { not: null },
      ...(dateRange
        ? { scheduleDate: { not: null, ...dateRange } }
        : { scheduleDate: { not: null } }),
      ...(eventKey && { eventKey }),
      ...(status   && { status }),
    };

    const [data, total] = await Promise.all([
      this.app.prisma.schedule.findMany({
        where,
        include: { channel: true },
        orderBy: [{ scheduleDate: 'asc' }, { scheduleTime: 'asc' }, { id: 'asc' }],
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
    const [enriched] = await this.attachIngestPorts([schedule]);
    return enriched;
  }

  /**
   * Canlı yayın schedule'larına ingest_plan_items'tan port atamalarını
   * read-only olarak ekler. Tek batch query — N+1 yok. Live olmayan
   * schedule'lar dokunulmaz; recordingPort/backupRecordingPort null gelir.
   * Edit kanalı sadece Ingest sekmesinden.
   */
  private async attachIngestPorts<T extends { id: number; eventKey?: string | null }>(
    schedules: T[],
  ): Promise<Array<T & { recordingPort: string | null; backupRecordingPort: string | null }>> {
    // SCHED-B5a (Y5-4): canonical filter — `usageScope='live-plan'` yerine
    // `eventKey IS NOT NULL` (broadcast flow row guarantee).
    const liveIds = schedules
      .filter((s) => s.eventKey != null)
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

  // ───────────────────────────────────────────────────────────────────────
  // SCHED-B3a (decision §3.5 K16, K-B3 lock 2026-05-07): broadcast flow
  // canonical service path.
  //
  // SCHED-B5a (Y5-4, 2026-05-08): legacy create/update/remove method'ları
  // silindi (legacy POST/PATCH/DELETE / route'larıyla birlikte).
  // Kalan: createBroadcastFlow, updateBroadcastFlow, removeBroadcastFlow
  // canonical broadcast flow + findAll/findById (reporting/ingest-candidates
  // canonical filter; create/update/remove yok).
  // ───────────────────────────────────────────────────────────────────────

  async createBroadcastFlow(
    dto: CreateBroadcastScheduleDto,
    request: FastifyRequest,
  ) {
    const user = (request.user as { preferred_username?: string })?.preferred_username ?? 'unknown';

    // 1. selected_live_plan_entry varlığı + meta okuma (K-B3.20: title/team
    // schedule body'de gelmez; entry'den kopya).
    const entry = await this.app.prisma.livePlanEntry.findUnique({
      where: { id: dto.selectedLivePlanEntryId },
    });
    if (!entry || entry.deletedAt !== null) {
      throw Object.assign(new Error('selected_live_plan_entry not found'), { statusCode: 404 });
    }

    // 2. event_key UNIQUE pre-check (K-B3.13: aynı event ikinci satır olamaz).
    const existing = await this.app.prisma.schedule.findUnique({
      where: { eventKey: dto.eventKey },
    });
    if (existing) {
      throw Object.assign(
        new Error('Bu event Yayın Planlama\'da zaten var'),
        { statusCode: 409 },
      );
    }

    // 3. Legacy alan derive (SCHED-B5'e kadar dual-write):
    //   start_time = scheduleDate + scheduleTime UTC.
    //   end_time   = start + 2h placeholder. ⚠ Bu canonical değil; sadece
    //               legacy NOT NULL kolonu doyurmak için. Export/report
    //               buradan gerçek yayın süresi ÇIKARMASIN.
    const startISO = composeUtc(dto.scheduleDate, dto.scheduleTime);
    const startDate = new Date(startISO);
    const endDate = new Date(startDate.getTime() + 2 * 3600 * 1000);

    return this.app.prisma.$transaction(async (tx) => {
      const created = await tx.schedule.create({
        data: {
          // Yeni canonical:
          eventKey:                dto.eventKey,
          selectedLivePlanEntryId: dto.selectedLivePlanEntryId,
          scheduleDate:            new Date(`${dto.scheduleDate}T00:00:00.000Z`),
          scheduleTime:            new Date(`1970-01-01T${normalizeTime(dto.scheduleTime)}.000Z`),
          channel1Id:              dto.channel1Id ?? null,
          channel2Id:              dto.channel2Id ?? null,
          channel3Id:              dto.channel3Id ?? null,
          commercialOptionId:      dto.commercialOptionId ?? null,
          logoOptionId:            dto.logoOptionId ?? null,
          formatOptionId:          dto.formatOptionId ?? null,
          // K-B3.20: title + team_1/2 entry'den kopya (Schedule body'de bu
          // alanlar yazılmaz). Entry'de team_1/2 NULL ise schedule'da NULL
          // (M5-B2 entry create zorunlu kılmıyordu; B3b OPTA selection
          // akışında zorunluluk ayrıca kararlaştırılır).
          team1Name:  entry.team1Name,
          team2Name:  entry.team2Name,
          // Legacy (SCHED-B5b'e kadar — start_time/end_time placeholder):
          title:      entry.title,
          startTime:  startDate,
          endTime:    endDate, // ⚠ LEGACY PLACEHOLDER (start + 2h); canonical değil
          // SCHED-B5a (Y5-2a): usageScope set kaldırıldı; DB default 'broadcast'
          // hala canonical (B5b'de kolon DROP).
          createdBy:  user,
        },
      });

      // 4. Channel propagation (K-B3.11, K-B3.12 reverse): aynı event_key'li
      // tüm live_plan_entries'e channel slot UPDATE.
      await tx.livePlanEntry.updateMany({
        where: { eventKey: dto.eventKey, deletedAt: null },
        data: {
          channel1Id: dto.channel1Id ?? null,
          channel2Id: dto.channel2Id ?? null,
          channel3Id: dto.channel3Id ?? null,
        },
      });

      return created;
    });
  }

  async updateBroadcastFlow(
    id: number,
    dto: UpdateBroadcastScheduleDto,
    ifMatchVersion: number | undefined,
    _request: FastifyRequest,
  ) {
    const existing = await this.app.prisma.schedule.findUnique({ where: { id } });
    if (!existing) {
      throw Object.assign(new Error('Schedule not found'), { statusCode: 404 });
    }

    return this.app.prisma.$transaction(async (tx) => {
      // 1. Canonical alan update + version increment + If-Match check.
      const data: Prisma.ScheduleUpdateInput = {
        ...(dto.scheduleDate !== undefined && {
          scheduleDate: new Date(`${dto.scheduleDate}T00:00:00.000Z`),
        }),
        ...(dto.scheduleTime !== undefined && {
          scheduleTime: new Date(`1970-01-01T${normalizeTime(dto.scheduleTime)}.000Z`),
        }),
        ...(dto.channel1Id !== undefined && { channel1Id: dto.channel1Id }),
        ...(dto.channel2Id !== undefined && { channel2Id: dto.channel2Id }),
        ...(dto.channel3Id !== undefined && { channel3Id: dto.channel3Id }),
        ...(dto.commercialOptionId !== undefined && { commercialOptionId: dto.commercialOptionId }),
        ...(dto.logoOptionId !== undefined && { logoOptionId: dto.logoOptionId }),
        ...(dto.formatOptionId !== undefined && { formatOptionId: dto.formatOptionId }),
        version: { increment: 1 },
      };

      // Legacy start_time/end_time dual-write: scheduleDate veya scheduleTime
      // değiştiyse legacy alanlar da güncellenir (placeholder 2h korunur).
      if (dto.scheduleDate !== undefined || dto.scheduleTime !== undefined) {
        const newDate = dto.scheduleDate ?? formatDate(existing.scheduleDate ?? existing.startTime);
        const newTime = dto.scheduleTime ?? formatTime(existing.scheduleTime ?? existing.startTime);
        const startISO = composeUtc(newDate, newTime);
        const startDate = new Date(startISO);
        data.startTime = startDate;
        data.endTime   = new Date(startDate.getTime() + 2 * 3600 * 1000); // legacy placeholder
      }

      const where: Prisma.ScheduleWhereUniqueInput =
        ifMatchVersion !== undefined
          ? { id, version: ifMatchVersion }
          : { id };

      const result = await tx.schedule.updateMany({ where, data });
      if (result.count !== 1) {
        if (ifMatchVersion !== undefined) {
          throw Object.assign(new Error('Schedule version conflict'), { statusCode: 412 });
        }
        throw Object.assign(new Error('Schedule update failed'), { statusCode: 500 });
      }
      const refreshed = await tx.schedule.findUniqueOrThrow({ where: { id } });

      // 2. Channel propagation (K-B3.11): kanal slotlarından biri değiştiyse
      // aynı event_key'li tüm live_plan_entries'e UPDATE.
      const channelChanged =
        dto.channel1Id !== undefined ||
        dto.channel2Id !== undefined ||
        dto.channel3Id !== undefined;
      if (channelChanged && refreshed.eventKey) {
        await tx.livePlanEntry.updateMany({
          where: { eventKey: refreshed.eventKey, deletedAt: null },
          data: {
            channel1Id: refreshed.channel1Id,
            channel2Id: refreshed.channel2Id,
            channel3Id: refreshed.channel3Id,
          },
        });
      }

      // 3. K-B3.19: scheduleDate/scheduleTime değiştiyse aynı event_key'li
      // live_plan_entries.eventStartTime/eventEndTime UPDATE (duration korunur).
      const timeChanged =
        dto.scheduleDate !== undefined || dto.scheduleTime !== undefined;
      if (timeChanged && refreshed.eventKey) {
        const newStart = refreshed.startTime; // legacy compose üstte yapıldı
        await this.syncLivePlanEventTimes(tx, refreshed.eventKey, newStart);
      }

      return refreshed;
    });
  }

  async removeBroadcastFlow(id: number) {
    const existing = await this.app.prisma.schedule.findUnique({ where: { id } });
    if (!existing) {
      throw Object.assign(new Error('Schedule not found'), { statusCode: 404 });
    }

    await this.app.prisma.$transaction(async (tx) => {
      // K-B3.16: schedule sil → aynı event_key'li live_plan_entries channel
      // slot NULL (live-plan satırı silinmez; K-B3.15).
      if (existing.eventKey) {
        await tx.livePlanEntry.updateMany({
          where: { eventKey: existing.eventKey, deletedAt: null },
          data: {
            channel1Id: null,
            channel2Id: null,
            channel3Id: null,
          },
        });
      }
      // Schedule satırı hard-delete (mevcut remove pattern; soft-delete bu
      // domain'de uygulanmıyor).
      await tx.schedule.delete({ where: { id } });
    });
  }

  // K-B3.19: live_plan_entries.eventStartTime + eventEndTime UPDATE.
  // Duration korunur (yeni eventStart = newStart; yeni eventEnd = eventStart + originalDuration).
  private async syncLivePlanEventTimes(
    tx: Prisma.TransactionClient,
    eventKey: string,
    newStart: Date,
  ) {
    const entries = await tx.livePlanEntry.findMany({
      where: { eventKey, deletedAt: null },
      select: { id: true, eventStartTime: true, eventEndTime: true },
    });
    for (const e of entries) {
      const duration = e.eventEndTime.getTime() - e.eventStartTime.getTime();
      const newEnd = new Date(newStart.getTime() + (duration > 0 ? duration : 2 * 3600 * 1000));
      await tx.livePlanEntry.update({
        where: { id: e.id },
        data: { eventStartTime: newStart, eventEndTime: newEnd },
      });
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// SCHED-B3a helpers (date/time compose + format).
// ───────────────────────────────────────────────────────────────────────────

function composeUtc(dateStr: string, timeStr: string): string {
  return `${dateStr}T${normalizeTime(timeStr)}.000Z`;
}

function normalizeTime(timeStr: string): string {
  return timeStr.length === 5 ? `${timeStr}:00` : timeStr;
}

function formatDate(d: Date | null): string {
  if (!d) return '1970-01-01';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTime(d: Date | null): string {
  if (!d) return '00:00:00';
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
