/**
 * Restore — Manuel Materyal Arama (elle DC kod) doğrulama testi (2026-06-08).
 *
 * Manuel arama bölümü: text kutusu + "Ara" → sentetik satır + K1 enqueue
 * (channelSlug=MANUAL, scheduleDate=bugün, dcCode BÜYÜK harf). Buradan
 * mevcut K2/K3 zinciri yürür.
 *
 * Gerçek Avid'e dokunmamak için POST /api/v1/search/jobs intercept edilir;
 * gövdesi assert edilir, sahte 202 ile yanıtlanır (yan etki yok). Manuel
 * satır + 3 kademe butonu render'ı UI tarafından doğrulanır.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCREEN_DIR = path.join(__dirname, 'screenshots', 'restore-manual-search');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

/** Europe/Istanbul bugün — YYYY-MM-DD (component istanbulToday() ile aynı). */
function istanbulToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

test('restore manuel arama · satır + K1 enqueue (MANUAL/bugün/BÜYÜK)', async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto('/');
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 }).catch(() => undefined);
  await page.locator('aside a').filter({ hasText: /^restore_pageRestore$|^Restore$/ }).first().click();
  await page.waitForURL(/\/restore$/, { timeout: 15_000 });

  const appRestore = page.locator('app-restore');
  await appRestore.waitFor({ state: 'attached', timeout: 15_000 });

  // 1) Manuel Materyal Arama bölümü mevcut.
  const manual = appRestore.locator('section.manual-search');
  await expect(manual).toBeVisible({ timeout: 15_000 });
  await expect(manual.locator('h2.section-title')).toHaveText(/Manuel Materyal Arama/i);

  // 2) Input + Ara butonu mevcut ve (admin) etkin.
  const input = manual.locator('input.manual-input');
  const araBtn = manual.locator('button.manual-btn');
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(araBtn).toContainText(/Ara/i);

  // 3) Boş input → buton disabled (trim guard).
  await expect(araBtn).toBeDisabled();

  // 4) POST /search/jobs intercept — gövdeyi yakala, sahte 202 dön (Avid'e dokunma).
  let captured: { channelSlug?: string; scheduleDate?: string; dcCode?: string } | null = null;
  await page.route('**/api/v1/search/jobs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    captured = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: 999999, status: 'QUEUED', existing: false }),
    });
  });

  // 5) Küçük harf gir → BÜYÜK harfe çevrilmeli; Ara'ya tıkla.
  const typed = 'zztest000pw';
  const expectedDc = typed.toUpperCase();
  await input.fill(typed);
  await expect(araBtn).toBeEnabled();

  const postPromise = page.waitForRequest(
    (r) => r.url().includes('/api/v1/search/jobs') && r.method() === 'POST',
    { timeout: 15_000 },
  );
  await araBtn.click();
  await postPromise;

  // 6) Enqueue gövdesi: channelSlug=MANUAL, dcCode BÜYÜK, scheduleDate=bugün.
  expect(captured, 'POST gövdesi yakalanmalı').not.toBeNull();
  expect(captured!.channelSlug).toBe('MANUAL');
  expect(captured!.dcCode).toBe(expectedDc);
  expect(captured!.scheduleDate).toBe(istanbulToday());

  // 7) Manuel satır render: DC kod + 3 kademe butonu (Ara/Seç · Restore · Transfer).
  const list = manual.locator('table.manual-list');
  await expect(list).toBeVisible({ timeout: 10_000 });
  const row = list.locator('tbody tr', { hasText: expectedDc }).first();
  await expect(row).toBeVisible();
  await expect(row.locator('td.mono').first()).toHaveText(expectedDc);
  const jobBtns = row.locator('button.job-btn');
  await expect(jobBtns).toHaveCount(3);
  // Kaldır (×) butonu mevcut.
  await expect(row.locator('button.manual-remove')).toBeVisible();

  // 8) Satır görünürken screenshot (kaldırmadan önce).
  const file = path.join(SCREEN_DIR, 'manual-search.png');
  await page.screenshot({ path: file, fullPage: true });

  // 9) × ile satır kaldırılır.
  await row.locator('button.manual-remove').click();
  await expect(list.locator('tbody tr', { hasText: expectedDc })).toHaveCount(0);

  console.log(`[restore-manual-search] OK → ${file}`);
});
