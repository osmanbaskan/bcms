import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { BCMS_GROUPS, GROUP, type BcmsGroup, type JwtPayload } from '@bcms/shared';
import type { CreateBookingDto, UpdateBookingDto } from './booking.schema.js';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { createEnvelope } from '../outbox/outbox.types.js';
import { isOutboxPollerAuthoritative } from '../outbox/outbox.helpers.js';
import type { EmailPayload } from '../notifications/notification.consumer.js';
import { readFirstWorksheetRows, rowsToObjects } from '../../lib/excel.js';
import { kcFetch } from '../../core/keycloak-admin.client.js';

const STATUS_LABELS: Record<string, string> = {
  APPROVED: 'tamamlandı',
  REJECTED: 'reddedildi',
};

type UserType = 'staff' | 'supervisor';

interface AssignableUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  userType: UserType;
  groups: string[];
}

export interface ImportResult {
  created: number;
  skipped: number;
  errors: { row: number; reason: string }[];
}

function parseDateOnly(value?: string | null): Date | null | undefined {
  if (value === null) return null;
  if (!value) return undefined;
  return new Date(`${value}T00:00:00.000Z`);
}

function parseDateTime(value?: string | null): Date | null | undefined {
  if (value === null) return null;
  if (!value) return undefined;
  return new Date(value);
}

function isBcmsGroup(value: string): value is BcmsGroup {
  return (BCMS_GROUPS as readonly string[]).includes(value);
}

function tokenGroups(claims: JwtPayload): BcmsGroup[] {
  return (claims.groups ?? []).filter(isBcmsGroup);
}

/** Tüm grupları görme + tüm assignment yetkileri. Sadece Admin claim'i taşıyan
 *  user için true (SystemEng'in eski "ops super-grubu" davranışı 2026-05-01'de
 *  kaldırıldı; SystemEng artık kendi grubunun bookings'ini görür). */
function isAdminUser(claims: JwtPayload): boolean {
  // ORTA-API-1.3.1 fix (2026-05-04): hardcoded 'Admin' → GROUP.Admin.
  return claims.groups?.includes(GROUP.Admin) ?? false;
}

function keycloakAttributeValue(attributes: any, key: string): string | undefined {
  const value = attributes?.[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

function normalizeUserType(value: unknown): UserType {
  return value === 'supervisor' ? 'supervisor' : 'staff';
}

function displayName(user: any): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || user.username || user.id;
}

async function fetchUserType(username: string): Promise<UserType> {
  const users = await kcFetch<any[]>(`/users?username=${encodeURIComponent(username)}&exact=true&max=1`);
  return normalizeUserType(keycloakAttributeValue(users[0]?.attributes, 'bcmsUserType'));
}

async function fetchBcmsGroupMemberships(): Promise<Map<string, string[]>> {
  const groups = await kcFetch<any[]>('/groups');
  const groupIdByName = new Map(groups.map((group: any) => [group.name as string, group.id as string]));
  const memberships = new Map<string, string[]>();

  await Promise.all(BCMS_GROUPS.map(async (groupName) => {
    const groupId = groupIdByName.get(groupName);
    if (!groupId) return;
    const members = await kcFetch<any[]>(`/groups/${groupId}/members?max=500`);
    for (const member of members) {
      const memberGroups = memberships.get(member.id) ?? [];
      memberGroups.push(groupName);
      memberships.set(member.id, memberGroups);
    }
  }));

  return memberships;
}

async function fetchGroupUsers(group: string): Promise<AssignableUser[]> {
  const users = await kcFetch<any[]>('/users?max=500');
  const memberships = await fetchBcmsGroupMemberships();
  const mapped = users.map((user) => {
    const groups = memberships.get(user.id) ?? [];
    return {
      id: user.id,
      username: user.username,
      displayName: displayName(user),
      email: user.email ?? '',
      userType: normalizeUserType(keycloakAttributeValue(user.attributes, 'bcmsUserType')),
      groups,
    };
  });
  return mapped
    .filter((user) => user.groups.some((userGroup) => userGroup === group))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'tr'));
}

/** HIGH-API-013 fix (2026-05-05): findAll'da her sayfa için Keycloak'dan 500
 *  kullanıcı çekiliyordu. 60sn TTL cache → list endpoint'lerinde KC'ye yük
 *  azalır; kullanıcı isim değişiklikleri en geç 60sn'de propage olur. */
let userDisplayCache: Map<string, string> | null = null;
let userDisplayExpiry = 0;
const USER_DISPLAY_TTL_MS = 60_000;

async function fetchUserDisplayNameMap(): Promise<Map<string, string>> {
  if (userDisplayCache && Date.now() < userDisplayExpiry) return userDisplayCache;
  const users = await kcFetch<any[]>('/users?max=500');
  const fresh = new Map(users.map((user) => [user.username, displayName(user)]));
  userDisplayCache = fresh;
  userDisplayExpiry = Date.now() + USER_DISPLAY_TTL_MS;
  return fresh;
}

export class BookingService {
  constructor(private readonly app: FastifyInstance) {}

  async findAll(request: FastifyRequest, scheduleId?: number, group?: string, page = 1, pageSize = 50) {
    const claims = request.user as JwtPayload;
    const visibleGroups = this.visibleGroups(claims);
    const currentUserType = isAdminUser(claims) ? 'supervisor' : await fetchUserType(claims.preferred_username);
    const canAssignGroups = isAdminUser(claims) || currentUserType === 'supervisor' ? visibleGroups : [];
    const selectedGroup = group && isBcmsGroup(group) && visibleGroups.includes(group) ? group : undefined;
    const skip = (page - 1) * pageSize;
    const where: Prisma.BookingWhereInput = {
      ...(scheduleId && { scheduleId }),
      // MED-API-009 fix (2026-05-05): non-admin filter de userGroup null
      // olanları (eski/legacy bookings) görsün — aksi halde import edilen
      // yetimkayıtlar arayüzde görünmez. Admin OR pattern'i non-admin'e de
      // uygulandı.
      ...(selectedGroup
        ? { userGroup: selectedGroup }
        : { OR: [{ userGroup: { in: visibleGroups } }, { userGroup: null }] }),
    };
    const [data, total, displayNames] = await Promise.all([
      this.app.prisma.booking.findMany({
        where,
        skip,
        take: pageSize,
        include: { team: true, schedule: true },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      }),
      this.app.prisma.booking.count({ where }),
      fetchUserDisplayNameMap(),
    ]);
    return {
      data: data.map((booking) => ({
        ...booking,
        requestedByName: displayNames.get(booking.requestedBy) ?? booking.requestedBy,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      groups: visibleGroups,
      canAssignGroups,
    };
  }

  async findById(id: number) {
    const booking = await this.app.prisma.booking.findUnique({
      where: { id },
      include: { team: true, schedule: true },
    });
    if (!booking) throw Object.assign(new Error('Booking not found'), { statusCode: 404 });
    return booking;
  }

  async findByIdForRequest(id: number, claims: JwtPayload) {
    const booking = await this.findById(id);
    if (!this.canSee(claims, booking.userGroup)) {
      throw Object.assign(new Error('Booking not found'), { statusCode: 404 });
    }
    return booking;
  }

  async findAssignableUsers(request: FastifyRequest, group: BcmsGroup) {
    const claims = request.user as JwtPayload;
    if (!this.canSee(claims, group)) throw Object.assign(new Error('Bu grubu görme yetkiniz yok'), { statusCode: 403 });
    return fetchGroupUsers(group);
  }

  async create(dto: CreateBookingDto, request: FastifyRequest) {
    const claims = request.user as JwtPayload;
    const user = claims.preferred_username;
    const group = this.resolveTargetGroup(claims, dto.userGroup);

    // ORTA-API-1.3.2 fix (2026-05-04): schedule existence check transaction
    // içinde — TOCTOU race kapatıldı. Schedule check ile booking.create
    // arasındaki pencerede schedule silinirse FK violation P2003 dönerdi;
    // şimdi tek transaction.
    const booking = await this.app.prisma.$transaction(async (tx) => {
      if (dto.scheduleId) {
        const schedule = await tx.schedule.findUnique({ where: { id: dto.scheduleId }, select: { id: true } });
        if (!schedule) throw Object.assign(new Error('Schedule not found'), { statusCode: 404 });
      }

      const created = await tx.booking.create({
        data: {
          scheduleId:  dto.scheduleId,
          requestedBy: user,
          teamId:      dto.teamId,
          matchId:     dto.matchId,
          taskTitle:   dto.taskTitle,
          taskDetails: dto.taskDetails,
          taskReport:  dto.taskReport,
          userGroup:   group,
          assigneeId:  dto.assigneeId,
          assigneeName: dto.assigneeName,
          startDate:   parseDateOnly(dto.startDate),
          dueDate:     parseDateOnly(dto.dueDate),
          completedAt: parseDateTime(dto.completedAt),
          status:      dto.status,
          notes:       dto.notes,
          metadata:    dto.metadata as Prisma.InputJsonValue,
        },
        include: { team: true, schedule: true },
      });

      // Madde 2+7 PR-B2 (audit doc): Phase 2 SHADOW outbox write.
      // Strict shadow: 1:1 BOOKING_CREATED direct publish ile. Status='published' +
      // publishedAt → poller pick yapmaz; direct publish (tx dışında) consumer'a iletir.
      // Phase 3'te status default 'pending', direct publish kaldırılır.
      // "Shadow write failure is fatal inside tx" — outbox.create fail = booking yazılmaz.
      const env = createEnvelope({
        eventType: 'booking.created',
        aggregateType: 'Booking',
        aggregateId: created.id,
        payload: {
          bookingId:   created.id,
          scheduleId:  created.scheduleId,
          requestedBy: created.requestedBy,
          userGroup:   created.userGroup,
          status:      created.status,
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventId:       env.eventId,
          eventType:     env.eventType,
          aggregateType: env.aggregateType,
          aggregateId:   env.aggregateId,
          schemaVersion: env.schemaVersion,
          payload:       env.payload as Prisma.InputJsonValue,
          occurredAt:    new Date(env.occurredAt),
          status:        'published',
          publishedAt:   new Date(),
        },
      });

      return created;
    });

    if (!isOutboxPollerAuthoritative()) {
      await this.app.rabbitmq.publish(QUEUES.BOOKING_CREATED, { bookingId: booking.id, scheduleId: booking.scheduleId });
    } else {
      this.app.log.debug(
        { domain: 'booking', queue: QUEUES.BOOKING_CREATED, eventType: 'booking.created' },
        'direct publish skipped — outbox poller authoritative',
      );
    }

    return booking;
  }

  async update(id: number, dto: UpdateBookingDto, ifMatchVersion: number | undefined, request: FastifyRequest) {
    const claims = request.user as JwtPayload;
    const existing = await this.findByIdForRequest(id, claims);
    const canAssign = await this.canAssign(request, existing.userGroup);

    if (ifMatchVersion !== undefined && existing.version !== ifMatchVersion) {
      throw Object.assign(
        new Error(`Version conflict: expected ${ifMatchVersion}, got ${existing.version}`),
        { statusCode: 412 },
      );
    }

    if ((dto.assigneeId !== undefined || dto.assigneeName !== undefined) && !canAssign) {
      throw Object.assign(new Error('Sorumlu kullanıcı seçme yetkiniz yok'), { statusCode: 403 });
    }

    // ORTA-API hijyen (2026-05-04): merge-aware date consistency.
    // Schema-level .refine() yalnızca dto'da iki alan da varsa kontrol ediyor;
    // sadece dueDate gönderilirse existing.startDate ile çakışma kaçabilir.
    // Burada DB'deki existing değerleriyle merge edip etkili tarihleri kontrol et.
    const effectiveStart =
      dto.startDate === undefined ? existing.startDate
      : dto.startDate === null    ? null
      : parseDateOnly(dto.startDate) ?? null;
    const effectiveDue =
      dto.dueDate === undefined ? existing.dueDate
      : dto.dueDate === null    ? null
      : parseDateOnly(dto.dueDate) ?? null;
    if (effectiveStart && effectiveDue && effectiveStart > effectiveDue) {
      throw Object.assign(
        new Error('startDate dueDate\'den sonra olamaz'),
        { statusCode: 400 },
      );
    }

    // ORTA-API hijyen (2026-05-04): status transition validation.
    // Geçerli geçişler: PENDING → APPROVED|REJECTED|CANCELLED, geri dönüşler
    // engellenir (audit trail bütünlüğü için). APPROVED/REJECTED terminal
    // sayılır; sadece Admin ya da CANCELLED'e yeniden geçişle değiştirilebilir.
    if (dto.status && dto.status !== existing.status) {
      const VALID_TRANSITIONS: Record<string, string[]> = {
        PENDING:   ['APPROVED', 'REJECTED', 'CANCELLED'],
        APPROVED:  ['CANCELLED'],
        REJECTED:  ['PENDING'],   // Geri açma izni
        CANCELLED: ['PENDING'],   // Reaktive
      };
      const allowed = VALID_TRANSITIONS[existing.status] ?? [];
      if (!allowed.includes(dto.status)) {
        throw Object.assign(
          new Error(`Geçersiz durum geçişi: ${existing.status} → ${dto.status}`),
          { statusCode: 409 },
        );
      }
    }

    const data: Prisma.BookingUpdateManyMutationInput = {
      ...(dto.status   && { status: dto.status }),
      ...(dto.taskTitle !== undefined && { taskTitle: dto.taskTitle }),
      ...(dto.taskDetails !== undefined && { taskDetails: dto.taskDetails }),
      ...(dto.taskReport !== undefined && { taskReport: dto.taskReport }),
      ...(dto.assigneeId !== undefined && { assigneeId: dto.assigneeId }),
      ...(dto.assigneeName !== undefined && { assigneeName: dto.assigneeName }),
      ...(dto.startDate !== undefined && { startDate: parseDateOnly(dto.startDate) }),
      ...(dto.dueDate !== undefined && { dueDate: parseDateOnly(dto.dueDate) }),
      ...(dto.completedAt !== undefined && { completedAt: parseDateTime(dto.completedAt) }),
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

      const refreshed = await tx.booking.findUniqueOrThrow({
        where: { id },
        include: { team: true, schedule: true },
      });

      // Madde 2+7 PR-B3a (audit doc): notification email shadow outbox write.
      // Aynı koşul (mevcut direct publish ile parity): dto.status &&
      // STATUS_LABELS[dto.status] (APPROVED/REJECTED). Subject/body template'i
      // direct publish ile bire bir aynı.
      // Strict shadow: payload sadece { to, subject, body } — aggregate
      // traceability outbox row metadata'da (aggregateType='Booking',
      // aggregateId, eventType='notification.email_requested').
      // notification.consumer.ts'teki retry self-republish dahil edilmez
      // (consumer-internal mekanik, domain üretici değil).
      if (dto.status && STATUS_LABELS[dto.status]) {
        const label = STATUS_LABELS[dto.status];
        const env = createEnvelope({
          eventType: 'notification.email_requested',
          aggregateType: 'Booking',
          aggregateId: refreshed.id,
          payload: {
            to:      existing.requestedBy,
            subject: `İş kaydınız ${label}`,
            body:    `Merhaba ${existing.requestedBy},\n\n${id} numaralı iş kaydınız ${label}.\n\nBCMS`,
          },
        });
        await tx.outboxEvent.create({
          data: {
            eventId:       env.eventId,
            eventType:     env.eventType,
            aggregateType: env.aggregateType,
            aggregateId:   env.aggregateId,
            schemaVersion: env.schemaVersion,
            payload:       env.payload as Prisma.InputJsonValue,
            occurredAt:    new Date(env.occurredAt),
            status:        'published',
            publishedAt:   new Date(),
          },
        });
      }

      return refreshed;
    });

    if (dto.status && STATUS_LABELS[dto.status]) {
      const label = STATUS_LABELS[dto.status];
      const emailPayload: EmailPayload = {
        to: existing.requestedBy,
        subject: `İş kaydınız ${label}`,
        body: `Merhaba ${existing.requestedBy},\n\n${id} numaralı iş kaydınız ${label}.\n\nBCMS`,
      };
      if (!isOutboxPollerAuthoritative()) {
        await this.app.rabbitmq.publish(QUEUES.NOTIFICATIONS_EMAIL, emailPayload);
      } else {
        this.app.log.debug(
          { domain: 'booking', queue: QUEUES.NOTIFICATIONS_EMAIL, eventType: 'notification.email_requested' },
          'direct publish skipped — outbox poller authoritative',
        );
      }
    }

    return updated;
  }

  // LOW-API-008 fix (2026-05-05): unused method silindi (remove(id)). Tüm
  // delete çağrıları removeForRequest üzerinden yetki kontrolüyle yapılır.

  async removeForRequest(id: number, request: FastifyRequest) {
    const claims = request.user as JwtPayload;
    const booking = await this.findByIdForRequest(id, claims);
    if (!this.canDelete(claims, booking)) {
      throw Object.assign(new Error('Bu işi silme yetkiniz yok'), { statusCode: 403 });
    }
    await this.app.prisma.booking.delete({ where: { id } });
  }

  async importFromBuffer(buffer: Buffer, request: FastifyRequest): Promise<ImportResult> {
    const user = (request.user as { preferred_username: string }).preferred_username;

    const rows = rowsToObjects(await readFirstWorksheetRows(buffer));
    if (rows.length === 0) throw Object.assign(new Error('Excel dosyası boş'), { statusCode: 400 });

    const result: ImportResult = { created: 0, skipped: 0, errors: [] };

    // MED-API-021 fix (2026-05-05): N satır × 1 findUnique + 1 create = 2N
    // round-trip. Önce tüm valid scheduleId'leri tek query ile validate et,
    // sonra geçerli row'ları toplu işle.
    type Parsed = { rowNum: number; scheduleId: number; row: Record<string, unknown> };
    const parsed: Parsed[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      const scheduleId = Number(row['scheduleId'] ?? row['schedule_id']);
      if (!scheduleId || isNaN(scheduleId)) {
        result.errors.push({ row: rowNum, reason: 'scheduleId eksik veya geçersiz' });
        continue;
      }
      parsed.push({ rowNum, scheduleId, row });
    }

    if (parsed.length === 0) return result;

    // Schedule existence: tek IN query
    const ids = Array.from(new Set(parsed.map((p) => p.scheduleId)));
    const existing = await this.app.prisma.schedule.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((s) => s.id));

    // Eksik schedule'ları errors'a yaz
    for (const p of parsed) {
      if (!existingIds.has(p.scheduleId)) {
        result.errors.push({ row: p.rowNum, reason: `scheduleId=${p.scheduleId} bulunamadı` });
      }
    }

    const validRows = parsed.filter((p) => existingIds.has(p.scheduleId));

    // Booking create'ler tek transaction'da; her birinin ID'si lazım (RabbitMQ
    // publish için), bu yüzden createMany yerine ardışık create.
    //
    // Madde 2+7 PR-B2 (audit doc): array-form $transaction → interactive form
    // refactor. Sebep: outbox shadow write her booking'in id'sine ihtiyaç duyar;
    // array form'da create dönüşü ile sonraki promise arasında dependency
    // kurmak mümkün değil. Interactive form sequential await ile create+outbox
    // pair'leri tek tx'te birleştirir. Wall time hafif artar (paralel→sequential)
    // — Phase 2'de kabul edilebilir.
    try {
      const created = await this.app.prisma.$transaction(async (tx) => {
        const rows: Array<{ id: number; scheduleId: number | null }> = [];
        for (const { row, scheduleId } of validRows) {
          const booking = await tx.booking.create({
            data: {
              scheduleId,
              requestedBy: user,
              teamId:  row['teamId']  ? Number(row['teamId'])  : undefined,
              matchId: row['matchId'] ? Number(row['matchId']) : undefined,
              notes:   row['notes']   ? String(row['notes'])   : undefined,
            },
          });

          // Phase 2 shadow per-row outbox write (booking.created).
          const env = createEnvelope({
            eventType: 'booking.created',
            aggregateType: 'Booking',
            aggregateId: booking.id,
            payload: {
              bookingId:   booking.id,
              scheduleId:  booking.scheduleId,
              requestedBy: booking.requestedBy,
              userGroup:   booking.userGroup,
              status:      booking.status,
            },
          });
          await tx.outboxEvent.create({
            data: {
              eventId:       env.eventId,
              eventType:     env.eventType,
              aggregateType: env.aggregateType,
              aggregateId:   env.aggregateId,
              schemaVersion: env.schemaVersion,
              payload:       env.payload as Prisma.InputJsonValue,
              occurredAt:    new Date(env.occurredAt),
              status:        'published',
              publishedAt:   new Date(),
            },
          });

          rows.push({ id: booking.id, scheduleId: booking.scheduleId });
        }
        return rows;
      });

      // Direct publish — tx dışı (Phase 2 invariant). PR-C2 cut-over:
      // OUTBOX_POLLER_AUTHORITATIVE=true ise poller authoritative; burası skip.
      const authoritative = isOutboxPollerAuthoritative();
      for (let i = 0; i < created.length; i++) {
        if (!authoritative) {
          await this.app.rabbitmq.publish(QUEUES.BOOKING_CREATED, {
            bookingId: created[i].id,
            scheduleId: validRows[i].scheduleId,
          });
        }
        result.created++;
      }
      if (authoritative) {
        this.app.log.debug(
          { domain: 'booking', queue: QUEUES.BOOKING_CREATED, eventType: 'booking.created', count: created.length },
          'direct publish skipped — outbox poller authoritative',
        );
      }
    } catch (err) {
      result.errors.push({ row: 0, reason: `Toplu işlem başarısız: ${(err as Error).message}` });
    }

    return result;
  }

  private visibleGroups(claims: JwtPayload): BcmsGroup[] {
    if (isAdminUser(claims)) return [...BCMS_GROUPS];
    return tokenGroups(claims);
  }

  private canSee(claims: JwtPayload, group: string | null): boolean {
    if (isAdminUser(claims)) return true;
    return Boolean(group && this.visibleGroups(claims).includes(group as BcmsGroup));
  }

  private resolveTargetGroup(claims: JwtPayload, requestedGroup?: string): BcmsGroup {
    const groups = this.visibleGroups(claims);
    const group = requestedGroup && isBcmsGroup(requestedGroup) ? requestedGroup : groups[0];
    if (!group || !groups.includes(group)) {
      throw Object.assign(new Error('Bu grup için iş oluşturma yetkiniz yok'), { statusCode: 403 });
    }
    return group;
  }

  private async canAssign(request: FastifyRequest, group: string | null): Promise<boolean> {
    const claims = request.user as JwtPayload;
    if (isAdminUser(claims)) return true;
    if (!group || !claims.groups?.includes(group)) return false;
    return await fetchUserType(claims.preferred_username) === 'supervisor';
  }

  private canDelete(claims: JwtPayload, booking: Awaited<ReturnType<BookingService['findById']>>): boolean {
    if (isAdminUser(claims)) return true;
    const username = claims.preferred_username;
    return booking.requestedBy === username
      || booking.assigneeId === claims.sub
      || booking.assigneeName === username;
  }
}
