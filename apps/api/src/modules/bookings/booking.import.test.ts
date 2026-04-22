/**
 * Excel import mantığı için hızlı birim testi (DB/RabbitMQ gerekmez)
 * Çalıştır: npx tsx src/modules/bookings/booking.import.test.ts
 */
import ExcelJS from 'exceljs';
import { readFirstWorksheetRows, rowsToObjects } from '../../lib/excel.js';

// ── Yardımcı: importFromBuffer mantığını izole et ────────────────────────────

interface Row {
  scheduleId: number;
  teamId?: number;
  matchId?: number;
  notes?: string;
}

interface ImportResult {
  valid: Row[];
  errors: { row: number; reason: string }[];
}

async function parseExcelBuffer(buffer: Buffer): Promise<ImportResult> {
  const rows = rowsToObjects(await readFirstWorksheetRows(buffer));
  const valid: Row[] = [];
  const errors: { row: number; reason: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const rowNum = i + 2;
    const scheduleId = Number(raw['scheduleId'] ?? raw['schedule_id']);
    if (!scheduleId || isNaN(scheduleId)) {
      errors.push({ row: rowNum, reason: 'scheduleId eksik veya geçersiz' });
      continue;
    }
    valid.push({
      scheduleId,
      teamId:  raw['teamId']  ? Number(raw['teamId'])  : undefined,
      matchId: raw['matchId'] ? Number(raw['matchId']) : undefined,
      notes:   raw['notes']   ? String(raw['notes'])   : undefined,
    });
  }

  return { valid, errors };
}

// ── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

async function makeBuffer(rows: Record<string, unknown>[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Bookings');
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));

  if (headers.length > 0) {
    sheet.addRow(headers);
    rows.forEach((row) => sheet.addRow(headers.map((header) => row[header] ?? '')));
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ── Testler ──────────────────────────────────────────────────────────────────

console.log('\n=== Excel Import Parser Testleri ===\n');

// Test 1: Geçerli satırlar
console.log('Test 1: Geçerli satırlar');
{
  const buf = await makeBuffer([
    { scheduleId: 1, teamId: 2, matchId: 100, notes: 'Final' },
    { scheduleId: 3 },
    { scheduleId: 5, notes: 'Yarı final' },
  ]);
  const result = await parseExcelBuffer(buf);
  assert(result.valid.length === 3, '3 geçerli satır parse edilmeli');
  assert(result.errors.length === 0, 'Hata olmamalı');
  assert(result.valid[0].scheduleId === 1, 'İlk satır scheduleId=1');
  assert(result.valid[0].teamId === 2, 'İlk satır teamId=2');
  assert(result.valid[1].teamId === undefined, 'İkinci satır teamId undefined');
}

// Test 2: Geçersiz satırlar
console.log('\nTest 2: Geçersiz scheduleId');
{
  const buf = await makeBuffer([
    { scheduleId: 1 },
    { scheduleId: '' },
    { notes: 'scheduleId yok' },
    { scheduleId: 'abc' },
  ]);
  const result = await parseExcelBuffer(buf);
  assert(result.valid.length === 1, '1 geçerli satır olmalı');
  assert(result.errors.length === 3, '3 hata olmalı');
  assert(result.errors[0].row === 3, 'Hata satır numarası doğru (row=3)');
}

// Test 3: schedule_id sütun adı alternatifi
console.log('\nTest 3: schedule_id alias');
{
  const buf = await makeBuffer([
    { schedule_id: 7, notes: 'alias test' },
  ]);
  const result = await parseExcelBuffer(buf);
  assert(result.valid.length === 1, 'schedule_id alias çalışmalı');
  assert(result.valid[0].scheduleId === 7, 'scheduleId=7 parse edilmeli');
}

// Test 4: Boş dosya
console.log('\nTest 4: Boş sheet');
{
  const buf = await makeBuffer([]);
  const result = await parseExcelBuffer(buf);
  assert(result.valid.length === 0, 'Boş dosyada geçerli satır olmamalı');
  assert(result.errors.length === 0, 'Boş dosyada hata olmamalı');
}

// ── Sonuç ─────────────────────────────────────────────────────────────────────

console.log(`\n=== Sonuç: ${passed} geçti, ${failed} başarısız ===\n`);
if (failed > 0) process.exit(1);
