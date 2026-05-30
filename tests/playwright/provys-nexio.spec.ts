/**
 * Provys NEXIO kolonu (2026-05-30): konum Başlık↔Süre arası + durum renkleri.
 *   var (found_match)            → #00a6d6 cyan (.mat-badge--found)
 *   eksik (missing_material)     → kırmızı (.mat-badge--danger)
 *   süre uymuyor (mismatch)      → sarı (.mat-badge--warning)
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIR = path.join(__dirname, 'screenshots', 'provys-nexio');
fs.mkdirSync(DIR, { recursive: true });

const EXPECTED_HEADERS = ['#', 'Başlangıç', 'Kategori', 'DC Kod', 'Başlık', 'NEXIO', 'Süre', 'Not'];

test('provys NEXIO: konum + var=cyan', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/provys-content-control', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.provys-list', { timeout: 25_000 });
  await page.waitForTimeout(1_500);

  // 1. Başlık sırası — NEXIO, Başlık ile Süre arasında.
  const headers = (await page.locator('table.provys-list thead th').allTextContents()).map((t) => t.trim());
  console.log(`[provys] headers = ${JSON.stringify(headers)}`);
  expect(headers).toEqual(EXPECTED_HEADERS);

  // 2. Badge tone'ları (hangi durumlar görünüyor).
  const tones = await page.locator('table.provys-list tbody .mat-badge').evaluateAll((els) =>
    [...new Set(els.map((e) => (e.className.match(/mat-badge--(\w+)/) || [])[1]).filter(Boolean))],
  );
  console.log(`[provys] görünen tone'lar = ${JSON.stringify(tones)}`);

  // 3. found (var) badge varsa border-color = rgb(0,166,214) (#00a6d6).
  const found = page.locator('table.provys-list tbody .mat-badge--found').first();
  if (await found.count()) {
    const border = await found.evaluate((el) => getComputedStyle(el).borderColor);
    console.log(`[provys] found badge border-color = ${border}`);
    expect(border.replace(/\s/g, '')).toBe('rgb(0,166,214)');
  } else {
    console.log('[provys] bu kanal/günde found badge yok (kontrol atlandı)');
  }

  await page.screenshot({ path: path.join(DIR, 'provys-nexio.png') });
});
