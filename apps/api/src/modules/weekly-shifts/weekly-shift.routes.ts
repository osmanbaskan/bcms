import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BCMS_GROUPS, PERMISSIONS, type BcmsGroup, type JwtPayload } from '@bcms/shared';
import { kcFetch } from '../../core/keycloak-admin.client.js';

const SHIFT_TYPES = [
  { code: 'OFF_DAY', label: 'Haftalık İzin' },
  { code: 'HOME', label: 'Evden' },
  { code: 'OUTSIDE', label: 'Dış Görev' },
  { code: 'NIGHT', label: 'Gece' },
  { code: 'SIC_CER', label: 'Rapor' },
  { code: 'HOLIDAY', label: 'Resmi Tatil' },
  { code: 'ANNUAL', label: 'Yıllık İzin' },
];

type UserType = 'staff' | 'supervisor';

interface ShiftUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  userType: UserType;
  groups: string[];
}

interface ShiftInput {
  userId: string;
  userName: string;
  dayIndex: number;
  startTime?: string | null;
  endTime?: string | null;
  type: string;
}

/** HIGH-API-011 fix (2026-05-05): PUT /:group body Zod parse — Fastify
 *  schema'yı destekliyoruz ama runtime garanti için Zod ekstra. type alanı
 *  SHIFT_TYPES.code enum'u + boş string'e izin verilir; dayIndex 0..6 zorunlu;
 *  weekStart ISO date. */
const HH_MM_REGEX = /^\d{2}:\d{2}$/;
const shiftInputSchema = z.object({
  userId:    z.string().trim().min(1).max(64),
  userName:  z.string().trim().min(1).max(128),
  dayIndex:  z.number().int().min(0).max(6),
  startTime: z.string().regex(HH_MM_REGEX).nullable().optional(),
  endTime:   z.string().regex(HH_MM_REGEX).nullable().optional(),
  type:      z.string().refine(
    (s) => s === '' || SHIFT_TYPES.some((t) => t.code === s),
    'Geçersiz shift type'),
});

const shiftUpdateSchema = z.object({
  weekStart:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD bekleniyor'),
  assignments: z.array(shiftInputSchema).max(500),
});

function normalizeUserType(value: unknown): UserType {
  return value === 'supervisor' ? 'supervisor' : 'staff';
}

function keycloakAttributeValue(attributes: any, key: string): string | undefined {
  const value = attributes?.[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

function displayName(user: any): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || user.username || user.id;
}

function mondayOf(date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

function formatDateTR(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function weekDays(weekStart: string) {
  const names = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  return names.map((name, index) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + index);
    const iso = d.toISOString().slice(0, 10);
    return { index, name, date: iso, dateTR: formatDateTR(iso) };
  });
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

async function fetchShiftUsers(): Promise<ShiftUser[]> {
  const users = await kcFetch<any[]>('/users?max=500');
  const memberships = await fetchBcmsGroupMemberships();
  return users.map((user) => {
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
}

async function fetchCurrentUserType(request: FastifyRequest): Promise<UserType> {
  const username = (request.user as JwtPayload | undefined)?.preferred_username;
  if (!username) return 'staff';
  const users = await kcFetch<any[]>(`/users?username=${encodeURIComponent(username)}&exact=true&max=1`);
  return normalizeUserType(keycloakAttributeValue(users[0]?.attributes, 'bcmsUserType'));
}

function hasAnyGroup(userGroups: readonly string[], allowedGroups: readonly BcmsGroup[]): boolean {
  return allowedGroups.some((group) => userGroups.includes(group));
}

function isKnownGroup(group: string): group is BcmsGroup {
  return (BCMS_GROUPS as readonly string[]).includes(group);
}

function visibleGroupsFor(request: FastifyRequest): readonly BcmsGroup[] {
  const userGroups = (request.user as JwtPayload).groups ?? [];
  if (hasAnyGroup(userGroups, PERMISSIONS.weeklyShifts.admin)) return BCMS_GROUPS;
  return BCMS_GROUPS.filter((group) => userGroups.includes(group));
}

async function canEditGroup(request: FastifyRequest, group: string): Promise<boolean> {
  const claims = request.user as JwtPayload;
  const userGroups = claims.groups ?? [];
  if (hasAnyGroup(userGroups, PERMISSIONS.weeklyShifts.admin)) return true;
  return userGroups.includes(group) && await fetchCurrentUserType(request) === 'supervisor';
}

/** HIGH-API-014 fix (2026-05-05): supervisor flag'i tek seferde hesapla;
 *  visibleGroups loop'unda canEditGroup'u tekrar tekrar Keycloak'a sormaktan
 *  vazgeç. */
function canEditGroupSync(claims: JwtPayload, group: string, isSupervisor: boolean): boolean {
  const userGroups = claims.groups ?? [];
  if (hasAnyGroup(userGroups, PERMISSIONS.weeklyShifts.admin)) return true;
  return userGroups.includes(group) && isSupervisor;
}

async function buildWeeklyShiftPlan(app: FastifyInstance, request: FastifyRequest, weekStart: string) {
  const claims = request.user as JwtPayload;
  // HIGH-API-014: visibleGroups her biri için fetchCurrentUserType (KC HTTP)
  // çağırıyordu. Tek sefer hesapla, supervisor bayrağını paylaş.
  const isSupervisor = hasAnyGroup(claims.groups ?? [], PERMISSIONS.weeklyShifts.admin)
    ? true
    : (await fetchCurrentUserType(request)) === 'supervisor';

  const [users, assignments] = await Promise.all([
    fetchShiftUsers(),
    app.prisma.shiftAssignment.findMany({
      where: { weekStart, deletedAt: null },
      orderBy: [{ userGroup: 'asc' }, { userName: 'asc' }, { dayIndex: 'asc' }],
    }),
  ]);

  const assignmentsByUser = new Map<string, typeof assignments>();
  for (const item of assignments) {
    const list = assignmentsByUser.get(item.userId) ?? [];
    list.push(item);
    assignmentsByUser.set(item.userId, list);
  }

  const visibleGroups = visibleGroupsFor(request);
  const groups = visibleGroups.map((name) => {
    const members = users
      .filter((user) => user.groups.includes(name))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'tr'));
    return {
      name,
      canEdit: canEditGroupSync(claims, name, isSupervisor),
      users: members.map((user) => ({
        ...user,
        assignments: Object.fromEntries(
          (assignmentsByUser.get(user.id) ?? []).map((item) => [
            item.dayIndex,
            {
              id: item.id,
              startTime: item.startTime,
              endTime: item.endTime,
              type: item.type,
            },
          ]),
        ),
      })),
    };
  });

  return { weekStart, days: weekDays(weekStart), shiftTypes: SHIFT_TYPES, groups };
}

function shiftTypeLabel(code: string): string {
  return SHIFT_TYPES.find((type) => type.code === code)?.label ?? code;
}

function shiftCellDisplay(cell: { startTime?: string | null; endTime?: string | null; type?: string }): string {
  const type = cell.type ?? '';
  if (!type || type === 'WORK') {
    const start = cell.startTime ?? '';
    const end = cell.endTime ?? '';
    if (start && end) return `${start} - ${end}`;
    if (start) return start;
    if (end) return end;
    return '';
  }
  return shiftTypeLabel(type);
}

function shiftTypeColor(code: string): { font: string; bg: string } {
  const map: Record<string, { font: string; bg: string }> = {
    OFF_DAY:  { font: "FF3B82F6", bg: "FF1E3A5F" },
    HOME:     { font: "FF10B981", bg: "FF064E3B" },
    OUTSIDE:  { font: "FFF59E0B", bg: "FF78350F" },
    NIGHT:    { font: "FF6366F1", bg: "FF312E81" },
    SIC_CER:  { font: "FFEF4444", bg: "FF7F1D1D" },
    HOLIDAY:  { font: "FF8B5CF6", bg: "FF4C1D95" },
    ANNUAL:   { font: "FF06B6D4", bg: "FF164E63" },
  };
  return map[code] ?? { font: "FF94A3B8", bg: "FF1E293B" };
}

function shiftCellExcel(cell: { startTime?: string | null; endTime?: string | null; type?: string }): { value: string; style: Partial<ExcelJS.Style> } {
  const type = cell.type ?? "";
  const base: Partial<ExcelJS.Style> = { alignment: { vertical: "middle", horizontal: "center" }, font: { size: 10, color: { argb: "FF94A3B8" } } };
  if (!type || type === "WORK") {
    const start = cell.startTime ?? "";
    const end = cell.endTime ?? "";
    if (start && end) return { value: `${start} – ${end}`, style: { ...base, font: { bold: true, size: 10, color: { argb: "FF22C55E" } } } };
    if (start || end) return { value: start || end, style: { ...base, font: { bold: true, size: 10, color: { argb: "FF22C55E" } } } };
    return { value: "—", style: base };
  }
  const colors = shiftTypeColor(type);
  const label = shiftTypeLabel(type);
  return { value: label, style: { ...base, font: { bold: true, size: 10, color: { argb: colors.font } }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: colors.bg } } } };

}

async function exportWeeklyShiftToStream(plan: Awaited<ReturnType<typeof buildWeeklyShiftPlan>>) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BCMS';
  workbook.created = new Date();

  const titleFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  const titleFont: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14 };
  const groupFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  const groupFont: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FF38BDF8' }, size: 12 };
  const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  const headerFont: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFCBD5E1' }, size: 10 };
  const personFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  const personFont: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFF8FAFC' }, size: 11 };
  const evenFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } };
  const oddFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1120' } };
  const borderColor = { argb: 'FF1E293B' };
  const thinBorder: Partial<ExcelJS.Borders> = {
    top:    { style: 'thin', color: borderColor },
    left:   { style: 'thin', color: borderColor },
    bottom: { style: 'thin', color: borderColor },
    right:  { style: 'thin', color: borderColor },
  };

  for (const group of plan.groups) {
    const sheet = workbook.addWorksheet(group.name.slice(0, 31));
    const totalCols = 1 + plan.days.length;

    const weekStartTR = formatDateTR(plan.weekStart);
    const weekEnd = new Date(`${plan.weekStart}T00:00:00`);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const weekEndStr = formatDateTR(weekEnd.toISOString().slice(0, 10));

    // Ana başlık satırı
    sheet.addRow([`Haftalik Shift Plani  |  ${weekStartTR}  ->  ${weekEndStr}`]);
    sheet.mergeCells(1, 1, 1, totalCols);
    const titleRow = sheet.getRow(1);
    titleRow.height = 36;
    titleRow.eachCell((cell) => {
      cell.fill = titleFill;
      cell.font = titleFont;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = thinBorder;
    });

    // Grup basligi satiri
    sheet.addRow([`${group.name}  |  ${group.users.length} personel`]);
    sheet.mergeCells(2, 1, 2, totalCols);
    const groupRow = sheet.getRow(2);
    groupRow.height = 26;
    groupRow.eachCell((cell) => {
      cell.fill = groupFill;
      cell.font = groupFont;
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      cell.border = thinBorder;
    });

    // Gun basliklari (Row 3)
    const dayHeaderRow = sheet.addRow(['Personel', ...plan.days.map((day) => `${day.name}\n${day.dateTR}`)]);
    dayHeaderRow.height = 34;
    dayHeaderRow.eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = thinBorder;
    });

    // Veri satirlari
    group.users.forEach((user, userIndex) => {
      const rowFill = userIndex % 2 === 0 ? oddFill : evenFill;
      const dataRow = sheet.addRow([user.displayName, ...plan.days.map(() => '')]);
      dataRow.height = 28;

      // Personel kolonu
      const personCell = dataRow.getCell(1);
      personCell.value = user.displayName;
      personCell.fill = personFill;
      personCell.font = personFont;
      personCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      personCell.border = thinBorder;

      // Gun hucreleri
      plan.days.forEach((day, dayIdx) => {
        const cellObj = user.assignments[String(day.index)] ?? {};
        const rendered = shiftCellExcel(cellObj);
        const cell = dataRow.getCell(dayIdx + 2);
        cell.value = rendered.value;
        if (rendered.style.alignment) cell.alignment = rendered.style.alignment;
        if (rendered.style.font)      cell.font      = rendered.style.font;
        cell.border = thinBorder;
        cell.fill = rendered.style.fill ?? rowFill;
      });
    });

    // Kolon genislikleri
    sheet.columns = [
      { width: 30 },
      ...plan.days.map(() => ({ width: 20 })),
    ];

    // Freeze panes: ilk kolon ve ilk 3 satir sabit kalsin
    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];
  }

  const stream = new PassThrough();
  void workbook.xlsx.write(stream).then(() => stream.end()).catch((err) => stream.destroy(err));
  return stream;
}

export async function weeklyShiftRoutes(app: FastifyInstance) {
  app.get('/', {
    preHandler: app.requireGroup(),
    schema: { tags: ['Weekly Shifts'], summary: 'Haftalık shift planı' },
  }, async (request) => {
    const q = request.query as { weekStart?: string };
    const weekStart = q.weekStart?.match(/^\d{4}-\d{2}-\d{2}$/) ? q.weekStart : mondayOf();

    return buildWeeklyShiftPlan(app, request, weekStart);
  });

  app.get('/export', {
    preHandler: app.requireGroup(),
    schema: { tags: ['Weekly Shifts'], summary: 'Haftalık shift Excel export' },
  }, async (request, reply) => {
    const q = request.query as { weekStart?: string };
    const weekStart = q.weekStart?.match(/^\d{4}-\d{2}-\d{2}$/) ? q.weekStart : mondayOf();
    const plan = await buildWeeklyShiftPlan(app, request, weekStart);
    const stream = await exportWeeklyShiftToStream(plan);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="weekly-shift_${weekStart}.xlsx"`)
      .send(stream);
  });

  app.put<{ Params: { group: string }; Body: { weekStart: string; assignments: ShiftInput[] } }>('/:group', {
    preHandler: app.requireGroup(),
    schema: {
      tags: ['Weekly Shifts'],
      summary: 'Grup haftalık shift planını güncelle',
      params: { type: 'object', properties: { group: { type: 'string' } }, required: ['group'] },
      body: {
        type: 'object',
        required: ['weekStart', 'assignments'],
        properties: {
          weekStart: { type: 'string' },
          assignments: {
            type: 'array',
            items: {
              type: 'object',
              required: ['userId', 'userName', 'dayIndex', 'type'],
              properties: {
                userId: { type: 'string' },
                userName: { type: 'string' },
                dayIndex: { type: 'number' },
                startTime: { type: ['string', 'null'] },
                endTime: { type: ['string', 'null'] },
                type: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const group = decodeURIComponent(request.params.group);
    if (!isKnownGroup(group)) throw Object.assign(new Error('Bilinmeyen grup'), { statusCode: 400 });
    if (!await canEditGroup(request, group)) throw Object.assign(new Error('Bu grubu düzenleme yetkiniz yok'), { statusCode: 403 });

    // HIGH-API-011 fix: Zod parse — assignments tipi/sınırları runtime garanti.
    const body = shiftUpdateSchema.parse(request.body);

    const users = await fetchShiftUsers();
    const members = new Map(users.filter((user) => user.groups.includes(group)).map((user) => [user.id, user]));
    const rows = body.assignments
      .filter((item) => members.has(item.userId))
      .map((item) => ({
        userId: item.userId,
        userName: members.get(item.userId)?.displayName ?? item.userName,
        userGroup: group,
        weekStart: body.weekStart,
        dayIndex: item.dayIndex,
        startTime: item.type ? null : item.startTime || null,
        endTime: item.type ? null : item.endTime || null,
        type: item.type || '',
      }));

    await app.prisma.$transaction([
      app.prisma.shiftAssignment.deleteMany({ where: { weekStart: body.weekStart, userGroup: group } }),
      ...(rows.length ? [app.prisma.shiftAssignment.createMany({ data: rows })] : []),
    ]);

    return { ok: true };
  });
}
