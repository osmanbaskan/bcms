import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import type {
  CreateScheduleDto, UpdateScheduleDto, ScheduleQuery,
  CreateBroadcastScheduleDto, UpdateBroadcastScheduleDto,
} from './schedule.schema.js';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { createEnvelope } from '../outbox/outbox.types.js';

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

      const created = await tx.schedule.create({
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

      // Madde 2+7 PR-B (audit doc): Phase 2 SHADOW outbox write.
      // Status='published' + publishedAt=now: poller pick yapmaz; direct
      // publish (transaction dışında, aşağıda) consumer'a teslim eder.
      // Phase 3 cut-over'da status='pending' default + direct publish kaldır.
      //
      // Transaction içinde: DB commit fail → ne schedule ne outbox yazılır.
      // Bilinen kör nokta: DB commit OK + direct publish fail → outbox 'published'
      // kalır ama event consumer'a ulaşmaz. Phase 3 (poller) bu kör noktayı kapatır.
      // Outbox write failure transaction'ı fail eder ("shadow write failure
      // is fatal inside tx"); Phase 2'de API davranışı farkı: kabul edilebilir.
      const createEnv = createEnvelope({
        eventType: 'schedule.created',
        aggregateType: 'Schedule',
        aggregateId: created.id,
        payload: {
          scheduleId: created.id,
          channelId: created.channelId,
          startTime: created.startTime.toISOString(),
          title: created.title,
          version: created.version,
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventId:       createEnv.eventId,
          eventType:     createEnv.eventType,
          aggregateType: createEnv.aggregateType,
          aggregateId:   createEnv.aggregateId,
          schemaVersion: createEnv.schemaVersion,
          payload:       createEnv.payload as Prisma.InputJsonValue,
          occurredAt:    new Date(createEnv.occurredAt),
          status:        'published',
          publishedAt:   new Date(),
        },
      });

      return created;
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

      const refreshed = await tx.schedule.findUniqueOrThrow({
        where: { id },
        include: { channel: true },
      });

      // Madde 2+7 PR-B (audit doc): Phase 2 SHADOW outbox write (update path).
      // Aynı kural: status='published' + publishedAt=now → poller pick yapmaz.
      // Payload minimal but sufficient (kullanıcı guard 2): operation='update' +
      // sık değişen kritik alanlar (changedFields hesabı scope creep — defer).
      const updateEnv = createEnvelope({
        eventType: 'schedule.updated',
        aggregateType: 'Schedule',
        aggregateId: refreshed.id,
        payload: {
          scheduleId: refreshed.id,
          version:    refreshed.version,
          operation:  'update' as const,
          channelId:  refreshed.channelId,
          startTime:  refreshed.startTime.toISOString(),
          endTime:    refreshed.endTime.toISOString(),
          status:     refreshed.status,
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventId:       updateEnv.eventId,
          eventType:     updateEnv.eventType,
          aggregateType: updateEnv.aggregateType,
          aggregateId:   updateEnv.aggregateId,
          schemaVersion: updateEnv.schemaVersion,
          payload:       updateEnv.payload as Prisma.InputJsonValue,
          occurredAt:    new Date(updateEnv.occurredAt),
          status:        'published',
          publishedAt:   new Date(),
        },
      });

      return refreshed;
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

  // ───────────────────────────────────────────────────────────────────────
  // SCHED-B3a (decision §3.5 K16, K-B3 lock 2026-05-07): broadcast flow
  // canonical service path. Eski create/update/remove method'ları SCHED-B5
  // destructive cleanup'a kadar paralel kalır (yeni Schedule UI buradan
  // çağırır). Channel propagation tx + event_key UNIQUE conflict 409 +
  // schedule delete → live-plan channel slot NULL.
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
          // Legacy (SCHED-B5'e kadar):
          title:      entry.title,
          startTime:  startDate,
          endTime:    endDate, // ⚠ LEGACY PLACEHOLDER (start + 2h); canonical değil
          usageScope: 'broadcast',
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
