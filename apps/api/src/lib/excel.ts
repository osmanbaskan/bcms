import ExcelJS from 'exceljs';

type ExcelCellObject =
  | { result?: unknown }
  | { text?: unknown }
  | { richText?: { text?: unknown }[] };

function isObject(value: unknown): value is ExcelCellObject {
  return typeof value === 'object' && value !== null;
}

export function normalizeExcelCell(value: unknown): unknown {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;

  if (isObject(value)) {
    if ('result' in value) return normalizeExcelCell(value.result);
    if ('text' in value) return normalizeExcelCell(value.text);
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => String(part.text ?? '')).join('');
    }
  }

  return String(value);
}

export async function readFirstWorksheetRows(buffer: Buffer): Promise<unknown[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const rows: unknown[][] = [];
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const values: unknown[] = [];

    for (let colNumber = 1; colNumber <= worksheet.columnCount; colNumber++) {
      values.push(normalizeExcelCell(row.getCell(colNumber).value));
    }

    rows.push(values);
  }

  return rows;
}

export function rowsToObjects(rows: unknown[][]): Record<string, unknown>[] {
  const headers = (rows[0] ?? []).map((cell) => String(cell ?? '').trim());
  return rows.slice(1).map((row) => {
    const record: Record<string, unknown> = {};

    headers.forEach((header, index) => {
      if (header) record[header] = row[index] ?? '';
    });

    return record;
  });
}
