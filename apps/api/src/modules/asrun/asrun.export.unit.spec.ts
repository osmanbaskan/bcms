import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { PROVYS_CATEGORY_STYLES } from '@bcms/shared';
import {
  exportAsrunToExcelBuffer,
  exportAsrunToPdfBuffer,
  type AsrunExportRow,
} from './asrun.export.js';

/**
 * Kolon sırası kontrolü (2026-05-29): "Süre" Başlık'tan hemen sonraya alındı.
 * Beklenen sıra: Sıra | Başlangıç | DC Kod | Başlık | Süre | Kategori
 * (UI'da Süre en sonda; export'ta Kategori en sonda kaldığından Süre 5. sütun.)
 */

const SAMPLE_ROWS: AsrunExportRow[] = [
  { sequence: 0, startTimecode: '06:00:00:00', durationTimecode: '00:00:30:00', dcCode: 'DC123',  title: 'Sabah Kuşağı', category: 'PROGRAM' },
  { sequence: 1, startTimecode: '06:00:30:00', durationTimecode: '00:00:15:00', dcCode: 'REK001', title: 'Reklam Bloğu', category: 'REKLAM' },
];

const EXPECTED_HEADERS = ['Sıra', 'Başlangıç', 'DC Kod', 'Başlık', 'Süre', 'Kategori'];

describe('asrun.export › kolon sırası (Süre → Başlık sonrası)', () => {
  it('Excel: başlık satırı doğru + Süre 5. / Kategori 6. sütun', async () => {
    const buf = await exportAsrunToExcelBuffer({
      channelSlug: 'beinsports1',
      scheduleDate: '2026-05-28',
      rows: SAMPLE_ROWS,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheet = wb.getWorksheet('Asrun')!;

    // Başlık satırı = row 3 (row 1 başlık, row 2 üretim damgası).
    const headers = (sheet.getRow(3).values as unknown[]).slice(1).map((v) => String(v));
    expect(headers).toEqual(EXPECTED_HEADERS);

    // İlk veri satırı = row 4. Hücre konumları (1-indexed).
    const dataRow = sheet.getRow(4);
    const programLabel = PROVYS_CATEGORY_STYLES['PROGRAM']?.label ?? 'PROGRAM';
    expect(String(dataRow.getCell(2).value)).toBe('06:00:00:00');   // Başlangıç
    expect(String(dataRow.getCell(3).value)).toBe('DC123');         // DC Kod
    expect(String(dataRow.getCell(4).value)).toBe('Sabah Kuşağı');  // Başlık
    expect(String(dataRow.getCell(5).value)).toBe('00:00:30:00');   // Süre  ← yeni konum
    expect(String(dataRow.getCell(6).value)).toBe(programLabel);    // Kategori (label) en sonda
  });

  it('Excel: Süre + Başlangıç + DC Kod sütunları text-format (@) — timecode coercion yok', async () => {
    const buf = await exportAsrunToExcelBuffer({
      channelSlug: 'beinsports1', scheduleDate: '2026-05-28', rows: SAMPLE_ROWS,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheet = wb.getWorksheet('Asrun')!;
    // B=Başlangıç, C=DC Kod, E=Süre text; D=Başlık serbest (text gerekmez).
    expect(sheet.getColumn('B').numFmt).toBe('@');
    expect(sheet.getColumn('C').numFmt).toBe('@');
    expect(sheet.getColumn('E').numFmt).toBe('@');
  });

  it('PDF: geçerli buffer üretir (%PDF imzası)', async () => {
    const buf = await exportAsrunToPdfBuffer({
      channelSlug: 'beinsports1', scheduleDate: '2026-05-28', rows: SAMPLE_ROWS,
    });
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('boş satır seti: Excel + PDF hatasız üretilir', async () => {
    const opts = { channelSlug: 'beinhaber', scheduleDate: '2026-05-28', rows: [] as AsrunExportRow[] };
    const xlsx = await exportAsrunToExcelBuffer(opts);
    const pdf = await exportAsrunToPdfBuffer(opts);
    expect(xlsx.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
