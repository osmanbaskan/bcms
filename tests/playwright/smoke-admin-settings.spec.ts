import { test, expect, type Page } from '@playwright/test';

/**
 * 2026-05-15: Ayarlar + Admin smoke.
 *
 * Settings ekranına sidebar üzerinden ulaşılır; admin route'lar (manual-leagues,
 * opta-competitions) sidebar VEYA settings kartı üzerinden açılır. Direct
 * URL goto Keycloak login cycle'a düşürdüğü için tıklama akışı kullanılır.
 */

async function goToSettingsViaNav(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 }).catch(() => undefined);
  await page.locator('aside a').filter({ hasText: /^settingsAyarlar$|^Ayarlar$/ }).first().click();
  await page.waitForURL(/\/settings/, { timeout: 10_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 });
}

test.describe('Settings + Admin smoke', () => {
  test('Settings sayfasında 2 admin kartı listelenir', async ({ page }) => {
    await goToSettingsViaNav(page);
    await expect(page.getByRole('heading', { name: 'Sistem Ayarları' })).toBeVisible();
    await expect(page.getByText('OPTA Lig / Turnuva Görünürlüğü')).toBeVisible();
    await expect(page.getByText('Manuel Lig Yönetimi')).toBeVisible();
    await expect(page.getByText('Manuel girişte seçilebilir ligleri yönetin')).toBeVisible();
  });

  test('Manuel Lig Yönetimi kartından admin sayfası açılır + TBL listelenir', async ({ page }) => {
    await goToSettingsViaNav(page);

    // Manuel Lig Yönetimi kartındaki "Aç" linki
    const card = page.locator('mat-card:has-text("Manuel Lig Yönetimi")');
    await card.getByRole('link', { name: /Aç/ }).click();
    await page.waitForURL(/\/admin\/manual-leagues/, { timeout: 10_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    await expect(page.getByRole('heading', { name: /Manuel Lig Yönetimi/ })).toBeVisible();

    // TBL satırı görünür — toggle state'i mat-slide-toggle Material 18+ DOM'da
    // role="switch" + aria-checked attribute. Sadece satır varlığı smoke için
    // yeterli; manualSelectable=true API smoke ile zaten doğrulandı.
    const tblRow = page.locator('tr:has-text("Türkiye Basketbol Ligi")').first();
    await expect(tblRow).toBeVisible({ timeout: 8_000 });
    // mat-slide-toggle ya button[role=switch] ya input[type=checkbox] içerir.
    const toggle = tblRow.locator('mat-slide-toggle [role="switch"], mat-slide-toggle input[type="checkbox"]').first();
    await expect(toggle).toBeVisible({ timeout: 3_000 });
    // aria-checked="true" garanti (Material 18+).
    const ariaChecked = await toggle.getAttribute('aria-checked');
    expect(ariaChecked, `TBL toggle aria-checked`).toBe('true');
  });

  test('OPTA Lig Görünürlüğü kartından admin sayfası açılır (regression)', async ({ page }) => {
    await goToSettingsViaNav(page);

    const card = page.locator('mat-card:has-text("OPTA Lig / Turnuva Görünürlüğü")');
    await card.getByRole('link', { name: /Aç/ }).click();
    await page.waitForURL(/\/admin\/opta-competitions/, { timeout: 10_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    await expect(page.getByRole('heading', { name: /OPTA Lig.*Görünür/i })).toBeVisible();
    const rows = page.getByRole('row');
    expect(await rows.count(), 'admin/opta-competitions satır sayısı').toBeGreaterThan(1);
  });
});
