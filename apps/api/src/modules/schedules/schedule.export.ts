import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';

// ── Türkçe ay ve gün adları ───────────────────────────────────────────────────
const TR_MONTHS = [
  'Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
  'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık',
];
const TR_DAYS = [
  'Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi',
];

function sanitizeCell(value: string): string {
  // Guard against CSV/Excel formula injection
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function formatTurkishDate(d: Date): string {
  return `${d.getDate()} ${TR_MONTHS[d.getMonth()]} ${d.getFullYear()} ${TR_DAYS[d.getDay()]}`;
}

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

export interface ExportOptions {
  from?:      string;
  to?:        string;
  channelId?: number;
  league?:    string;
  season?:    string;
  week?:      number;
  title?:     string;   // Üst başlık: "TÜRKİYE SİGORTA BASKETBOL SÜPER LİGİ - (26. HAFTA)"
  usage?:     'broadcast' | 'live-plan' | 'all';
}

export async function exportSchedulesToStream(
  app: FastifyInstance,
  opts: ExportOptions,
): Promise<Buffer> {
  const { from, to, channelId, league, season, week, title, usage = 'broadcast' } = opts;

  const schedules = await app.prisma.schedule.findMany({
    where: buildExportWhere({ from, to, channelId, league, season, week, usage }),
    include: { channel: { select: { name: true } } },
    orderBy: { startTime: 'asc' },
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BCMS';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Plan');

  // ── Satır verileri ────────────────────────────────────────────────────────
  // Satır 0: Başlık
  // Satır 1: Sütun başlıkları
  // Satır 2+: Veriler

  const headerTitle = title ?? 'YAYIM PLANI';

  const sheetData: (string | number)[][] = [
    // Satır 0 — başlık (4 hücre, birleştirilecek)
    [headerTitle, '', '', ''],
    // Satır 1 — sütun başlıkları
    ['TARİH', 'SAAT', 'MAÇ', 'KANAL'],
    // Satır 2+ — veri
    ...schedules.map((s) => [
      formatTurkishDate(new Date(s.startTime)),
      formatTime(new Date(s.startTime)),
      sanitizeCell(s.title),
      sanitizeCell(s.channel?.name ?? ''),
    ]),
  ];

  sheet.addRows(sheetData);

  // ── Hücre birleştirme: başlık satırı A1:D1 ───────────────────────────────
  sheet.mergeCells('A1:D1');

  // ── Sütun genişlikleri ────────────────────────────────────────────────────
  sheet.columns = [
    { width: 28 }, // TARİH
    { width: 8  }, // SAAT
    { width: 50 }, // MAÇ
    { width: 22 }, // KANAL
  ];

  sheet.getRow(1).font = { bold: true, size: 14 };
  sheet.getRow(2).font = { bold: true };

  // HIGH-API-017 fix (2026-05-05): buffer-based; write hatası caller'da 500'e döner.
  const arr = await workbook.xlsx.writeBuffer();
  return Buffer.from(arr);
}

function buildExportWhere(opts: Pick<ExportOptions, 'from' | 'to' | 'channelId' | 'league' | 'season' | 'week' | 'usage'>): Prisma.ScheduleWhereInput {
  return {
    status: { not: 'CANCELLED' },
    ...(opts.channelId && { channelId: opts.channelId }),
    ...(opts.from && { startTime: { gte: new Date(opts.from) } }),
    ...(opts.to && { startTime: { lte: new Date(opts.to) } }),
    ...(opts.usage === 'live-plan' && { usageScope: 'live-plan' }),
    ...(opts.usage === 'broadcast' && { usageScope: 'broadcast' }),
    ...(opts.league && { reportLeague: opts.league }),
    ...(opts.season && { reportSeason: opts.season }),
    ...(opts.week && { reportWeekNumber: opts.week }),
  };
}
