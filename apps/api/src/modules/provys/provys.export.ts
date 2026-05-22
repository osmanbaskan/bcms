import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVYS_CHANNELS, PROVYS_CATEGORY_STYLES, type ProvysCategory } from '@bcms/shared';

/**
 * Provys "kanal × gün" snapshot'ı için Excel + PDF export.
 *
 * Kolonlar (UI tablo paritesi):
 *   Sıra | Başlangıç (HH:MM:SS:FF) | Süre (HH:MM:SS:FF) | DC Kod | Başlık |
 *   Kategori | Tür | Kaynak
 *
 * Excel: ExcelJS — live-plan.export pattern paritesi. Satırlar kategoriye
 *        göre pastel fill ile renklenir; orijinal Türkçe karakterler korunur
 *        (UTF-8 native).
 * PDF:   pdfkit + NotoSans-Regular/Bold TTF (apps/api/assets/fonts) — Türkçe
 *        karakterler doğru render edilir. Satırlarda kategori sol bandı
 *        + Kategori hücresi pastel tint. Her sayfada header tekrarlanır.
 *
 * Timezone Lock: Üretim zamanı Europe/Istanbul.
 */

export interface ProvysExportRow {
  sequence: number;
  startTimecode: string | null;
  durationTimecode: string | null;
  dcCode: string | null;
  title: string;
  category: ProvysCategory;
  rawKind: string | null;
  sourceFile: string;
}

export interface ProvysExportOptions {
  channelSlug: string;
  scheduleDate: string;   // YYYY-MM-DD
  rows: ProvysExportRow[];
}

/**
 * Export için açık zemin (rapor/yazdırma) pastel renk paleti.
 * Shared `PROVYS_CATEGORY_STYLES` UI dark theme için tasarlandı; export'ta
 * white background üstünde okunabilir tint + accent gerekiyor.
 */
interface ExportColor { fillArgb: string; fillHex: string; accentHex: string; textHex: string }
const EXPORT_PALETTE: Record<ProvysCategory, ExportColor> = {
  REKLAM:     { fillArgb: 'FFFFEDD5', fillHex: '#FFEDD5', accentHex: '#F59E0B', textHex: '#7C2D12' }, // turuncu
  KAMU_SPOTU: { fillArgb: 'FFE0E7FF', fillHex: '#E0E7FF', accentHex: '#6366F1', textHex: '#312E81' }, // mavi/mor
  CANLI:      { fillArgb: 'FFFEE2E2', fillHex: '#FEE2E2', accentHex: '#DC2626', textHex: '#7F1D1D' }, // kırmızı
  PROGRAM:    { fillArgb: 'FFD1FAE5', fillHex: '#D1FAE5', accentHex: '#10B981', textHex: '#064E3B' }, // yeşil
  TANITIM:    { fillArgb: 'FFF3E8FF', fillHex: '#F3E8FF', accentHex: '#A855F7', textHex: '#581C87' }, // mor
  DIGER:      { fillArgb: 'FFF3F4F6', fillHex: '#F3F4F6', accentHex: '#9CA3AF', textHex: '#374151' }, // gri
};

function sanitizeCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // CSV/Excel formula injection guard (live-plan/schedule.export pattern).
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function channelDisplayName(slug: string): string {
  return PROVYS_CHANNELS.find((c) => c.slug === slug)?.displayName ?? slug;
}

function categoryLabel(category: ProvysCategory): string {
  return PROVYS_CATEGORY_STYLES[category]?.label ?? category;
}

function basename(filePath: string): string {
  return path.basename(filePath);
}

function generationStampIstanbul(): string {
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date());
}

// ── Font asset path resolution ───────────────────────────────────────────────
// Compiled JS: <api root>/dist/modules/provys/provys.export.js
// Font asset:  <api root>/assets/fonts/NotoSans-*.ttf
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.resolve(HERE, '../../../assets/fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'NotoSans-Regular.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'NotoSans-Bold.ttf');

// ── Excel ────────────────────────────────────────────────────────────────────

export async function exportProvysToExcelBuffer(opts: ProvysExportOptions): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BCMS';
  wb.created = new Date();
  const sheet = wb.addWorksheet('Provys Akış');

  const channelName = channelDisplayName(opts.channelSlug);
  const titleText = `Provys Akış — ${channelName} — ${opts.scheduleDate}`;

  // 1: başlık (8 kolon merge)
  sheet.addRow([titleText, '', '', '', '', '', '', '']);
  sheet.mergeCells('A1:H1');
  // 2: meta (üretim zamanı)
  sheet.addRow([`Üretim: ${generationStampIstanbul()} (Europe/Istanbul)`, '', '', '', '', '', '', '']);
  sheet.mergeCells('A2:H2');
  // 3: sütun başlıkları
  sheet.addRow(['Sıra', 'Başlangıç', 'Süre', 'DC Kod', 'Başlık', 'Kategori', 'Tür', 'Kaynak']);

  if (opts.rows.length === 0) {
    sheet.addRow(['Seçili tarih için BXF akışı yok', '', '', '', '', '', '', '']);
    sheet.mergeCells(`A4:H4`);
    sheet.getRow(4).font = { italic: true, color: { argb: 'FF6B7280' } };
    sheet.getRow(4).alignment = { horizontal: 'center' };
  } else {
    for (const r of opts.rows) {
      // Timecode'lar text olarak — Excel otomatik saat formatına çevirmesin.
      const row = sheet.addRow([
        r.sequence + 1,
        sanitizeCell(r.startTimecode ?? '—'),
        sanitizeCell(r.durationTimecode ?? '—'),
        sanitizeCell(r.dcCode ?? '—'),
        sanitizeCell(r.title),
        sanitizeCell(categoryLabel(r.category)),
        sanitizeCell(r.rawKind ?? '—'),
        sanitizeCell(basename(r.sourceFile)),
      ]);
      // Kategori bazlı pastel fill — tüm satır.
      const palette = EXPORT_PALETTE[r.category];
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: palette.fillArgb },
      };
      // Kategori hücresine kalın text + kategori metin rengi.
      row.getCell(6).font = { bold: true, color: { argb: 'FF' + palette.textHex.slice(1) } };
    }
  }

  sheet.columns = [
    { width:  6 },   // Sıra
    { width: 14 },   // Başlangıç (HH:MM:SS:FF)
    { width: 14 },   // Süre
    { width: 14 },   // DC Kod
    { width: 60 },   // Başlık
    { width: 14 },   // Kategori
    { width: 18 },   // Tür
    { width: 50 },   // Kaynak
  ];
  // Timecode + DC sütunları text formatında — Excel saat/sayı autoconvert engellensin.
  for (const col of ['B', 'C', 'D']) {
    sheet.getColumn(col).numFmt = '@';
  }

  // Başlık + meta stilleri.
  sheet.getRow(1).font = { bold: true, size: 14 };
  sheet.getRow(1).alignment = { horizontal: 'center' };
  sheet.getRow(2).font = { italic: true, size: 10, color: { argb: 'FF666666' } };
  sheet.getRow(2).alignment = { horizontal: 'center' };
  // Header satırı — bold + koyu gri zemin + beyaz text.
  const header = sheet.getRow(3);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF374151' } };
  header.alignment = { vertical: 'middle' };

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}

// ── PDF ──────────────────────────────────────────────────────────────────────

export async function exportProvysToPdfBuffer(opts: ProvysExportOptions): Promise<Buffer> {
  const channelName = channelDisplayName(opts.channelSlug);
  const titleText = `Provys Akış — ${channelName} — ${opts.scheduleDate}`;

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 36, bottom: 36, left: 28, right: 28 },
    info: {
      Title: titleText,
      Author: 'BCMS',
      Subject: `Provys ${opts.channelSlug} ${opts.scheduleDate}`,
    },
  });

  // NotoSans Regular + Bold — Türkçe karakter desteği için TTF register.
  // pdfkit `registerFont(name, source)` ile alias atar; sonrasında
  // doc.font('NotoSans') gibi kullanılır.
  doc.registerFont('NotoSans', FONT_REGULAR);
  doc.registerFont('NotoSans-Bold', FONT_BOLD);

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const endPromise = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', (err) => reject(err));
  });

  // Tablo geometrisi.
  const cols = [
    { key: 'sequence', label: 'Sıra',       width:  28 },
    { key: 'start',    label: 'Başlangıç',  width:  68 },
    { key: 'duration', label: 'Süre',       width:  62 },
    { key: 'dcCode',   label: 'DC Kod',     width:  72 },
    { key: 'title',    label: 'Başlık',     width: 314 },
    { key: 'category', label: 'Kategori',   width:  60 },
    { key: 'rawKind',  label: 'Tür',        width:  70 },
  ] as const;
  const rowHeight = 14;
  const accentBarWidth = 3;       // Sol kategori bandı genişliği
  const startX = doc.page.margins.left;
  const pageBottom = doc.page.height - doc.page.margins.bottom;

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

  const drawRow = (r: ProvysExportRow): void => {
    const palette = EXPORT_PALETTE[r.category];
    const y = doc.y;
    const values = [
      String(r.sequence + 1),
      r.startTimecode ?? '—',
      r.durationTimecode ?? '—',
      r.dcCode ?? '—',
      r.title,
      categoryLabel(r.category),
      r.rawKind ?? '—',
    ];
    let x = startX;
    doc.font('NotoSans').fontSize(7.5).fillColor('black');
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const isCategory = c.key === 'category';
      // Kategori hücresi pastel tint; diğer hücreler beyaz.
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
    // Sol kategori bandı — ilk hücrenin solunda kategori accent rengi.
    doc.rect(startX, y, accentBarWidth, rowHeight).fillAndStroke(palette.accentHex, palette.accentHex);
    doc.y = y + rowHeight;
  };

  drawHeader();

  if (opts.rows.length === 0) {
    doc.moveDown(2);
    doc.font('NotoSans').fontSize(11).fillColor('#666666')
      .text('Seçili tarih için BXF akışı yok', { align: 'center' });
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

/** Dosya adı: `provys_<channel>_<YYYY-MM-DD>.<ext>` */
export function exportFilename(channelSlug: string, scheduleDate: string, ext: 'xlsx' | 'pdf'): string {
  return `provys_${channelSlug}_${scheduleDate}.${ext}`;
}
