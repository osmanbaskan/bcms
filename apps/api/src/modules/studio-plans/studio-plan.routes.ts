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

export async function studioPlanRoutes(app: FastifyInstance) {
  app.get('/catalog', {
    preHandler: app.requireRole(...PERMISSIONS.studioPlans.read),
    schema: { tags: ['Studio Plans'], summary: 'Get studio plan program and color catalog' },
  }, async () => getCatalog(app));

  app.put('/catalog', {
    preHandler: app.requireRole(...PERMISSIONS.studioPlans.write),
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
    preHandler: app.requireRole(...PERMISSIONS.studioPlans.read),
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
    preHandler: app.requireRole(...PERMISSIONS.studioPlans.write),
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
