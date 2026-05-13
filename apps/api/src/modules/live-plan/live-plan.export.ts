import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';

import { formatIstanbulDateTr, formatIstanbulTime } from '../../core/tz.js';

/**
 * 2026-05-13: Yayın Planlama seçimli Excel export.
 *
 * `POST /api/v1/live-plan/export` body: { ids: number[], title?: string }.
 * Selected `live_plan_entries.id IN ids` + `deleted_at IS NULL` filter;
 * eventStartTime ASC sort; channel id → name resolve `channels` lookup
 * üzerinden (Excel'de ad yazılır, id değil); match.league.name join.
 *
 * Kolonlar (UI tablosu paritesi):
 *   Tarih | Saat | Karşılaşma | Lig | Hafta | Kanallar
 *
 * Güvenlik: `sanitizeCell` CSV/Excel formula injection guard
 * (schedule.export.ts paterni).
 */

/** Guard against CSV/Excel formula injection: =, +, -, @, tab, CR ile başlayan
 *  hücreyi tek tırnakla escape eder. Schedule.export paritesi. */
function sanitizeCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export interface LivePlanExportOptions {
  ids:    readonly number[];
  title?: string;
}

export async function exportLivePlanToBuffer(
  app:  FastifyInstance,
  opts: LivePlanExportOptions,
): Promise<Buffer> {
  const { ids, title } = opts;

  // 1. Entries — id IN + deletedAt null + match.league join + eventStartTime ASC.
  const entries = await app.prisma.livePlanEntry.findMany({
    where: {
      id:        { in: [...ids] },
      deletedAt: null,
    },
    include: {
      match: { include: { league: { select: { name: true } } } },
    },
    orderBy: { eventStartTime: 'asc' },
  });

  // 2. Channel name resolve — distinct id set, tek query.
  const channelIds = new Set<number>();
  for (const e of entries) {
    if (e.channel1Id != null) channelIds.add(e.channel1Id);
    if (e.channel2Id != null) channelIds.add(e.channel2Id);
    if (e.channel3Id != null) channelIds.add(e.channel3Id);
  }
  const channelRows = channelIds.size > 0
    ? await app.prisma.channel.findMany({
        where:  { id: { in: Array.from(channelIds) } },
        select: { id: true, name: true },
      })
    : [];
  const channelById = new Map<number, string>(channelRows.map((c) => [c.id, c.name]));

  // 3. Workbook + worksheet.
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BCMS';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Yayın Planlama');

  const headerTitle = (title?.trim() || 'Yayın Planlama');

  // Satır 1 — başlık (6 kolon birleşik)
  // Satır 2 — sütun başlıkları
  // Satır 3+ — veri
  sheet.addRow([headerTitle, '', '', '', '', '']);
  sheet.mergeCells('A1:F1');
  sheet.addRow(['Tarih', 'Saat', 'Karşılaşma', 'Lig', 'Hafta', 'Kanallar']);

  for (const e of entries) {
    const date  = formatIstanbulDateTr(e.eventStartTime);
    const time  = formatIstanbulTime(e.eventStartTime);
    const teams = (e.team1Name && e.team2Name)
      ? `${e.team1Name} vs ${e.team2Name}`
      : (e.title ?? '');
    const league = e.match?.league?.name ?? '';
    const week   = e.match?.weekNumber != null ? String(e.match.weekNumber) : '';
    const channelNames = [e.channel1Id, e.channel2Id, e.channel3Id]
      .map((id) => (id != null ? channelById.get(id) ?? null : null))
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    const channels = channelNames.join(', ');

    sheet.addRow([
      sanitizeCell(date),
      sanitizeCell(time),
      sanitizeCell(teams),
      sanitizeCell(league),
      sanitizeCell(week),
      sanitizeCell(channels),
    ]);
  }

  // Kolon genişlikleri (UI kolon sırasıyla).
  sheet.columns = [
    { width: 14 }, // Tarih
    { width: 8  }, // Saat
    { width: 40 }, // Karşılaşma
    { width: 25 }, // Lig
    { width: 8  }, // Hafta
    { width: 35 }, // Kanallar
  ];

  // Stil.
  sheet.getRow(1).font = { bold: true, size: 14 };
  sheet.getRow(1).alignment = { horizontal: 'center' };
  sheet.getRow(2).font = { bold: true };

  // schedule.export pattern: ArrayBuffer → Node Buffer.
  const arr = await workbook.xlsx.writeBuffer();
  return Buffer.from(arr);
}
