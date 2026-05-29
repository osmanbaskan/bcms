import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVYS_CHANNELS, PROVYS_CATEGORY_STYLES, type ProvysCategory } from '@bcms/shared';

/**
 * Provys "kanal × gün" snapshot'ı için Excel + PDF export.
 *
 * Kolonlar (Excel + PDF aynı sözleşme, 2026-05-23):
 *   Sıra | Başlangıç (HH:MM:SS:FF) | Süre (HH:MM:SS:FF) | DC Kod |
 *   Başlık | Kategori | Not
 *
 * Tarihçe:
 *   - "Kaynak" kolonu Excel'den 2026-05-23 kaldırıldı (composed-snapshot
 *     sonrası kaynak dosya operasyonel anlam taşımıyor); PDF'te hiç olmadı.
 *   - "Tür" kolonu (rawKind) 2026-05-23 hem Excel hem PDF'ten kaldırıldı,
 *     yerine kullanıcı serbest notu "Not" kolonu eklendi (BCMS UI tarafından
 *     PATCH ile yazılır; BXF parser'dan gelmez).
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
  /** Kullanıcı serbest notu (BCMS UI tarafından girilen). 2026-05-23:
   *  exportlarda "Tür" kolonu yerine "Not" olarak çıkar; rawKind exporttan
   *  kalktı, API DTO'sunda kalır. */
  userNote: string | null;
  // 2026-05-26: BXF ham title kaynak alanları (Excel'e eklendi; PDF dokunmadı)
  seriesName?: string | null;
  episodeNumber?: number | null;
  versionName?: string | null;
  titleSource?: string | null;
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
// 2026-05-27 (correction): REKLAM=yeşil, PROGRAM=sarı swap; UI ile birebir
// tutarlı. Excel ve PDF her ikisi de bu palet üzerinden render edilir.
const EXPORT_PALETTE: Record<ProvysCategory, ExportColor> = {
  REKLAM:     { fillArgb: 'FFD1FAE5', fillHex: '#D1FAE5', accentHex: '#10B981', textHex: '#064E3B' }, // yeşil
  KAMU_SPOTU: { fillArgb: 'FFE0E7FF', fillHex: '#E0E7FF', accentHex: '#6366F1', textHex: '#312E81' }, // mavi/mor
  CANLI:      { fillArgb: 'FFFEE2E2', fillHex: '#FEE2E2', accentHex: '#DC2626', textHex: '#7F1D1D' }, // kırmızı
  PROGRAM:    { fillArgb: 'FFFFEDD5', fillHex: '#FFEDD5', accentHex: '#F59E0B', textHex: '#7C2D12' }, // sarı
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

  // 2026-05-27 (correction 5): Kullanıcı isteği ile "Not" kolonu eklendi.
  // Kolon haritası (5 kolon, A4 portrait):
  //   A=Başlangıç B=DC Kod C=Başlık D=Süre E=Not
  //
  // PROGRAM satırlarında "Başlık" hücresi iki satırlı richText (seri varsa):
  //   üst satır: seriesName (küçük + italic + gri)
  //   alt satır: title       (normal boyut)
  // Seri yoksa / blank ise: tek satır, sadece title.
  // PROGRAM dışı kategorilerde seri hiç kullanılmaz; başlık tek satır.
  // Not hücresi (E) `userNote` ile dolar (UI'da kullanıcı doldurmadıysa boş).
  const EMPTY5 = ['', '', '', '', ''];

  // 1: başlık (tüm 5 kolon merge)
  sheet.addRow([titleText, ...EMPTY5.slice(1)]);
  sheet.mergeCells('A1:E1');
  // 2: meta (üretim zamanı)
  sheet.addRow([`Üretim: ${generationStampIstanbul()} (Europe/Istanbul)`, ...EMPTY5.slice(1)]);
  sheet.mergeCells('A2:E2');
  // 3: sütun başlıkları
  sheet.addRow(['Başlangıç', 'DC Kod', 'Başlık', 'Süre', 'Not']);

  if (opts.rows.length === 0) {
    sheet.addRow(['Seçili tarih için BXF akışı yok', ...EMPTY5.slice(1)]);
    sheet.mergeCells(`A4:E4`);
    sheet.getRow(4).font = { italic: true, color: { argb: 'FF6B7280' } };
    sheet.getRow(4).alignment = { horizontal: 'center' };
  } else {
    for (const r of opts.rows) {
      // Timecode'lar text olarak — Excel otomatik saat formatına çevirmesin.
      // Başlık (C) sonra richText/string olarak override edilir.
      const row = sheet.addRow([
        sanitizeCell(r.startTimecode ?? '—'),
        sanitizeCell(r.dcCode ?? '—'),
        '',  // placeholder — aşağıda hücre olarak set edilir
        sanitizeCell(r.durationTimecode ?? '—'),
        sanitizeCell(r.userNote ?? ''),
      ]);

      // Başlık hücresi: PROGRAM + non-blank seriesName ise iki satır richText.
      const hasSeries =
        r.category === 'PROGRAM' && r.seriesName != null && r.seriesName.trim() !== '';
      const titleCell = row.getCell(3);
      if (hasSeries) {
        titleCell.value = {
          richText: [
            {
              font: { size: 8, italic: true, color: { argb: 'FF6B7280' } },
              text: `${(r.seriesName as string).trim()}\n`,
            },
            {
              font: { size: 9, color: { argb: 'FF000000' } },
              text: sanitizeCell(r.title),
            },
          ],
        };
        titleCell.alignment = { wrapText: true, vertical: 'middle' };
        row.height = 38;
      } else {
        titleCell.value = sanitizeCell(r.title);
        titleCell.alignment = { wrapText: true, vertical: 'middle' };
      }

      // Not hücresi (E) — wrapText + middle vertical alignment.
      const noteCell = row.getCell(5);
      noteCell.alignment = { wrapText: true, vertical: 'middle' };

      // Kategori bazlı pastel fill — 5 hücrenin tamamı (A:E).
      const palette = EXPORT_PALETTE[r.category];
      const rowFill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: palette.fillArgb },
      } as const;
      for (let col = 1; col <= 5; col++) {
        row.getCell(col).fill = rowFill;
      }
    }
  }

  sheet.columns = [
    { width: 12 },   // A Başlangıç (HH:MM:SS:FF) — vertical middle
    { width: 12 },   // B DC Kod                   — vertical middle
    { width: 42 },   // C Başlık (PROGRAM: iki satır richText, wrapText)
    { width: 11 },   // D Süre                     — vertical middle
    { width: 20 },   // E Not  (kullanıcı yazısı, wrapText)
  ];
  // Timecode + DC sütunları text formatında — Excel saat/sayı autoconvert engellensin.
  // Aynı zamanda kullanıcı isteği: Başlangıç / DC Kod / Süre dikey ortalı.
  for (const col of ['A', 'B', 'D']) {
    sheet.getColumn(col).numFmt = '@';
    sheet.getColumn(col).alignment = { vertical: 'middle' };
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
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  // Data fontu küçültüldü (8-9 pt) — 5 kolonun A4 portrait'a sığması için.
  for (let r = 4; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row.font || !(row.font as { size?: number }).size) {
      row.font = { size: 9 };
    }
  }

  // A4 portrait, fit-to-width=1 (tek sayfa eninde sığar, sayfa adedi serbest).
  // paperSize 9 = A4 (Excel standart enum).
  sheet.pageSetup = {
    orientation: 'portrait',
    paperSize: 9,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
  };

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}

// ── PDF ──────────────────────────────────────────────────────────────────────

/**
 * 2026-05-27: PDF export, Excel export kontratına yaklaştırıldı.
 *  - A4 portrait (Excel ile aynı yön).
 *  - 4 kolon: Başlangıç | DC Kod | Başlık | Süre.
 *  - Kaldırıldı: Sıra, Kategori metni, Not, Kaynak, Versiyon ve diğer
 *    Excel'de olmayan ekstra alanlar.
 *  - Kategori bilgisi yalnızca satır arka plan tint'i olarak korunur
 *    (Excel paritesi); kategori metin hücresi yok.
 *  - PROGRAM + seriesName satırlarında başlık iki satır: üstte küçük
 *    italic gri seri adı, altta normal başlık (Excel richText ile aynı
 *    görsel imza).
 *
 * Excel `exportProvysToExcelBuffer` davranışı dokunulmadı; iki export
 * birbirinden bağımsız.
 */
export async function exportProvysToPdfBuffer(opts: ProvysExportOptions): Promise<Buffer> {
  const channelName = channelDisplayName(opts.channelSlug);
  const titleText = `Provys Akış — ${channelName} — ${opts.scheduleDate}`;

  const PAGE_OPTS = {
    size: 'A4' as const,
    layout: 'portrait' as const,
    margins: { top: 36, bottom: 36, left: 28, right: 28 },
  };

  const doc = new PDFDocument({
    ...PAGE_OPTS,
    info: {
      Title: titleText,
      Author: 'BCMS',
      Subject: `Provys ${opts.channelSlug} ${opts.scheduleDate}`,
    },
  });

  // NotoSans Regular + Bold — Türkçe karakter desteği için TTF register.
  doc.registerFont('NotoSans', FONT_REGULAR);
  doc.registerFont('NotoSans-Bold', FONT_BOLD);

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const endPromise = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', (err) => reject(err));
  });

  // Portrait A4 content width = 595 - (28 + 28) = 539 pt.
  // 5 kolon: 58 + 66 + 290 + 55 + 70 = 539 ✓ (Not eklendi).
  const cols = [
    { key: 'start',    label: 'Başlangıç', width:  58, align: 'center' as const },
    { key: 'dcCode',   label: 'DC Kod',    width:  66, align: 'center' as const },
    { key: 'title',    label: 'Başlık',    width: 290, align: 'left'   as const },
    { key: 'duration', label: 'Süre',      width:  55, align: 'center' as const },
    { key: 'userNote', label: 'Not',       width:  70, align: 'left'   as const },
  ] as const;
  const headerRowHeight = 16;
  const baseRowHeight = 16;
  // PROGRAM + non-blank seriesName satırlarında başlık iki satır (üst: seri,
  // alt: title) — Excel `row.height = 38` paritesi.
  const programWithSeriesRowHeight = 28;
  const startX = doc.page.margins.left;
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  const cellPad = 4;

  const rowHeightFor = (r: ProvysExportRow): number => {
    const hasSeries =
      r.category === 'PROGRAM' && typeof r.seriesName === 'string' && r.seriesName.trim() !== '';
    return hasSeries ? programWithSeriesRowHeight : baseRowHeight;
  };

  const drawDocumentHeader = (): void => {
    doc.font('NotoSans-Bold').fontSize(14).fillColor('black')
      .text(titleText, { align: 'center' });
    doc.moveDown(0.2);
    doc.font('NotoSans').fontSize(9).fillColor('#666666')
      .text(
        `Üretim: ${generationStampIstanbul()} (Europe/Istanbul) — ${opts.rows.length} kayıt`,
        { align: 'center' },
      );
    doc.fillColor('black');
    doc.moveDown(0.6);
    drawTableHeader();
  };

  const drawTableHeader = (): void => {
    let x = startX;
    const y = doc.y;
    doc.font('NotoSans-Bold').fontSize(8.5);
    for (const c of cols) {
      doc.rect(x, y, c.width, headerRowHeight).fillAndStroke('#374151', '#1f2937');
      doc.fillColor('#ffffff').text(c.label, x + cellPad, y + 3, {
        width: c.width - cellPad * 2,
        height: headerRowHeight - 3,
        align: 'center',
        ellipsis: true,
        lineBreak: false,
      });
      x += c.width;
    }
    doc.y = y + headerRowHeight;
  };

  const drawRow = (r: ProvysExportRow): void => {
    const palette = EXPORT_PALETTE[r.category];
    const rh = rowHeightFor(r);
    const y = doc.y;
    const hasSeries =
      r.category === 'PROGRAM' && typeof r.seriesName === 'string' && r.seriesName.trim() !== '';

    // 1) Tüm satır boyunca 4 hücreyi kategori pastel tint ile çiz (Excel paritesi).
    let x = startX;
    for (const c of cols) {
      doc.rect(x, y, c.width, rh).fillAndStroke(palette.fillHex, '#d1d5db');
      x += c.width;
    }

    // 2) Hücre metinleri.
    x = startX;
    for (const c of cols) {
      const cellWidth = c.width - cellPad * 2;
      if (c.key === 'title') {
        if (hasSeries) {
          doc.font('NotoSans').fontSize(6.5).fillColor('#6B7280').text(
            (r.seriesName ?? '').trim(),
            x + cellPad,
            y + 2,
            { width: cellWidth, height: 9, ellipsis: true, lineBreak: false },
          );
          doc.font('NotoSans-Bold').fontSize(8).fillColor(palette.textHex).text(
            r.title,
            x + cellPad,
            y + 13,
            { width: cellWidth, height: rh - 13 - cellPad, ellipsis: true, lineBreak: false },
          );
        } else {
          doc.font('NotoSans-Bold').fontSize(8).fillColor(palette.textHex).text(
            r.title,
            x + cellPad,
            y + (rh / 2 - 4),
            { width: cellWidth, height: rh, ellipsis: true, lineBreak: false },
          );
        }
      } else if (c.key === 'userNote') {
        const value = r.userNote ?? '';
        doc.font('NotoSans').fontSize(8).fillColor(palette.textHex).text(
          value,
          x + cellPad,
          y + (rh / 2 - 4),
          { width: cellWidth, height: rh, align: c.align, ellipsis: true, lineBreak: false },
        );
      } else {
        const value =
          c.key === 'start'    ? (r.startTimecode    ?? '—') :
          c.key === 'dcCode'   ? (r.dcCode           ?? '—') :
          c.key === 'duration' ? (r.durationTimecode ?? '—') :
          '';
        doc.font('NotoSans').fontSize(8).fillColor(palette.textHex).text(
          value,
          x + cellPad,
          y + (rh / 2 - 4),
          { width: cellWidth, height: rh, align: c.align, ellipsis: true, lineBreak: false },
        );
      }
      x += c.width;
    }

    doc.y = y + rh;
  };

  drawDocumentHeader();

  if (opts.rows.length === 0) {
    // 4 kolon düzeninde merge edilmiş "Seçili tarih için BXF akışı yok" stripi.
    const totalWidth = cols.reduce((acc, c) => acc + c.width, 0);
    const y = doc.y;
    doc.rect(startX, y, totalWidth, baseRowHeight).fillAndStroke('#f9fafb', '#d1d5db');
    doc.font('NotoSans').fontSize(10).fillColor('#6b7280').text(
      'Seçili tarih için BXF akışı yok',
      startX + cellPad,
      y + 4,
      { width: totalWidth - cellPad * 2, height: baseRowHeight - 4, align: 'center', lineBreak: false },
    );
    doc.y = y + baseRowHeight;
  } else {
    for (const r of opts.rows) {
      const rh = rowHeightFor(r);
      if (doc.y + rh > pageBottom) {
        doc.addPage(PAGE_OPTS);
        drawDocumentHeader();
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
