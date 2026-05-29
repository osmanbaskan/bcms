/**
 * Haftalık Shift redesign (2026-05-30): kompakt çip + tıkla-düzenle + izin kuralı.
 *
 * Kontroller:
 *  1. Hücreler kompakt çip (.chip) — eski 3-Material-kutu editör değil.
 *  2. Düzenlenebilir çipe tıklayınca inline editör (.cell-edit + .ce-type) açılır.
 *  3. KURAL: timeless tip (Haftalık İzin/OFF_DAY) → saat (.ce-times) YOK;
 *     timed tip (Gece/NIGHT) ve Mesai (boş) → saat VAR.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCREEN_DIR = path.join(__dirname, 'screenshots', 'weekly-shift-compact');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

test('weekly-shift: kompakt çip + izin saatsiz / vardiya saatli', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/weekly-shift', { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/weekly-shift$/, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForSelector('.shift-table, .empty', { timeout: 25_000 });
  await page.waitForTimeout(1_500);

  // 1. Kompakt çip var; eski cell-editor (mat-select'li dev kutu) yok.
  const chipCount = await page.locator('.chip').count();
  console.log(`[ws] chip sayısı = ${chipCount}`);
  await expect(page.locator('.cell-editor'), 'eski dev editör kalmamalı').toHaveCount(0);
  if (chipCount === 0) {
    test.skip(true, 'Hücre/çip yok (grupta personel yok); kural testi atlandı.');
  }

  await page.screenshot({ path: path.join(SCREEN_DIR, 'grid-chips.png') });

  // 2. Düzenlenebilir çip → editör aç.
  const editable = page.locator('.chip:not([disabled])').first();
  const editableCount = await editable.count();
  if (editableCount === 0) {
    test.skip(true, 'Düzenlenebilir çip yok (salt okunur); kural testi atlandı.');
  }
  await editable.click();
  await expect(page.locator('.cell-edit')).toHaveCount(1);
  const typeSel = page.locator('.cell-edit .ce-type');
  await expect(typeSel).toBeVisible();

  // 3a. Mesai (boş tip) → saat selectleri VAR.
  await typeSel.selectOption('');
  await expect(page.locator('.cell-edit .ce-times'), 'Mesai → saat olmalı').toHaveCount(1);

  // 3b. Haftalık İzin (OFF_DAY, timeless) → saat YOK.
  await typeSel.selectOption('OFF_DAY');
  await expect(page.locator('.cell-edit .ce-times'), 'Haftalık İzin → saat OLMAMALI').toHaveCount(0);

  // 3c. Gece (NIGHT, timed) → saat VAR.
  await typeSel.selectOption('NIGHT');
  await expect(page.locator('.cell-edit .ce-times'), 'Gece → saat OLMALI').toHaveCount(1);

  // 3d. "Elle gir…" → manuel HH:MM (type=time) input açılır (xx:xx zorunlu).
  const startSel = page.locator('.cell-edit .ce-times select').first();
  await startSel.selectOption('__manual__');
  await expect(
    page.locator('.cell-edit .ce-input[type="time"]'),
    'Elle gir… → type=time manuel input',
  ).toBeVisible();

  await page.screenshot({ path: path.join(SCREEN_DIR, 'editor-manual.png') });
});
