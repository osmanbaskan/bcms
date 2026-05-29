/**
 * Restore sekmesi — Süre + SSDB kolon overflow ölçümü (2026-05-28).
 *
 * Her satır için `td.col-dur` ve `td.col-ssdb` scrollWidth vs clientWidth
 * karşılaştırılır; clip varsa rapor edilir. Hard assertion: clip OLMAMALI.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCREEN_DIR = path.join(__dirname, 'screenshots', 'restore-column-widths');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

test('restore col-dur + col-ssdb taşma kontrolü', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 }).catch(() => undefined);
  await page.locator('aside a').filter({ hasText: /^restore_pageRestore$|^Restore$/ }).first().click();
  await page.waitForURL(/\/restore$/, { timeout: 15_000 });
  await page.waitForTimeout(2_500);

  // Eksik Materyaller tablosunda satır var mı?
  const tbody = page.locator('app-restore table.restore-list tbody');
  const rowCount = await tbody.locator('tr').count();
  console.log(`[col-widths] row count = ${rowCount}`);

  if (rowCount === 0) {
    test.skip(true, 'Tablo boş; ölçüm yapılmaz.');
  }

  // Per-cell scrollWidth/clientWidth ölçümü.
  const measurements = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('app-restore table.restore-list tbody tr'));
    return rows.map((tr, idx) => {
      const durCell = tr.querySelector<HTMLElement>('td.col-dur');
      const ssdbCell = tr.querySelector<HTMLElement>('td.col-ssdb');
      const durText = durCell?.textContent?.trim() ?? '';
      const ssdbBadge = ssdbCell?.querySelector<HTMLElement>('.ssdb-badge');
      const ssdbBadgeText = ssdbBadge?.textContent?.trim() ?? '';
      return {
        idx,
        durText,
        durClientW: durCell?.clientWidth ?? 0,
        durScrollW: durCell?.scrollWidth ?? 0,
        durOverflow: (durCell?.scrollWidth ?? 0) > (durCell?.clientWidth ?? 0) + 1,
        ssdbText: ssdbBadgeText,
        ssdbClientW: ssdbCell?.clientWidth ?? 0,
        ssdbBadgeScrollW: ssdbBadge?.scrollWidth ?? 0,
        ssdbBadgeClientW: ssdbBadge?.clientWidth ?? 0,
        ssdbBadgeOverflow: (ssdbBadge?.scrollWidth ?? 0) > (ssdbBadge?.clientWidth ?? 0) + 1,
      };
    });
  });

  console.log('[col-widths] measurements:');
  for (const m of measurements.slice(0, 8)) {
    console.log(`  row ${m.idx}: dur="${m.durText}" client=${m.durClientW} scroll=${m.durScrollW} overflow=${m.durOverflow}  ssdb="${m.ssdbText}" badge client=${m.ssdbBadgeClientW} scroll=${m.ssdbBadgeScrollW} overflow=${m.ssdbBadgeOverflow}`);
  }

  // Screenshot before assertion (test fail olsa bile dosya kalsın).
  await page.screenshot({ path: path.join(SCREEN_DIR, 'desktop-1440-before.png'), fullPage: true });

  const anyDurOverflow = measurements.some((m) => m.durOverflow);
  const anySsdbOverflow = measurements.some((m) => m.ssdbBadgeOverflow);

  expect(anyDurOverflow, 'col-dur overflow olmamalı — bir veya daha fazla satırda Süre kırpılıyor').toBe(false);
  expect(anySsdbOverflow, 'col-ssdb badge overflow olmamalı — bir veya daha fazla satırda SSDB metin kırpılıyor').toBe(false);
});
