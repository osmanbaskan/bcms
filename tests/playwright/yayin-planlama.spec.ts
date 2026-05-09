import { test, expect, type Page } from '@playwright/test';

/**
 * SCHED-B5a (Y5-1 ikinci revize 2026-05-08) — Canlı Yayın Plan + Yayın
 * Planlama Playwright e2e.
 *
 * Beklenen nav (kullanıcı algı süreklilik):
 *   • "Canlı Yayın Plan" → /schedules (eski görünümlü schedule-list UI;
 *     datasource ScheduleService wrapper üstünden /api/v1/live-plan)
 *   • "Live-Plan (yeni)" sekmesi YOK
 *   • "Yayın Planlama"   → /yayin-planlama (broadcast flow UI; ayrı kalır)
 *   • /schedules/reporting istisna (Y4-5; korunur, schedule canonical datasource)
 *   • Wildcard `**` → /schedules
 *
 * Test pattern: Angular SPA'da direct `page.goto(path)` Keycloak singleton'ı
 * re-init eder ve storageState ile race koşulu yaratır. Tüm flow'lar
 * /dashboard'tan başlar, sonra in-app link click veya router.navigate ile
 * hedef route'a gider (gerçek kullanıcı akışı paritesi).
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle').catch(() => {});
});

// SPA-içi navigate helper (Angular Router). Direct page.goto yerine kullanılır.
async function navigate(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    // Angular zone aware navigate; window.history.pushState yetmez (router
    // change detection tetiklenmez). PopStateEvent dispatch ile router'ı
    // tetikle; alternatif olarak fallback: location.assign.
    history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await page.waitForURL((u) => u.pathname === path || u.pathname.startsWith(path), { timeout: 10000 })
    .catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
}

test('nav: "Live-Plan (yeni)" YOK; "Canlı Yayın Plan" + "Yayın Planlama" görünür', async ({ page }) => {
  await expect(page.locator('a', { hasText: 'Live-Plan (yeni)' })).toHaveCount(0);
  await expect(page.locator('a', { hasText: 'Canlı Yayın Plan' })).toBeVisible();
  await expect(page.locator('a', { hasText: 'Yayın Planlama' })).toBeVisible();
});

test('nav click: Canlı Yayın Plan → /schedules (Y5-1 ikinci revize)', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const link = page.locator('a', { hasText: 'Canlı Yayın Plan' }).first();
  await link.click();
  await page.waitForURL(/\/schedules$/);
  expect(page.url()).toMatch(/\/schedules$/);
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});

test('Canlı Yayın Plan datasource: /schedules ekranı /api/v1/live-plan çağırır, legacy /schedules?usage=live-plan ÇAĞIRMAZ', async ({ page }) => {
  const legacyCalls: string[] = [];
  page.on('requestfinished', (req) => {
    const url = req.url();
    if (/\/api\/v1\/schedules(\?|$)/.test(url) && /usage=live-plan/.test(url)) legacyCalls.push(url);
  });

  const livePlanResponsePromise = page.waitForResponse(
    (res) => /\/api\/v1\/live-plan(\?|$)/.test(res.url()),
    { timeout: 15_000 },
  );

  await page.locator('a', { hasText: 'Canlı Yayın Plan' }).first().click();
  await page.waitForURL(/\/schedules$/);

  const livePlanRes = await livePlanResponsePromise;
  expect(livePlanRes.status(), `live-plan response status ${livePlanRes.status()}`).toBe(200);

  await page.waitForLoadState('networkidle').catch(() => {});
  expect(legacyCalls, `legacy /schedules?usage=live-plan çağrıldı: ${legacyCalls.join(', ')}`).toEqual([]);
});

test('Canlı Yayın Plan: mutation butonları görünmez (Yeni / Düzenle / Sil / Çoğalt / Teknik yok)', async ({ page }) => {
  await page.locator('a', { hasText: 'Canlı Yayın Plan' }).first().click();
  await page.waitForURL(/\/schedules$/);
  await page.waitForLoadState('networkidle').catch(() => {});

  await expect(page.locator('button', { hasText: /Yeni Ekle/ })).toHaveCount(0);
  await expect(page.locator('button[matTooltip="Düzenle"]')).toHaveCount(0);
  await expect(page.locator('button[matTooltip="Sil"]')).toHaveCount(0);
  await expect(page.locator('button[matTooltip="Materyali çoğalt"]')).toHaveCount(0);
  await expect(page.locator('button[matTooltip="Teknik Detayları Düzenle"]')).toHaveCount(0);
});

test('nav click: Yayın Planlama → /yayin-planlama ekranı', async ({ page }) => {
  const pageErrors: string[] = [];
  const networkErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 500) networkErrors.push(`${r.status()} ${r.url()}`);
  });

  const link = page.locator('a', { hasText: 'Yayın Planlama' }).first();
  await link.click();
  await page.waitForURL(/\/yayin-planlama/);
  expect(page.url()).toContain('/yayin-planlama');
  // Page header
  await expect(page.locator('.page-header h2', { hasText: 'Yayın Planlama' })).toBeVisible();
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  expect(networkErrors, networkErrors.join('\n')).toEqual([]);
});

test('reporting istisna: /schedules/reporting korunur (Y4-5; schedule canonical datasource)', async ({ page }) => {
  await navigate(page, '/schedules/reporting');
  expect(page.url()).toContain('/schedules/reporting');
});

test('Yayın Planlama form route + tüm alanlar render', async ({ page }) => {
  // SPA-içi navigate helper: direct goto reload yerine router.navigate
  // (Keycloak singleton stabil; auth race yok).
  await navigate(page, '/yayin-planlama/new');

  // Form header
  await expect(page.locator('.page-header h1', { hasText: 'Yeni Yayın Planlama' })).toBeVisible();
  // Tarih + Saat alanları
  await expect(page.locator('input[type="date"][name="scheduleDate"]')).toBeVisible();
  await expect(page.locator('input[type="time"][name="scheduleTime"]')).toBeVisible();
  // 3 channel slot
  await expect(page.locator('mat-form-field', { hasText: 'Kanal 1' })).toBeVisible();
  await expect(page.locator('mat-form-field', { hasText: 'Kanal 2' })).toBeVisible();
  await expect(page.locator('mat-form-field', { hasText: 'Kanal 3' })).toBeVisible();
  // 3 lookup option
  await expect(page.locator('mat-form-field', { hasText: 'Reklam Seçeneği' })).toBeVisible();
  await expect(page.locator('mat-form-field', { hasText: 'Logo Seçeneği' })).toBeVisible();
  await expect(page.locator('mat-form-field', { hasText: 'Format Seçeneği' })).toBeVisible();
  // Submit disabled (entry seçilmedi)
  const submit = page.locator('button[type="submit"]', { hasText: /Kaydet/ });
  await expect(submit).toBeDisabled();
});

test('picker dialog: "Seç" butonu → dialog açılır + filtre alanları render', async ({ page }) => {
  await navigate(page, '/yayin-planlama/new');

  const pickBtn = page.locator('button', { hasText: 'Seç' }).first();
  await expect(pickBtn).toBeVisible();
  await pickBtn.click();

  // Dialog açılır
  await expect(page.locator('mat-dialog-container h2', { hasText: 'Canlı Yayın Plan Seç' })).toBeVisible();
  await expect(page.locator('mat-form-field', { hasText: 'Ara' })).toBeVisible();
  await expect(page.locator('mat-form-field', { hasText: 'Durum' })).toBeVisible();
  // Boş veya tablo görünür
  const empty = page.locator('.state-empty');
  const table = page.locator('.picker-table');
  await expect(empty.or(table)).toBeVisible();
  // İptal kapatır (dialog scope; form actions'taki "İptal" ile karışmasın)
  await page.locator('mat-dialog-container button', { hasText: 'İptal' }).click();
  await expect(page.locator('mat-dialog-container')).toBeHidden();
});

test('screenshot: list (project default viewport)', async ({ page }, testInfo) => {
  await page.locator('a', { hasText: 'Yayın Planlama' }).first().click();
  await page.waitForURL(/\/yayin-planlama/);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.screenshot({
    path: `test-results/yayin-planlama-list-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test('screenshot: form (project default viewport)', async ({ page }, testInfo) => {
  await navigate(page, '/yayin-planlama/new');
  await page.screenshot({
    path: `test-results/yayin-planlama-form-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
