import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASRUN_CHANNELS, PROVYS_CATEGORY_STYLES, type AsrunCategory } from '@bcms/shared';

/**
 * Asrun "kanal × gün" snapshot'ı için Excel + PDF export.
 *
 * Kolonlar (6 sütun) — Süre, Başlık'tan hemen sonra. (UI'da Süre tablonun
 * en sonunda; export'ta Kategori en sonda kaldığından Süre, Başlık ↔ Kategori
 * arasına alındı — 2026-05-29.)
 *   Sıra | Başlangıç (HH:MM:SS:FF) | DC Kod | Başlık | Süre (HH:MM:SS:FF) | Kategori
 *
 * Provys export'undan farklılıklar:
 *   - "Not" kolonu YOK (Asrun userNote feature'ı V1 kapsamında değil).
 *   - "Tür" kolonu YOK (Asrun rawKind = Primary/Comment ham SMPTE değeri;
 *     operasyon ekranı için anlamlı değil).
 *   - "Kaynak" kolonu YOK (Provys ile aynı tasarım kararı).
 *
 * Excel: ExcelJS — Provys export pattern paritesi, kategori bazlı pastel
 *        satır fill + kategori hücresi koyu metin.
 * PDF:   pdfkit + NotoSans TTF (apps/api/assets/fonts) — Türkçe karakter
 *        desteği. Sol kategori accent bandı; her sayfada header tekrar.
 *
 * Timezone Lock: üretim zamanı Europe/Istanbul.
 */

export interface AsrunExportRow {
  sequence: number;
  startTimecode: string | null;
  durationTimecode: string | null;
  dcCode: string | null;
  title: string;
  category: AsrunCategory;
}

export interface AsrunExportOptions {
  channelSlug: string;
  scheduleDate: string;   // YYYY-MM-DD
  rows: AsrunExportRow[];
}

interface ExportColor { fillArgb: string; fillHex: string; accentHex: string; textHex: string }
const EXPORT_PALETTE: Record<AsrunCategory, ExportColor> = {
  REKLAM:     { fillArgb: 'FFFFEDD5', fillHex: '#FFEDD5', accentHex: '#F59E0B', textHex: '#7C2D12' },
  KAMU_SPOTU: { fillArgb: 'FFE0E7FF', fillHex: '#E0E7FF', accentHex: '#6366F1', textHex: '#312E81' },
  CANLI:      { fillArgb: 'FFFEE2E2', fillHex: '#FEE2E2', accentHex: '#DC2626', textHex: '#7F1D1D' },
  PROGRAM:    { fillArgb: 'FFD1FAE5', fillHex: '#D1FAE5', accentHex: '#10B981', textHex: '#064E3B' },
  TANITIM:    { fillArgb: 'FFF3E8FF', fillHex: '#F3E8FF', accentHex: '#A855F7', textHex: '#581C87' },
  DIGER:      { fillArgb: 'FFF3F4F6', fillHex: '#F3F4F6', accentHex: '#9CA3AF', textHex: '#374151' },
};

function sanitizeCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function channelDisplayName(slug: string): string {
  return ASRUN_CHANNELS.find((c) => c.slug === slug)?.displayName ?? slug;
}

function categoryLabel(category: AsrunCategory): string {
  return PROVYS_CATEGORY_STYLES[category]?.label ?? category;
}

function generationStampIstanbul(): string {
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date());
}

// Font asset path resolution — Provys export ile aynı pattern.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.resolve(HERE, '../../../assets/fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'NotoSans-Regular.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'NotoSans-Bold.ttf');

// ── Excel ────────────────────────────────────────────────────────────────────

export async function exportAsrunToExcelBuffer(opts: AsrunExportOptions): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BCMS';
  wb.created = new Date();
  const sheet = wb.addWorksheet('Asrun');

  const channelName = channelDisplayName(opts.channelSlug);
  const titleText = `Asrun (As-Run Kaydı) — ${channelName} — ${opts.scheduleDate}`;

  sheet.addRow([titleText, '', '', '', '', '']);
  sheet.mergeCells('A1:F1');
  sheet.addRow([`Üretim: ${generationStampIstanbul()} (Europe/Istanbul)`, '', '', '', '', '']);
  sheet.mergeCells('A2:F2');
  sheet.addRow(['Sıra', 'Başlangıç', 'DC Kod', 'Başlık', 'Süre', 'Kategori']);

  if (opts.rows.length === 0) {
    sheet.addRow(['Seçili tarih için as-run kaydı yok', '', '', '', '', '']);
    sheet.mergeCells('A4:F4');
    sheet.getRow(4).font = { italic: true, color: { argb: 'FF6B7280' } };
    sheet.getRow(4).alignment = { horizontal: 'center' };
  } else {
    for (const r of opts.rows) {
      const row = sheet.addRow([
        r.sequence + 1,
        sanitizeCell(r.startTimecode ?? '—'),
        sanitizeCell(r.dcCode ?? '—'),
        sanitizeCell(r.title),
        sanitizeCell(r.durationTimecode ?? '—'),
        sanitizeCell(categoryLabel(r.category)),
      ]);
      const palette = EXPORT_PALETTE[r.category];
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: palette.fillArgb } };
      row.getCell(6).font = { bold: true, color: { argb: 'FF' + palette.textHex.slice(1) } };
    }
  }

  sheet.columns = [
    { width:  6 },   // Sıra
    { width: 14 },   // Başlangıç
    { width: 14 },   // DC Kod
    { width: 60 },   // Başlık
    { width: 14 },   // Süre
    { width: 14 },   // Kategori
  ];
  // Text format ('@'): timecode + DC kod sütunları — sayı/tarih coercion'ı önle.
  // Yeni sıra: B=Başlangıç, C=DC Kod, E=Süre (D=Başlık serbest metin, gerekmez).
  for (const col of ['B', 'C', 'E']) {
    sheet.getColumn(col).numFmt = '@';
  }

  sheet.getRow(1).font = { bold: true, size: 14 };
  sheet.getRow(1).alignment = { horizontal: 'center' };
  sheet.getRow(2).font = { italic: true, size: 10, color: { argb: 'FF666666' } };
  sheet.getRow(2).alignment = { horizontal: 'center' };
  const header = sheet.getRow(3);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF374151' } };
  header.alignment = { vertical: 'middle' };

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}

// ── PDF ──────────────────────────────────────────────────────────────────────

export async function exportAsrunToPdfBuffer(opts: AsrunExportOptions): Promise<Buffer> {
  const channelName = channelDisplayName(opts.channelSlug);
  const titleText = `Asrun (As-Run Kaydı) — ${channelName} — ${opts.scheduleDate}`;

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 36, bottom: 36, left: 28, right: 28 },
    info: { Title: titleText, Author: 'BCMS', Subject: `Asrun ${opts.channelSlug} ${opts.scheduleDate}` },
  });

  doc.registerFont('NotoSans', FONT_REGULAR);
  doc.registerFont('NotoSans-Bold', FONT_BOLD);

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const endPromise = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', (err) => reject(err));
  });

  // 6 kolon — toplam genişlik landscape A4 (~ 770pt - margin = 714pt) için
  // dengelendi.
  const cols = [
    { key: 'sequence', label: 'Sıra',       width:  32 },
    { key: 'start',    label: 'Başlangıç',  width:  78 },
    { key: 'dcCode',   label: 'DC Kod',     width:  84 },
    { key: 'title',    label: 'Başlık',     width: 384 },
    { key: 'duration', label: 'Süre',       width:  72 },
    { key: 'category', label: 'Kategori',   width:  74 },
  ] as const;
  const rowHeight = 14;
  const accentBarWidth = 3;
  const startX = doc.page.margins.left;
  const pageBottom = doc.page.height - doc.page.margins.bottom;

  const drawTableHeader = (): void => {
    let x = startX;
    const y = doc.y;
    doc.font('NotoSans-Bold').fontSize(8);
    for (const c of cols) {
      doc.rect(x, y, c.width, rowHeight).fillAndStroke('#e5e7eb', '#9ca3af');
      doc.fillColor('black')
        .text(c.label, x + 3, y + 3, { width: c.width - 6, height: rowHeight - 2, ellipsis: true, lineBreak: false });
      x += c.width;
    }
    doc.y = y + rowHeight;
  };

  const drawHeader = (): void => {
    doc.font('NotoSans-Bold').fontSize(14).fillColor('black')
      .text(titleText, { align: 'center' });
    doc.moveDown(0.2);
    doc.font('NotoSans').fontSize(9).fillColor('#666666')
      .text(`Üretim: ${generationStampIstanbul()} (Europe/Istanbul) — ${opts.rows.length} kayıt`, { align: 'center' });
    doc.fillColor('black');
    doc.moveDown(0.6);
    drawTableHeader();
  };

  const drawRow = (r: AsrunExportRow): void => {
    const palette = EXPORT_PALETTE[r.category];
    const y = doc.y;
    const values = [
      String(r.sequence + 1),
      r.startTimecode ?? '—',
      r.dcCode ?? '—',
      r.title,
      r.durationTimecode ?? '—',
      categoryLabel(r.category),
    ];
    let x = startX;
    doc.font('NotoSans').fontSize(7.5).fillColor('black');
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const isCategory = c.key === 'category';
      if (isCategory) {
        doc.rect(x, y, c.width, rowHeight).fillAndStroke(palette.fillHex, '#d1d5db');
      } else {
        doc.rect(x, y, c.width, rowHeight).fillAndStroke('#ffffff', '#d1d5db');
      }
      doc.fillColor(isCategory ? palette.textHex : 'black')
        .font(isCategory ? 'NotoSans-Bold' : 'NotoSans').fontSize(7.5)
        .text(values[i] ?? '', x + 3, y + 3, { width: c.width - 6, height: rowHeight - 2, ellipsis: true, lineBreak: false });
      x += c.width;
    }
    doc.rect(startX, y, accentBarWidth, rowHeight).fillAndStroke(palette.accentHex, palette.accentHex);
    doc.y = y + rowHeight;
  };

  drawHeader();

  if (opts.rows.length === 0) {
    doc.moveDown(2);
    doc.font('NotoSans').fontSize(11).fillColor('#666666')
      .text('Seçili tarih için as-run kaydı yok', { align: 'center' });
  } else {
    for (const r of opts.rows) {
      if (doc.y + rowHeight > pageBottom) {
        doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: 36, bottom: 36, left: 28, right: 28 } });
        drawHeader();
      }
      drawRow(r);
    }
  }

  doc.end();
  await endPromise;
  return Buffer.concat(chunks);
}

/** Dosya adı: `asrun_<channel>_<YYYY-MM-DD>.<ext>` */
export function asrunExportFilename(channelSlug: string, scheduleDate: string, ext: 'xlsx' | 'pdf'): string {
  return `asrun_${channelSlug}_${scheduleDate}.${ext}`;
}
