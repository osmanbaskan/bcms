import type { FastifyInstance } from 'fastify';
import { readFirstWorksheetRows } from '../../lib/excel.js';

// ── Türkçe ay adları ──────────────────────────────────────────────────────────
const TR_MONTHS: Record<string, number> = {
  'ocak': 0, 'şubat': 1, 'mart': 2, 'nisan': 3,
  'mayıs': 4, 'haziran': 5, 'temmuz': 6, 'ağustos': 7,
  'eylül': 8, 'ekim': 9, 'kasım': 10, 'aralık': 11,
};

export interface ScheduleImportResult {
  title:   string;          // Excel başlığı (lig + hafta bilgisi)
  created: number;
  skipped: number;
  errors:  { row: number; reason: string }[];
}

// ── "beIN SPORTS 5 - 4K" → "bein sports 5" gibi normalize et ────────────────
function normalizeChannelKey(raw: string): string {
  return raw
    .replace(/\s*[-–]\s*4K$/i, '')   // "- 4K" / "– 4K" sonekini kaldır
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ── Türkçe tarih + saat → Date ───────────────────────────────────────────────
// Kabul edilen format: "13 Nisan 2026 Pazartesi" + "19:00"
function parseTurkishDateTime(dateCell: unknown, timeCell: unknown): Date | null {
  try {
    let dateStr = String(dateCell ?? '').trim();
    let timeStr = String(timeCell ?? '').trim();

    if (timeCell instanceof Date) {
      timeStr = `${String(timeCell.getHours()).padStart(2, '0')}:${String(timeCell.getMinutes()).padStart(2, '0')}`;
    }

    // Excel bazen saati sayıya çevirir (0.7916... = 19:00), düzeltelim
    if (!isNaN(Number(timeCell)) && Number(timeCell) > 0 && Number(timeCell) < 1) {
      const totalMin = Math.round(Number(timeCell) * 1440);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    // Tarih parçala: "13 Nisan 2026 Pazartesi" veya "13 Nisan 2026"
    const dateParts = dateStr.split(/\s+/);
    const day   = parseInt(dateParts[0]);
    const month = TR_MONTHS[dateParts[1]?.toLowerCase() ?? ''];
    const year  = parseInt(dateParts[2]);

    if (isNaN(day) || month === undefined || isNaN(year)) return null;

    // Saat parçala: "19:00" veya "19.00"
    const timeParts = timeStr.replace('.', ':').split(':');
    const hour   = parseInt(timeParts[0] ?? '0');
    const minute = parseInt(timeParts[1] ?? '0');

    return new Date(year, month, day, hour, minute, 0);
  } catch {
    return null;
  }
}

// ── Ana import fonksiyonu ─────────────────────────────────────────────────────
export async function importSchedulesFromBuffer(
  buffer:  Buffer,
  app:     FastifyInstance,
  user:    string,
  options: { defaultDurationMin?: number } = {},
): Promise<ScheduleImportResult> {
  const durationMin = options.defaultDurationMin ?? 120; // varsayılan 2 saat

  const rows = await readFirstWorksheetRows(buffer);

  // ── Satır 0: Başlık (lig + hafta) ─────────────────────────────────────────
  const headerTitle = rows[0]
    ? (rows[0] as unknown[]).map(String).filter(Boolean).join(' ').trim()
    : '';

  // ── Sütun başlıklarını bul ────────────────────────────────────────────────
  let colHeaderRow = -1;
  let colMap: Record<string, number> = {};

  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const row = (rows[i] as unknown[]).map((c) => String(c).trim().toUpperCase());
    if (row.includes('TARİH') || row.includes('TARIH')) {
      colHeaderRow = i;
      row.forEach((h, idx) => {
        const norm = h.replace(/\s+/g, '').toUpperCase();
        if (norm === 'TARİH'  || norm === 'TARIH')  colMap['date']    = idx;
        if (norm === 'SAAT')                         colMap['time']    = idx;
        if (norm === 'MAÇ'    || norm === 'MAC')     colMap['match']   = idx;
        if (norm === 'KANAL')                        colMap['channel'] = idx;
      });
      break;
    }
  }

  if (colHeaderRow === -1) {
    return { title: headerTitle, created: 0, skipped: 0,
      errors: [{ row: 0, reason: 'TARİH/SAAT/MAÇ/KANAL başlık satırı bulunamadı' }] };
  }

  // ── Mevcut kanalları önbelleğe al ─────────────────────────────────────────
  const channels = await app.prisma.channel.findMany({ select: { id: true, name: true } });
  const channelMap = new Map<string, number>();
  for (const ch of channels) {
    channelMap.set(normalizeChannelKey(ch.name), ch.id);
  }

  // ── Veri satırlarını işle ─────────────────────────────────────────────────
  let created = 0, skipped = 0;
  const errors: { row: number; reason: string }[] = [];

  const dataRows = rows.slice(colHeaderRow + 1);

  for (let i = 0; i < dataRows.length; i++) {
    const row       = dataRows[i] as unknown[];
    const excelRow  = colHeaderRow + 2 + i; // insan-okunur satır no

    // Boş satırı atla
    const allEmpty = row.every((c) => String(c).trim() === '');
    if (allEmpty) { skipped++; continue; }

    const dateCell    = row[colMap['date']    ?? 0];
    const timeCell    = row[colMap['time']    ?? 1];
    const matchCell   = row[colMap['match']   ?? 2];
    const channelCell = row[colMap['channel'] ?? 3];

    const matchTitle = String(matchCell ?? '').trim();
    if (!matchTitle) { skipped++; continue; }

    // Tarih / saat parse
    const startTime = parseTurkishDateTime(dateCell, timeCell);
    if (!startTime) {
      errors.push({ row: excelRow, reason: `Tarih/saat okunamadı: "${dateCell}" "${timeCell}"` });
      continue;
    }
    const endTime = new Date(startTime.getTime() + durationMin * 60_000);

    // Kanal eşleştir
    const rawChannel  = String(channelCell ?? '').trim();
    const channelKey  = normalizeChannelKey(rawChannel);
    let channelId = channelMap.get(channelKey);

    // Tam eşleşme bulunamazsa kısmi eşleşme dene
    if (!channelId) {
      for (const [key, id] of channelMap.entries()) {
        if (channelKey.includes(key) || key.includes(channelKey)) {
          channelId = id;
          break;
        }
      }
    }

    if (!channelId) {
      errors.push({ row: excelRow, reason: `Kanal bulunamadı: "${rawChannel}"` });
      continue;
    }

    // Çakışma kontrolü
    const conflict = await app.prisma.schedule.findFirst({
      where: {
        channelId,
        status: { notIn: ['CANCELLED'] },
        AND: [{ startTime: { lt: endTime } }, { endTime: { gt: startTime } }],
      },
    });
    if (conflict) {
      errors.push({ row: excelRow, reason: `Çakışma: ${conflict.title} (${conflict.startTime.toISOString()})` });
      continue;
    }

    await app.prisma.schedule.create({
      data: {
        channelId,
        startTime,
        endTime,
        title:     matchTitle,
        status:    'CONFIRMED',
        createdBy: user,
        metadata:  { importTitle: headerTitle } as never,
      },
    });

    created++;
  }

  return { title: headerTitle, created, skipped, errors };
}
