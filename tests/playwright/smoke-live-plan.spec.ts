import { test, expect, type Page } from '@playwright/test';

/**
 * 2026-05-15: Canlı Yayın Plan "Yeni Ekle / Manuel Giriş" UI kontrat smoke.
 *
 * Senaryolar:
 *   - Dialog açılır (Yeni Ekle butonu).
 *   - Manuel Giriş sekmesi aktif edilir.
 *   - Material datepicker render olur (Başlangıç Tarihi).
 *   - "Lig (opsiyonel)" dropdown'da Türkiye Basketbol Ligi listelenir.
 *   - TBL seçilince Ev Sahibi/Deplasman dropdown 16 takım gösterir.
 *   - Aynı takım hem home hem away seçilemez (mat-option [disabled]).
 *   - İki takım seçilince başlık otomatik "Ev - Deplasman".
 *
 * Önemli: DB'ye kayıt OLUŞTURMAZ — sadece UI kontratlarını doğrular.
 */

async function goToSchedulesViaNav(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 }).catch(() => undefined);
  await page.locator('aside a').filter({ hasText: /Canlı Yayın Plan/ }).first().click();
  await page.waitForURL(/\/schedules$/, { timeout: 10_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 });
}

async function openYeniEkleManuel(page: Page): Promise<void> {
  await goToSchedulesViaNav(page);
  await page.getByRole('button', { name: /^Yeni Ekle$/ }).first().click();
  await expect(page.getByRole('tab', { name: 'Manuel Giriş' })).toBeVisible({ timeout: 8_000 });
  await page.getByRole('tab', { name: 'Manuel Giriş' }).click();
  await expect(page.getByText(/Lig \(opsiyonel\)/)).toBeVisible();
}

test.describe('Canlı Yayın Plan — Yeni Ekle Manuel Giriş smoke', () => {
  test('dialog açılır + Manuel Giriş sekmesi aktif edilebilir', async ({ page }) => {
    await openYeniEkleManuel(page);
    // Lig dropdown ve takım select alanları render olmalı
    await expect(page.getByText(/Lig \(opsiyonel\)/)).toBeVisible();
  });

  test('Material datepicker — toggle ikonu açılır + takvim popup görünür', async ({ page }) => {
    await openYeniEkleManuel(page);
    const toggles = page.locator('mat-datepicker-toggle button');
    await expect(toggles.first()).toBeVisible();
    await toggles.first().click();
    await expect(page.locator('.mat-datepicker-content')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
  });

  test('Lig dropdown — Türkiye Basketbol Ligi seçilebilir', async ({ page }) => {
    await openYeniEkleManuel(page);
    const ligField = page.locator('mat-form-field:has(mat-label:has-text("Lig (opsiyonel)"))');
    await ligField.locator('mat-select').click();
    const tbl = page.getByRole('option', { name: /Türkiye Basketbol Ligi/ });
    await expect(tbl).toBeVisible({ timeout: 8_000 });
    await tbl.click();
  });

  test('TBL seçilince home/away dropdown 16 takım + aynı takım disabled + title auto-fill', async ({ page }) => {
    await openYeniEkleManuel(page);

    const ligField = page.locator('mat-form-field:has(mat-label:has-text("Lig (opsiyonel)"))');
    await ligField.locator('mat-select').click();
    await page.getByRole('option', { name: /Türkiye Basketbol Ligi/ }).click();

    // Ev Sahibi dropdown
    const homeField = page.locator('mat-form-field:has(mat-label:has-text("Ev Sahibi"))');
    await homeField.locator('mat-select').click();
    const options = page.getByRole('option');
    expect(await options.count(), 'home dropdown option count').toBeGreaterThanOrEqual(16);
    await page.getByRole('option', { name: /Fenerbahçe Beko/ }).first().click();

    // Deplasman: Fenerbahçe Beko disabled
    const awayField = page.locator('mat-form-field:has(mat-label:has-text("Deplasman"))');
    await awayField.locator('mat-select').click();
    const fbAway = page.getByRole('option', { name: /Fenerbahçe Beko/ }).first();
    await expect(fbAway).toHaveAttribute('aria-disabled', 'true');

    await page.getByRole('option', { name: /Anadolu Efes/ }).first().click();

    const titleInput = page.locator('input[matInput][maxlength="500"]').first();
    await expect(titleInput).toHaveValue(/Fenerbahçe Beko\s*-\s*Anadolu Efes/, { timeout: 3_000 });
  });
});
