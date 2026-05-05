import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { PERMISSIONS, type SaveIngestPlanItemDto, type SaveRecordingPortsDto } from '@bcms/shared';
import { validateIngestSourcePath } from './ingest.paths.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ingestPlanStatusSchema = z.enum(['WAITING', 'RECEIVED', 'INGEST_STARTED', 'COMPLETED', 'ISSUE']);

const listQuerySchema = z.object({
  status:   z.enum(['PENDING','PROCESSING','PROXY_GEN','QC','COMPLETED','FAILED']).optional(),
  page:     z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

const planQuerySchema = z.object({
  date: dateSchema.optional(),
});

const createIngestSchema = z.object({
  sourcePath: z.string().min(1),
  targetId:   z.number().int().positive().optional(),
  metadata:   z.record(z.unknown()).optional(),
});

const callbackSchema = z.object({
  // MED-API-007 fix (2026-05-05): jobId pozitif olmalı; 0/negatif geçerse
  // Prisma'da `where: { id: 0 }` "not found" hatası verir ama erken validate
  // daha doğru.
  jobId:     z.number().int().positive(),
  status:    z.enum(['PENDING', 'PROCESSING', 'PROXY_GEN', 'QC', 'COMPLETED', 'FAILED']),
  proxyPath: z.string().optional(),
  checksum:  z.string().optional(),
  errorMsg:  z.string().optional(),
  qcReport:  z.object({
    codec:      z.string().optional(),
    resolution: z.string().optional(),
    duration:   z.number().optional(),
    frameRate:  z.number().optional(),
    bitrate:    z.number().int().optional(),
    loudness:   z.number().optional(),
    errors:     z.array(z.unknown()).optional(),
    warnings:   z.array(z.unknown()).optional(),
    passed:     z.boolean(),
  }).optional(),
});

const savePlanItemSchema = z.object({
  sourceType: z.string().min(1).max(30),
  day: dateSchema,
  sourcePath: z.string().trim().optional().nullable(),
  recordingPort: z.string().trim().max(50).optional().nullable(),
  backupRecordingPort: z.string().trim().max(50).optional().nullable(),
  plannedStartMinute: z.number().int().min(0).max(48 * 60).optional().nullable(),
  plannedEndMinute: z.number().int().min(0).max(48 * 60).optional().nullable(),
  status: ingestPlanStatusSchema.optional(),
  note: z.string().trim().optional().nullable(),
}).refine(
  (value) => (
    value.plannedStartMinute == null
    || value.plannedEndMinute == null
    || value.plannedStartMinute < value.plannedEndMinute
  ),
  { message: 'Plan başlangıç dakikası bitişten küçük olmalıdır', path: ['plannedEndMinute'] },
).refine(
  // Aynı item'da ana ve yedek port aynı olamaz
  (value) => {
    const p = value.recordingPort?.trim();
    const b = value.backupRecordingPort?.trim();
    return !p || !b || p !== b;
  },
  { message: 'Ana ve yedek port aynı olamaz', path: ['backupRecordingPort'] },
).refine(
  // Yedek port seçildiyse ana port da gerekli
  (value) => !value.backupRecordingPort?.trim() || !!value.recordingPort?.trim(),
  { message: 'Yedek port için ana port da seçilmelidir', path: ['backupRecordingPort'] },
);

const recordingPortSchema = z.object({
  name: z.string().trim().min(1).max(50),
  sortOrder: z.number().int().min(0).max(10_000),
  active: z.boolean(),
});

const saveRecordingPortsSchema = z.object({
  ports: z.array(recordingPortSchema).max(100),
});

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function sanitizeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function minuteToTime(value: number | null): string {
  if (value === null) return '--:--';
  const hour = Math.floor(value / 60) % 24;
  const minute = value % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function describeSourceKey(sourceKey: string): string {
  const [type, day, location, minute, ...titleParts] = sourceKey.split(':');
  if (type === 'studio' && day && location && minute && titleParts.length > 0) {
    return `${titleParts.join(':')} · ${location}`;
  }
  if (type === 'live') return `Canlı yayın #${day}`;
  return sourceKey;
}

function isPlanTimeConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2004'].includes(error.code);
}

function mapPlanItem(item: {
  id: number;
  sourceType: string;
  sourceKey: string;
  dayDate: Date;
  sourcePath: string | null;
  ports: { portName: string; role: string }[];
  plannedStartMinute: number | null;
  plannedEndMinute: number | null;
  status: string;
  jobId: number | null;
  note: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  // Normalized ports tablosundan ana/yedek çıkar.
  const recordingPort = item.ports.find((p) => p.role === 'primary')?.portName ?? null;
  const backupRecordingPort = item.ports.find((p) => p.role === 'backup')?.portName ?? null;
  return {
    id: item.id,
    sourceType: item.sourceType,
    sourceKey: item.sourceKey,
    dayDate: dateOnly(item.dayDate),
    sourcePath: item.sourcePath,
    recordingPort,
    backupRecordingPort,
    plannedStartMinute: item.plannedStartMinute,
    plannedEndMinute: item.plannedEndMinute,
    status: item.status,
    jobId: item.jobId,
    note: item.note,
    updatedBy: item.updatedBy,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

const PLAN_ITEM_INCLUDE = {
  ports: { select: { portName: true, role: true } },
} as const;

const PLAN_STATUS_LABELS: Record<string, string> = {
  WAITING: 'Bekliyor',
  RECEIVED: 'Alındı',
  INGEST_STARTED: 'İşlemde',
  COMPLETED: 'Tamamlandı',
  ISSUE: 'Sorun',
};

const reportQuerySchema = {
  type: 'object',
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
};

const reportZodSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).refine(
  (d) => {
    const diffMs = new Date(d.to).getTime() - new Date(d.from).getTime();
    return diffMs >= 0 && diffMs <= 366 * 24 * 60 * 60 * 1000;
  },
  { message: 'Tarih aralığı en fazla 366 gün olabilir', path: ['to'] },
);

async function getRecordingPorts(app: FastifyInstance) {
  return app.prisma.recordingPort.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export async function ingestRoutes(app: FastifyInstance) {
  const requireWorkerSecret = async (request: { headers: Record<string, string | string[] | undefined> }) => {
    const expected = process.env.INGEST_CALLBACK_SECRET;
    if (!expected) {
      throw Object.assign(new Error('Ingest callback secret is not configured'), { statusCode: 503 });
    }

    const rawHeader = request.headers['x-bcms-worker-secret'];
    const received = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!received || !safeEqual(received, expected)) {
      throw Object.assign(new Error('Invalid ingest callback secret'), { statusCode: 401 });
    }
  };

  // GET /api/v1/ingest
  app.get('/', {
    preHandler: app.requireGroup(...PERMISSIONS.ingest.read),
    schema: { tags: ['Ingest'] },
  }, async (request) => {
    const q = listQuerySchema.parse(request.query);
    const { page, pageSize } = q;
    const skip = (page - 1) * pageSize;

    const where = q.status ? { status: q.status as never } : {};
    const [data, total] = await Promise.all([
      app.prisma.ingestJob.findMany({ where, skip, take: pageSize, include: { qcReport: true }, orderBy: { createdAt: 'desc' } }),
      app.prisma.ingestJob.count({ where }),
    ]);
    return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  });

  // GET /api/v1/ingest/:id
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.ingest.read),
    schema: { tags: ['Ingest'] },
  }, async (request) => {
    const job = await app.prisma.ingestJob.findUnique({
      where: { id: z.coerce.number().int().positive().parse(request.params.id) },
      include: { qcReport: true },
    });
    if (!job) throw Object.assign(new Error('Ingest job not found'), { statusCode: 404 });
    return job;
  });

  // GET /api/v1/ingest/recording-ports — Kayıt portu kataloğu
  app.get('/recording-ports', {
    preHandler: app.requireGroup(...PERMISSIONS.ingest.read),
    schema: { tags: ['Ingest'], summary: 'Get recording port catalog' },
  }, async () => getRecordingPorts(app));

  app.put('/recording-ports', {
    preHandler: app.requireGroup(...PERMISSIONS.ingest.write),
    schema: { tags: ['Ingest'], summary: 'Replace recording port catalog' },
  }, async (request) => {
    const dto = saveRecordingPortsSchema.parse(request.body) satisfies SaveRecordingPortsDto;

    await app.prisma.$transaction(async (tx) => {
      await tx.recordingPort.deleteMany();
      if (dto.ports.length > 0) {
        await tx.recordingPort.createMany({ data: dto.ports });
      }
    });

    return getRecordingPorts(app);
  });

  // GET /api/v1/ingest/plan/report?from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get('/plan/report', {
    preHandler: app.requireGroup(...PERMISSIONS.ingest.read),
    schema: { tags: ['Ingest'], summary: 'Ingest plan raporu (tarih aralığı)', querystring: reportQuerySchema },
  }, async (request, reply) => {
    const { from, to } = reportZodSchema.parse(request.query);
    // HIGH-API-006 fix (2026-05-05): satır cap. 366 günlük sınır + 10K satır cap
    // → 1 yıllık ortak yoğun planda bile RAM güvenli. Cap aşılırsa
    // X-Truncated header ile UI uyarsın.
    const REPORT_ROW_CAP = 10000;
    const items = await app.prisma.ingestPlanItem.findMany({
      where: {
        dayDate: {
          gte: parseDate(dateSchema.parse(from)),
          lte: parseDate(dateSchema.parse(to)),
        },
      },
      include: PLAN_ITEM_INCLUDE,
      orderBy: [{ dayDate: 'asc' }, { plannedStartMinute: 'asc' }, { sourceKey: 'asc' }],
      take: REPORT_ROW_CAP,
    });
    if (items.length === REPORT_ROW_CAP) {
      reply.header('X-Truncated', `true; cap=${REPORT_ROW_CAP}`);
    }
    return items.map(mapPlanItem);
  });

  // GET /api/v1/ingest/plan/report/export?from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get('/plan/report/export', {
    preHandler: app.requireGroup(...PERMISSIONS.ingest.read),
    schema: { tags: ['Ingest'], summary: 'Ingest plan raporunu Excel olarak dışa aktar', querystring: reportQuerySchema },
  }, async (request, reply) => {
    const { from, to } = reportZodSchema.parse(request.query);
    // HIGH-API-006: export endpoint de 50K cap (Excel uygulamaları satır
    // yükünden bağımsız RAM güvenliği için).
    const items = await app.prisma.ingestPlanItem.findMany({
      where: {
        dayDate: {
          gte: parseDate(dateSchema.parse(from)),
          lte: parseDate(dateSchema.parse(to)),
        },
      },
      include: PLAN_ITEM_INCLUDE,
      orderBy: [{ dayDate: 'asc' }, { plannedStartMinute: 'asc' }, { sourceKey: 'asc' }],
      take: 50000,
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'BCMS';
    const sheet = workbook.addWorksheet('Ingest Raporu');

    sheet.columns = [
      { header: '#',           width: 6  },
      { header: 'Tarih',       width: 14 },
      { header: 'Kaynak Tipi', width: 14 },
      { header: 'İçerik',      width: 50 },
      { header: 'Ana Port',    width: 14 },
      { header: 'Yedek Port',  width: 14 },
      { header: 'Başlangıç',   width: 12 },
      { header: 'Bitiş',       width: 12 },
      { header: 'Süre (dk)',   width: 12 },
      { header: 'Durum',       width: 16 },
      { header: 'Not',         width: 40 },
      { header: 'Güncelleyen', width: 20 },
    ];
    sheet.getRow(1).font = { bold: true };

    let totalDuration = 0;
    items.forEach((item, i) => {
      const mapped = mapPlanItem(item);
      const dur = (mapped.plannedStartMinute !== null && mapped.plannedEndMinute !== null)
        ? mapped.plannedEndMinute - mapped.plannedStartMinute
        : null;
      if (dur !== null) totalDuration += dur;

      const [y, mo, d] = mapped.dayDate.split('-');
      sheet.addRow([
        i + 1,
        `${d}.${mo}.${y}`,
        mapped.sourceType,
        sanitizeCell(describeSourceKey(mapped.sourceKey)),
        mapped.recordingPort ?? '-',
        mapped.backupRecordingPort ?? '-',
        minuteToTime(mapped.plannedStartMinute),
        minuteToTime(mapped.plannedEndMinute),
        dur ?? '-',
        PLAN_STATUS_LABELS[mapped.status] ?? mapped.status,
        sanitizeCell(mapped.note ?? ''),
        mapped.updatedBy ?? '-',
      ]);
    });

    if (items.length > 0) {
      const totalRow = sheet.addRow(['', 'TOPLAM', `${items.length} kayıt`, '', '', '', '', '', totalDuration, '', '', '']);
      totalRow.font = { bold: true };
    }

    // HIGH-API-017 fix (2026-05-05): xlsx.write awaitlenmiyordu; eğer
    // serileştirme sırasında throw olursa client yarım dosya alır ve hatayı
    // göremezdiк. Buffer'a yaz, errors handler-level try/catch'te yakalar.
    const buffer = await workbook.xlsx.writeBuffer();
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="ingest-report_${from}_${to}.xlsx"`)
      .send(Buffer.from(buffer));
  });

  // GET /api/v1/ingest/plan?date=YYYY-MM-DD — Ingest departmanı plan satırı durumları
  app.get('/plan', {
    preHandler: app.requireGroup(...PERMISSIONS.ingest.read),
    schema: { tags: ['Ingest'], summary: 'Get ingest planning item states for one day' },
  }, async (request) => {
    const q = planQuerySchema.parse(request.query);
    const day = dateSchema.parse(q.date);
    const items = await app.prisma.ingestPlanItem.findMany({
      where: { dayDate: parseDate(day) },
      include: PLAN_ITEM_INCLUDE,
      orderBy: [{ sourceType: 'asc' }, { sourceKey: 'asc' }],
    });
    return items.map(mapPlanItem);
  });

  // PUT /api/v1/ingest/plan/:sourceKey — Kaynak dosya ve operasyon durumunu kaydet
  app.put<{ Params: { sourceKey: string } }>('/plan/:sourceKey', {
    preHandler: app.requireGroup(...PERMISSIONS.ingest.write),
    schema: { tags: ['Ingest'], summary: 'Upsert one ingest planning item state' },
  }, async (request) => {
    // MED-API-014 fix (2026-05-05): bozuk URI encoding'de URIError throw edilirdi → 500.
    let sourceKey: string;
    try { sourceKey = decodeURIComponent(request.params.sourceKey); }
    catch { throw Object.assign(new Error('Geçersiz sourceKey kodlaması'), { statusCode: 400 }); }
    const dto = savePlanItemSchema.parse(request.body) satisfies SaveIngestPlanItemDto;
    const user = (request.user as { preferred_username?: string })?.preferred_username ?? 'unknown';

    const sourcePath = dto.sourcePath?.trim() || null;
    const recordingPort = dto.recordingPort?.trim() || null;
    const backupRecordingPort = dto.backupRecordingPort?.trim() || null;
    const plannedStartMinute = dto.plannedStartMinute ?? null;
    const plannedEndMinute = dto.plannedEndMinute ?? null;

    // 1) Port katalog doğrulaması (her iki port da aktif olmalı)
    const portsToValidate = [recordingPort, backupRecordingPort].filter((p): p is string => !!p);
    if (portsToValidate.length > 0) {
      const activePorts = await app.prisma.recordingPort.findMany({
        where: { name: { in: portsToValidate }, active: true },
        select: { name: true },
      });
      const activeNames = new Set(activePorts.map((p) => p.name));
      for (const port of portsToValidate) {
        if (!activeNames.has(port)) {
          throw Object.assign(new Error(`Seçilen kayıt portu aktif değil: ${port}`), { statusCode: 400 });
        }
      }
    }

    // 2) Atomic transaction (HIGH-API-002 fix 2026-05-05): conflict check
    //    artık transaction içinde, TOCTOU race penceresi yok. DB GiST exclusion
    //    ikincil garanti — UI dostu mesaj için pre-check tutuldu ama RACE'i
    //    transaction kontrol ediyor.
    let item;
    try {
      item = await app.prisma.$transaction(async (tx) => {
        // ── Pre-check overlap (transaction içinde — TOCTOU yok) ──
        const checkConflict = async (portName: string) => {
          if (plannedStartMinute === null || plannedEndMinute === null) return;
          const conflict = await tx.ingestPlanItemPort.findFirst({
            where: {
              portName,
              dayDate: parseDate(dto.day),
              plannedStartMinute: { lt: plannedEndMinute },
              plannedEndMinute: { gt: plannedStartMinute },
              planItem: { sourceKey: { not: sourceKey } },
            },
            select: {
              portName: true,
              plannedStartMinute: true,
              plannedEndMinute: true,
              role: true,
              planItem: { select: { sourceKey: true } },
            },
          });
          if (conflict) {
            const conflictRange = `${minuteToTime(conflict.plannedStartMinute)} - ${minuteToTime(conflict.plannedEndMinute)}`;
            const roleLabel = conflict.role === 'backup' ? ' (yedek)' : '';
            throw Object.assign(
              new Error(`${portName} ${conflictRange} aralığında "${describeSourceKey(conflict.planItem.sourceKey)}"${roleLabel} için atanmış`),
              { statusCode: 409 },
            );
          }
        };
        if (recordingPort)        await checkConflict(recordingPort);
        if (backupRecordingPort)  await checkConflict(backupRecordingPort);

        const planItem = await tx.ingestPlanItem.upsert({
          where: { sourceKey },
          update: {
            sourceType: dto.sourceType,
            dayDate: parseDate(dto.day),
            sourcePath,
            plannedStartMinute,
            plannedEndMinute,
            status: dto.status ?? undefined,
            note: dto.note?.trim() || null,
            updatedBy: user,
          },
          create: {
            sourceKey,
            sourceType: dto.sourceType,
            dayDate: parseDate(dto.day),
            sourcePath,
            plannedStartMinute,
            plannedEndMinute,
            status: dto.status ?? 'WAITING',
            note: dto.note?.trim() || null,
            updatedBy: user,
          },
        });

        // Replace strategy: tüm port atamalarını silip yenisini yaz.
        // Port-time sync transaction içinde garanti — yarım state olamaz.
        await tx.ingestPlanItemPort.deleteMany({ where: { planItemId: planItem.id } });

        if (plannedStartMinute !== null && plannedEndMinute !== null) {
          if (recordingPort) {
            await tx.ingestPlanItemPort.create({
              data: {
                planItemId: planItem.id,
                portName: recordingPort,
                role: 'primary',
                dayDate: parseDate(dto.day),
                plannedStartMinute,
                plannedEndMinute,
              },
            });
          }
          if (backupRecordingPort) {
            await tx.ingestPlanItemPort.create({
              data: {
                planItemId: planItem.id,
                portName: backupRecordingPort,
                role: 'backup',
                dayDate: parseDate(dto.day),
                plannedStartMinute,
                plannedEndMinute,
              },
            });
          }
        }

        return tx.ingestPlanItem.findUniqueOrThrow({
          where: { id: planItem.id },
          include: PLAN_ITEM_INCLUDE,
        });
      });
    } catch (error) {
      if (!isPlanTimeConstraintError(error)) throw error;
      throw Object.assign(new Error('Seçilen kayıt portunda bu saat aralığı başka bir iş ile çakışıyor'), { statusCode: 409 });
    }

    return mapPlanItem(item);
  });

  // DELETE /api/v1/ingest/plan/:sourceKey — ingest-plan satırını sil
  app.delete<{ Params: { sourceKey: string } }>('/plan/:sourceKey', {
    preHandler: app.requireGroup(...PERMISSIONS.ingest.write),
    schema: { tags: ['Ingest'], summary: 'Delete an ingest plan item (ingest-plan source only)' },
  }, async (request, reply) => {
    // MED-API-014 fix (2026-05-05): bozuk URI encoding'de URIError throw edilirdi → 500.
    let sourceKey: string;
    try { sourceKey = decodeURIComponent(request.params.sourceKey); }
    catch { throw Object.assign(new Error('Geçersiz sourceKey kodlaması'), { statusCode: 400 }); }
    const item = await app.prisma.ingestPlanItem.findUnique({ where: { sourceKey }, select: { sourceType: true } });
    if (!item) {
      throw Object.assign(new Error('Kayıt bulunamadı'), { statusCode: 404 });
    }
    await app.prisma.ingestPlanItem.delete({ where: { sourceKey } });
    reply.code(204).send();
  });

  // POST /api/v1/ingest — Trigger new ingest job (watch folder or manual)
  app.post('/', {
    preHandler: app.requireGroup(...PERMISSIONS.ingest.write),
    schema: { tags: ['Ingest'], summary: 'Trigger a new ingest job' },
  }, async (request, reply) => {
    const dto = createIngestSchema.parse(request.body);
    const sourcePath = validateIngestSourcePath(dto.sourcePath);

    if (dto.targetId) {
      const schedule = await app.prisma.schedule.findFirst({
        where: { id: dto.targetId, usageScope: 'live-plan' },
        select: { id: true },
      });
      if (!schedule) {
        throw Object.assign(new Error('Ingest hedefi canlı yayın planı kaydı olmalıdır'), { statusCode: 400 });
      }
    }

    const job = await app.prisma.ingestJob.create({
      data: {
        sourcePath,
        targetId:   dto.targetId,
        metadata:   dto.metadata as Prisma.InputJsonValue,
      },
    });

    const planSourceKey = typeof dto.metadata?.ingestPlanSourceKey === 'string'
      ? dto.metadata.ingestPlanSourceKey
      : null;
    if (planSourceKey) {
      await app.prisma.ingestPlanItem.updateMany({
        where: { sourceKey: planSourceKey },
        data: {
          sourcePath,
          status: 'INGEST_STARTED',
          jobId: job.id,
        },
      });
    }

    await app.rabbitmq.publish(QUEUES.INGEST_NEW, {
      jobId:      job.id,
      sourcePath: job.sourcePath,
      targetId:   job.targetId,
    });

    reply.status(202).send(job);
  });

  // DELETE /api/v1/ingest/:id
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.ingest.delete),
    schema: { tags: ['Ingest'], summary: 'Delete ingest job' },
  }, async (request, reply) => {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const job = await app.prisma.ingestJob.findUnique({ where: { id } });
    if (!job) throw Object.assign(new Error('Ingest job not found'), { statusCode: 404 });
    if (job.status === 'PROCESSING' || job.status === 'PROXY_GEN' || job.status === 'QC') {
      throw Object.assign(new Error('Aktif iş silinemez'), { statusCode: 409 });
    }
    await app.prisma.ingestJob.delete({ where: { id } });
    reply.status(204).send();
  });

  // POST /api/v1/ingest/report-issue — Operatör tarafından yayın sorunu bildirimi
  app.post('/report-issue', {
    preHandler: app.requireGroup(...PERMISSIONS.ingest.reportIssue),
    schema: {
      tags: ['Ingest'],
      summary: 'Yayın sorunu bildir (incidents tablosuna INGEST_ISSUE olarak kaydedilir)',
      body: {
        type: 'object',
        required: ['sourceKey', 'description'],
        properties: {
          sourceKey:   { type: 'string' },
          title:       { type: 'string' },
          date:        { type: 'string' },
          startTime:   { type: 'string' },
          endTime:     { type: 'string' },
          port:        { type: 'string' },
          sourceLabel: { type: 'string' },
          description: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const body = z.object({
      sourceKey:   z.string().min(1),
      title:       z.string().optional(),
      date:        z.string().optional(),
      startTime:   z.string().optional(),
      endTime:     z.string().optional(),
      port:        z.string().optional(),
      sourceLabel: z.string().optional(),
      description: z.string().min(1).max(2000),
    }).parse(request.body);

    const user = (request.user as { preferred_username?: string })?.preferred_username ?? 'unknown';

    const incident = await app.prisma.incident.create({
      data: {
        eventType:   'INGEST_ISSUE',
        description: body.description,
        severity:    'ERROR',
        metadata: {
          sourceKey:   body.sourceKey,
          title:       body.title ?? '',
          date:        body.date ?? '',
          startTime:   body.startTime ?? '',
          endTime:     body.endTime ?? '',
          port:        body.port ?? '',
          sourceLabel: body.sourceLabel ?? '',
          reportedBy:  user,
        },
      },
    });

    reply.status(201).send(incident);
  });

  // POST /webhooks/ingest/callback — Called by worker when job completes
  app.post('/callback', {
    preHandler: requireWorkerSecret,
    schema: { tags: ['Ingest'], summary: 'Worker callback on job completion' },
    config: { rateLimit: false },
  }, async (request, reply) => {
    const dto = callbackSchema.parse(request.body);

    const job = await app.prisma.ingestJob.update({
      where: { id: dto.jobId },
      data: {
        status:     dto.status,
        proxyPath:  dto.proxyPath,
        checksum:   dto.checksum,
        errorMsg:   dto.errorMsg,
        finishedAt: ['COMPLETED', 'FAILED'].includes(dto.status) ? new Date() : undefined,
      },
    });

    if (dto.qcReport) {
      await app.prisma.qcReport.upsert({
        where:  { jobId: dto.jobId },
        create: { jobId: dto.jobId, ...dto.qcReport, errors: dto.qcReport.errors as Prisma.InputJsonValue, warnings: dto.qcReport.warnings as Prisma.InputJsonValue },
        update: { ...dto.qcReport, errors: dto.qcReport.errors as Prisma.InputJsonValue, warnings: dto.qcReport.warnings as Prisma.InputJsonValue },
      });
    }

    await app.prisma.ingestPlanItem.updateMany({
      where: { jobId: dto.jobId },
      data: { status: dto.status === 'FAILED' ? 'ISSUE' : dto.status === 'COMPLETED' ? 'COMPLETED' : 'INGEST_STARTED' },
    });

    await app.rabbitmq.publish(QUEUES.INGEST_COMPLETED, { jobId: dto.jobId, status: dto.status });

    reply.status(200).send(job);
  });
}
