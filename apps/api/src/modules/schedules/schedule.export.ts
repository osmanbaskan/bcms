import * as xlsx from 'xlsx';
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

export async function exportSchedulesToBuffer(
  app: FastifyInstance,
  opts: ExportOptions,
): Promise<Buffer> {
  const { from, to, channelId, league, season, week, title, usage = 'broadcast' } = opts;

  const schedules = await app.prisma.schedule.findMany({
    where: buildExportWhere({ from, to, channelId, league, season, week, usage }),
    include: { channel: { select: { name: true } } },
    orderBy: { startTime: 'asc' },
  });

  const workbook  = xlsx.utils.book_new();

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
      s.title,
      s.channel?.name ?? '',
    ]),
  ];

  const sheet = xlsx.utils.aoa_to_sheet(sheetData);

  // ── Hücre birleştirme: başlık satırı A1:D1 ───────────────────────────────
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];

  // ── Sütun genişlikleri ────────────────────────────────────────────────────
  sheet['!cols'] = [
    { wch: 28 },  // TARİH
    { wch: 8  },  // SAAT
    { wch: 50 },  // MAÇ
    { wch: 22 },  // KANAL
  ];

  xlsx.utils.book_append_sheet(workbook, sheet, 'Plan');

  return Buffer.from(xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

function buildExportWhere(opts: Pick<ExportOptions, 'from' | 'to' | 'channelId' | 'league' | 'season' | 'week' | 'usage'>): Prisma.ScheduleWhereInput {
  const metadataFilters: Prisma.ScheduleWhereInput[] = [
    ...(opts.league ? [{ metadata: { path: ['league'], equals: opts.league } }] : []),
    ...(opts.season ? [{ metadata: { path: ['season'], equals: opts.season } }] : []),
    ...(opts.week ? [{ metadata: { path: ['weekNumber'], equals: opts.week } }] : []),
  ];

  return {
    status: { not: 'CANCELLED' },
    ...(opts.channelId && { channelId: opts.channelId }),
    ...(opts.from && { startTime: { gte: new Date(opts.from) } }),
    ...(opts.to && { startTime: { lte: new Date(opts.to) } }),
    ...(opts.usage === 'live-plan' && { usageScope: 'live-plan' }),
    ...(opts.usage === 'broadcast' && { usageScope: 'broadcast' }),
    ...(metadataFilters.length > 0 && { AND: metadataFilters }),
  };
}
