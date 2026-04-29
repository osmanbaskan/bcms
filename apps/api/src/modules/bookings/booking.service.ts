import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { BCMS_GROUPS, PERMISSIONS, type BcmsGroup, type JwtPayload } from '@bcms/shared';
import type { CreateBookingDto, UpdateBookingDto } from './booking.schema.js';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { writeAuditLog } from '../../middleware/audit.js';
import type { EmailPayload } from '../notifications/notification.consumer.js';
import { readFirstWorksheetRows, rowsToObjects } from '../../lib/excel.js';

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

let adminToken: string | null = null;
let tokenExpiry = 0;

function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw Object.assign(new Error(`${name} is required in production`), { statusCode: 500 });
  }
  return fallback;
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

function isSistem Muhendisligi(claims: JwtPayload): boolean {
  return claims.groups?.some((group) => PERMISSIONS.weeklyShifts.admin.includes(group as BcmsGroup)) ?? false;
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

async function getAdminToken(): Promise<string> {
  if (adminToken && Date.now() < tokenExpiry - 10_000) return adminToken;

  const url = envOrDefault('KEYCLOAK_URL', 'http://localhost:8080');
  const username = envOrDefault('KEYCLOAK_ADMIN', 'admin');
  const password = envOrDefault('KEYCLOAK_ADMIN_PASSWORD', 'changeme_kc');

  const res = await fetch(`${url}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username, password }),
  });

  if (!res.ok) throw Object.assign(new Error('Keycloak admin auth failed'), { statusCode: 502 });
  const data = await res.json() as { access_token: string; expires_in: number };
  adminToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return adminToken;
}

async function kcFetch(path: string, options: RequestInit = {}) {
  const url = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
  const realm = process.env.KEYCLOAK_REALM ?? 'bcms';
  const token = await getAdminToken();
  const res = await fetch(`${url}/admin/realms/${realm}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`Keycloak error: ${res.status} ${text}`), { statusCode: res.status });
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function fetchUserType(username: string): Promise<UserType> {
  const users: any[] = await kcFetch(`/users?username=${encodeURIComponent(username)}&exact=true&max=1`);
  return normalizeUserType(keycloakAttributeValue(users[0]?.attributes, 'bcmsUserType'));
}

async function fetchGroupUsers(group: string): Promise<AssignableUser[]> {
  const users: any[] = await kcFetch('/users?max=500');
  const mapped = await Promise.all(users.map(async (user) => {
    const kcGroups: any[] = await kcFetch(`/users/${user.id}/groups`);
    const groups = kcGroups.map((g) => g.name as string).filter(isBcmsGroup);
    return {
      id: user.id,
      username: user.username,
      displayName: displayName(user),
      email: user.email ?? '',
      userType: normalizeUserType(keycloakAttributeValue(user.attributes, 'bcmsUserType')),
      groups,
    };
  }));
  return mapped
    .filter((user) => user.groups.some((userGroup) => userGroup === group))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'tr'));
}

async function fetchUserDisplayNameMap(): Promise<Map<string, string>> {
  const users: any[] = await kcFetch('/users?max=500');
  return new Map(users.map((user) => [user.username, displayName(user)]));
}

export class BookingService {
  constructor(private readonly app: FastifyInstance) {}

  async findAll(request: FastifyRequest, scheduleId?: number, group?: string, page = 1, pageSize = 50) {
    const claims = request.user as JwtPayload;
    const visibleGroups = this.visibleGroups(claims);
    const currentUserType = isSistem Muhendisligi(claims) ? 'supervisor' : await fetchUserType(claims.preferred_username);
    const canAssignGroups = isSistem Muhendisligi(claims) || currentUserType === 'supervisor' ? visibleGroups : [];
    const selectedGroup = group && isBcmsGroup(group) && visibleGroups.includes(group) ? group : undefined;
    const skip = (page - 1) * pageSize;
    const where = {
      ...(scheduleId && { scheduleId }),
      ...(selectedGroup
        ? { userGroup: selectedGroup }
        : isSistem Muhendisligi(claims)
          ? { OR: [{ userGroup: { in: visibleGroups } }, { userGroup: null }] }
          : { userGroup: { in: visibleGroups } }),
    } as any;
    const [data, total, displayNames] = await Promise.all([
      this.app.prisma.booking.findMany({
        where,
        skip,
        take: pageSize,
        include: { team: true, schedule: { include: { channel: true } } },
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
      include: { team: true, schedule: { include: { channel: true } } },
    });
    if (!booking) throw Object.assign(new Error('Booking not found'), { statusCode: 404 });
    return booking;
  }

  async findByIdForRequest(id: number, claims: JwtPayload) {
    const booking = await this.findById(id);
    if (!this.canSee(claims, (booking as any).userGroup)) {
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

    if (dto.scheduleId) {
      const schedule = await this.app.prisma.schedule.findUnique({ where: { id: dto.scheduleId } });
      if (!schedule) throw Object.assign(new Error('Schedule not found'), { statusCode: 404 });
    }

    const booking = await this.app.prisma.booking.create({
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
      } as any,
      include: { team: true, schedule: { include: { channel: true } } },
    });

    await writeAuditLog(this.app, { entityType: 'Booking', entityId: booking.id, action: 'CREATE', after: booking, request });
    await this.app.rabbitmq.publish(QUEUES.BOOKING_CREATED, { bookingId: booking.id, scheduleId: booking.scheduleId });

    return booking;
  }

  async update(id: number, dto: UpdateBookingDto, ifMatchVersion: number | undefined, request: FastifyRequest) {
    const claims = request.user as JwtPayload;
    const existing = await this.findByIdForRequest(id, claims);
    const canAssign = await this.canAssign(request, (existing as any).userGroup);

    if (ifMatchVersion !== undefined && existing.version !== ifMatchVersion) {
      throw Object.assign(
        new Error(`Version conflict: expected ${ifMatchVersion}, got ${existing.version}`),
        { statusCode: 412 },
      );
    }

    if ((dto.assigneeId !== undefined || dto.assigneeName !== undefined) && !canAssign) {
      throw Object.assign(new Error('Sorumlu kullanıcı seçme yetkiniz yok'), { statusCode: 403 });
    }

    const data = {
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
    } as any;

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
        include: { team: true, schedule: { include: { channel: true } } },
      });
    });

    await writeAuditLog(this.app, { entityType: 'Booking', entityId: id, action: 'UPDATE', before: existing, after: updated, request });

    if (dto.status && STATUS_LABELS[dto.status]) {
      const label = STATUS_LABELS[dto.status];
      const emailPayload: EmailPayload = {
        to: existing.requestedBy,
        subject: `İş kaydınız ${label}`,
        body: `Merhaba ${existing.requestedBy},\n\n${id} numaralı iş kaydınız ${label}.\n\nBCMS`,
      };
      await this.app.rabbitmq.publish(QUEUES.NOTIFICATIONS_EMAIL, emailPayload);
    }

    return updated;
  }

  async remove(id: number) {
    await this.findById(id);
    await this.app.prisma.booking.delete({ where: { id } });
  }

  async removeForRequest(id: number, request: FastifyRequest) {
    const claims = request.user as JwtPayload;
    const booking = await this.findByIdForRequest(id, claims);
    if (!this.canDelete(claims, booking)) {
      throw Object.assign(new Error('Bu işi silme yetkiniz yok'), { statusCode: 403 });
    }
    await this.app.prisma.booking.delete({ where: { id } });
    await writeAuditLog(this.app, { entityType: 'Booking', entityId: id, action: 'DELETE', before: booking, request });
  }

  async importFromBuffer(buffer: Buffer, request: FastifyRequest): Promise<ImportResult> {
    const user = (request.user as { preferred_username: string }).preferred_username;

    const rows = rowsToObjects(await readFirstWorksheetRows(buffer));
    if (rows.length === 0) throw Object.assign(new Error('Excel dosyası boş'), { statusCode: 400 });

    const result: ImportResult = { created: 0, skipped: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

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

  private visibleGroups(claims: JwtPayload): BcmsGroup[] {
    if (isSistem Muhendisligi(claims)) return [...BCMS_GROUPS];
    return tokenGroups(claims);
  }

  private canSee(claims: JwtPayload, group: string | null): boolean {
    if (isSistem Muhendisligi(claims)) return true;
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
    if (isSistem Muhendisligi(claims)) return true;
    if (!group || !claims.groups?.includes(group)) return false;
    return await fetchUserType(claims.preferred_username) === 'supervisor';
  }

  private canDelete(claims: JwtPayload, booking: Awaited<ReturnType<BookingService['findById']>>): boolean {
    if (isSistem Muhendisligi(claims)) return true;
    const username = claims.preferred_username;
    const task = booking as any;
    return task.requestedBy === username
      || task.assigneeId === claims.sub
      || task.assigneeName === username;
  }
}
