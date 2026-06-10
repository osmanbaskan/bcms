/**
 * Asrun-Merge sekmesi doğrulama (2026-06-10).
 * beinsports1 2026-06-09 (rebuild edilmiş gerçek veri): CANLI kilitli satır +
 * asrun dolgu + rozetler render edilmeli.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCREEN_DIR = path.join(__dirname, 'screenshots', 'asrun-merge');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

test('asrun-merge · CANLI kilitli + asrun dolgu render', async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto('/');
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 }).catch(() => undefined);
  await page.locator('aside a').filter({ hasText: /Asrun-Merge/ }).first().click();
  await page.waitForURL(/\/asrun-merge$/, { timeout: 15_000 });

  const root = page.locator('app-asrun-merge');
  await root.waitFor({ state: 'attached', timeout: 15_000 });
  await expect(root.locator('h1')).toHaveText(/Asrun-Merge/);

  // Veri olan güne git (rebuild edilmiş): 2026-06-09, kanal default beinsports1
  await root.locator('input[type="date"]').fill('2026-06-09');
  await root.locator('input[type="date"]').dispatchEvent('change');

  // Tablo + CANLI kilitli satır + Asrun chip
  await expect(root.locator('table tbody tr').first()).toBeVisible({ timeout: 15_000 });
  const liveChip = root.locator('.chip-live').first();
  await expect(liveChip).toBeVisible();
  await expect(liveChip).toContainText(/Canlı/);
  await expect(root.locator('.chip-asrun').first()).toBeVisible();

  // Canlı satır vurgusu (tr.live) mevcut
  await expect(root.locator('tr.live').first()).toBeVisible();

  // Kolon düzeni (2026-06-10): Bitiş + Süre EN SAĞDA; Notlar kolonu YOK
  const headers = await root.locator('table thead th').allTextContents();
  expect(headers[headers.length - 2]).toMatch(/Bitiş/);
  expect(headers[headers.length - 1]).toMatch(/Süre/);
  expect(headers.join('|')).not.toMatch(/Notlar/);

  const rowCount = await root.locator('table tbody tr').count();
  expect(rowCount).toBeGreaterThan(50); // 281 satır beklenir; >50 sağlam alt sınır

  const file = path.join(SCREEN_DIR, 'asrun-merge.png');
  await page.screenshot({ path: file, fullPage: false });
  console.log(`[asrun-merge] OK · ${rowCount} satır → ${file}`);
});
