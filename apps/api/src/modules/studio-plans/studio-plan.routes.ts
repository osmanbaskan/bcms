import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  type SaveStudioPlanCatalogDto,
  type StudioPlan,
  type StudioPlanCatalog,
  type StudioPlanSlot,
} from '@bcms/shared';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeSchema = z.string().regex(/^\d{2}:\d{2}$/);

const slotSchema = z.object({
  day: dateSchema,
  studio: z.string().min(1).max(100),
  time: timeSchema,
  startMinute: z.number().int().min(0).max(24 * 60 + 120).optional(),
  program: z.string().min(1).max(300),
  color: z.string().min(1).max(20),
});

const saveStudioPlanSchema = z.object({
  slots: z.array(slotSchema).max(7 * 5 * 40),
});

const catalogProgramSchema = z.object({
  name: z.string().min(1).max(300),
  sortOrder: z.number().int().min(0).max(10_000),
  active: z.boolean(),
});

const catalogColorSchema = z.object({
  label: z.string().min(1).max(100),
  value: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  sortOrder: z.number().int().min(0).max(10_000),
  active: z.boolean(),
});

const saveCatalogSchema = z.object({
  programs: z.array(catalogProgramSchema).max(200),
  colors: z.array(catalogColorSchema).max(100),
});

interface DbStudioPlanSlot {
  id: number;
  dayDate: Date;
  studio: string;
  startMinute: number;
  program: string;
  color: string;
}

interface DbStudioPlanWithSlots {
  id: number;
  weekStart: Date;
  version: number;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  slots: DbStudioPlanSlot[];
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function timeToMinute(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  const normalizedHour = hour < 6 ? hour + 24 : hour;
  return normalizedHour * 60 + minute;
}

function minuteToTime(value: number): string {
  const hour = Math.floor(value / 60) % 24;
  const minute = value % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function assertMonday(value: string): void {
  const date = parseDate(value);
  if (date.getUTCDay() !== 1) {
    throw Object.assign(new Error('weekStart must be a Monday date'), { statusCode: 400 });
  }
}

function mapSlot(slot: DbStudioPlanSlot): StudioPlanSlot {
  return {
    id: slot.id,
    day: dateOnly(slot.dayDate),
    studio: slot.studio,
    time: minuteToTime(slot.startMinute),
    startMinute: slot.startMinute,
    program: slot.program,
    color: slot.color,
  };
}

function emptyPlan(weekStart: string): StudioPlan {
  return {
    id: 0,
    weekStart,
    version: 0,
    createdBy: '',
    updatedBy: null,
    createdAt: '',
    updatedAt: '',
    slots: [],
  };
}

function mapPlan(plan: DbStudioPlanWithSlots): StudioPlan {
  return {
    id: plan.id,
    weekStart: dateOnly(plan.weekStart),
    version: plan.version,
    createdBy: plan.createdBy,
    updatedBy: plan.updatedBy,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
    slots: plan.slots.map(mapSlot),
  };
}

interface UsageAggRow {
  program: string; color: string;
  slotCount: number; totalMinutes: number; dayCount: number;
  studios: { studio: string; slotCount: number; totalMinutes: number }[];
}

function fmtHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} sa` : `${h} sa ${m} dk`;
}

async function queryStudioUsage(app: FastifyInstance, from: string, to: string): Promise<UsageAggRow[]> {
  const rows = await app.prisma.$queryRaw<{
    program: string; color: string; studio: string;
    slot_count: bigint; day_count: bigint;
  }[]>`
    SELECT program, color, studio,
           COUNT(*)                 AS slot_count,
           COUNT(DISTINCT day_date) AS day_count
    FROM studio_plan_slots sps
    JOIN studio_plans sp ON sp.id = sps.plan_id
    WHERE sps.day_date >= ${parseDate(from)}
      AND sps.day_date <= ${parseDate(to)}
    GROUP BY program, color, studio
    ORDER BY COUNT(*) DESC, program ASC
  `;

  const map = new Map<string, UsageAggRow>();
  for (const r of rows) {
    const sc = Number(r.slot_count);
    if (!map.has(r.program)) {
      map.set(r.program, { program: r.program, color: r.color, slotCount: 0, totalMinutes: 0, dayCount: 0, studios: [] });
    }
    const entry = map.get(r.program)!;
    entry.slotCount    += sc;
    entry.totalMinutes += sc * 30;
    entry.dayCount      = Math.max(entry.dayCount, Number(r.day_count));
    entry.studios.push({ studio: r.studio, slotCount: sc, totalMinutes: sc * 30 });
  }
  return Array.from(map.values()).sort((a, b) => b.totalMinutes - a.totalMinutes);
}

async function getCatalog(app: FastifyInstance): Promise<StudioPlanCatalog> {
  const [programs, colors] = await Promise.all([
    app.prisma.studioPlanProgram.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    app.prisma.studioPlanColor.findMany({ orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] }),
  ]);

  return {
    programs,
    colors,
  };
}

const usageQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).refine((d) => d.from <= d.to, { message: 'from must be ≤ to', path: ['to'] })
  .refine(
    (d) => {
      const diffMs = new Date(d.to).getTime() - new Date(d.from).getTime();
      return diffMs <= 366 * 24 * 60 * 60 * 1000;
    },
    { message: 'Tarih aralığı en fazla 366 gün olabilir', path: ['to'] },
  );

export async function studioPlanRoutes(app: FastifyInstance) {

  const fastifyUsageQuerySchema = {
    type: 'object',
    required: ['from', 'to'],
    properties: {
      from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    },
  };

  // GET /api/v1/studio-plans/reports/usage?from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get('/reports/usage', {
    preHandler: app.requireGroup(...PERMISSIONS.studioPlans.read),
    schema: { tags: ['Studio Plans'], summary: 'Program bazlı stüdyo kullanım raporu', querystring: fastifyUsageQuerySchema },
  }, async (request) => {
    const { from, to } = usageQuerySchema.parse(request.query);
    return queryStudioUsage(app, from, to);
  });

  // GET /api/v1/studio-plans/reports/usage/export?from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get('/reports/usage/export', {
    preHandler: app.requireGroup(...PERMISSIONS.studioPlans.read),
    schema: { tags: ['Studio Plans'], summary: 'Stüdyo kullanım raporunu Excel olarak dışa aktar', querystring: fastifyUsageQuerySchema },
  }, async (request, reply) => {
    const { from, to } = usageQuerySchema.parse(request.query);
    const data = await queryStudioUsage(app, from, to);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'BCMS';
    const sheet = workbook.addWorksheet('Stüdyo Kullanım');

    sheet.columns = [
      { header: '#',              width: 6  },
      { header: 'Program',        width: 40 },
      { header: 'Renk',           width: 10 },
      { header: 'Slot Sayısı',    width: 12 },
      { header: 'Toplam Dk',      width: 12 },
      { header: 'Toplam Saat',    width: 16 },
      { header: 'Gün Sayısı',     width: 12 },
      { header: 'Stüdyo Dağılımı', width: 60 },
    ];
    sheet.getRow(1).font = { bold: true };

    data.forEach((row, i) => {
      sheet.addRow([
        i + 1,
        row.program,
        row.color,
        row.slotCount,
        row.totalMinutes,
        fmtHours(row.totalMinutes),
        row.dayCount,
        row.studios.map((s) => `${s.studio}: ${s.totalMinutes} dk`).join(', '),
      ]);
    });

    const totalSlots = data.reduce((s, r) => s + r.slotCount, 0);
    const totalMins  = data.reduce((s, r) => s + r.totalMinutes, 0);
    const totalRow = sheet.addRow(['', 'TOPLAM', '', totalSlots, totalMins, fmtHours(totalMins), '', '']);
    totalRow.font = { bold: true };

    // HIGH-API-017 fix (2026-05-05): buffer-based output → write hatası 500'de.
    const buffer = await workbook.xlsx.writeBuffer();
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="studio-usage_${from}_${to}.xlsx"`)
      .send(Buffer.from(buffer));
  });

  app.get('/catalog', {
    preHandler: app.requireGroup(...PERMISSIONS.studioPlans.read),
    schema: { tags: ['Studio Plans'], summary: 'Get studio plan program and color catalog' },
  }, async () => getCatalog(app));

  app.put('/catalog', {
    preHandler: app.requireGroup(...PERMISSIONS.studioPlans.write),
    schema: { tags: ['Studio Plans'], summary: 'Replace studio plan program and color catalog' },
  }, async (request) => {
    const dto = saveCatalogSchema.parse(request.body) satisfies SaveStudioPlanCatalogDto;

    await app.prisma.$transaction(async (tx) => {
      await tx.studioPlanProgram.deleteMany();
      await tx.studioPlanColor.deleteMany();

      if (dto.programs.length > 0) {
        await tx.studioPlanProgram.createMany({ data: dto.programs });
      }
      if (dto.colors.length > 0) {
        await tx.studioPlanColor.createMany({ data: dto.colors });
      }
    });

    return getCatalog(app);
  });

  app.get<{ Params: { weekStart: string } }>('/:weekStart', {
    preHandler: app.requireGroup(...PERMISSIONS.studioPlans.read),
    schema: { tags: ['Studio Plans'], summary: 'Get one weekly studio plan' },
  }, async (request) => {
    const weekStart = dateSchema.parse(request.params.weekStart);
    assertMonday(weekStart);

    const plan = await app.prisma.studioPlan.findUnique({
      where: { weekStart: parseDate(weekStart) },
      include: {
        slots: {
          orderBy: [
            { dayDate: 'asc' },
            { studio: 'asc' },
            { startMinute: 'asc' },
          ],
        },
      },
    });

    return plan ? mapPlan(plan) : emptyPlan(weekStart);
  });

  app.put<{ Params: { weekStart: string } }>('/:weekStart', {
    preHandler: app.requireGroup(...PERMISSIONS.studioPlans.write),
    schema: { tags: ['Studio Plans'], summary: 'Replace one weekly studio plan' },
  }, async (request) => {
    const weekStart = dateSchema.parse(request.params.weekStart);
    assertMonday(weekStart);
    const dto = saveStudioPlanSchema.parse(request.body);
    const user = (request.user as { preferred_username?: string })?.preferred_username ?? 'unknown';

    const weekStartDate = parseDate(weekStart);
    const saved = await app.prisma.$transaction(async (tx) => {
      const plan = await tx.studioPlan.upsert({
        where: { weekStart: weekStartDate },
        update: {
          updatedBy: user,
          version: { increment: 1 },
        },
        create: {
          weekStart: weekStartDate,
          createdBy: user,
          updatedBy: user,
        },
      });

      await tx.studioPlanSlot.deleteMany({ where: { planId: plan.id } });

      if (dto.slots.length > 0) {
        await tx.studioPlanSlot.createMany({
          data: dto.slots.map((slot) => ({
            planId: plan.id,
            dayDate: parseDate(slot.day),
            studio: slot.studio,
            startMinute: slot.startMinute ?? timeToMinute(slot.time),
            program: slot.program,
            color: slot.color,
          })),
        });
      }

      return tx.studioPlan.findUniqueOrThrow({
        where: { id: plan.id },
        include: {
          slots: {
            orderBy: [
              { dayDate: 'asc' },
              { studio: 'asc' },
              { startMinute: 'asc' },
            ],
          },
        },
      });
    });

    return mapPlan(saved);
  });
}
