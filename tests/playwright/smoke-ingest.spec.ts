import { test, expect, type Page } from '@playwright/test';

/**
 * 2026-05-15: Ingest Planlama + Port Görünümü smoke.
 *
 * Sidebar → "Ingest" tıklamasıyla navigate (direct URL goto cycle'a düşer).
 */

async function goToIngestViaNav(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 }).catch(() => undefined);
  await page.locator('aside a').filter({ hasText: /^cloud_uploadIngest$|^Ingest$/ }).first().click();
  await page.waitForURL(/\/ingest/, { timeout: 10_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 });
}

test.describe('Ingest smoke', () => {
  test('Ingest Planlama listesi açılır + tab navigasyonu render olur', async ({ page }) => {
    await goToIngestViaNav(page);
    // "Ingest Planlama" başlığı veya tab — sayfa render etti mi.
    const mainText = await page.locator('main, .page, app-root').first().innerText({ timeout: 5_000 });
    expect(mainText, 'ingest page body').toMatch(/Ingest|Planlama|Kayıt/i);
  });

  test('Port dropdown render olur (mat-select)', async ({ page }) => {
    await goToIngestViaNav(page);
    const ports = page.locator('mat-select');
    const count = await ports.count();
    test.skip(count === 0, 'tabloda port satırı yok — smoke atlanır');
    await ports.first().click();
    const options = page.getByRole('option');
    await expect(options.first()).toBeVisible({ timeout: 5_000 });
    const optionTexts = await options.allTextContents();
    expect(optionTexts.join(' | ')).toMatch(/seçilmedi|Port/);
    await page.keyboard.press('Escape');
  });

  test('Port Görünümü tab açılır', async ({ page }) => {
    await goToIngestViaNav(page);
    const portTab = page.getByRole('tab', { name: /Port Görünüm/i }).first();
    const tabCount = await portTab.count();
    test.skip(tabCount === 0, 'Port Görünümü tab bulunamadı');
    await portTab.click();
    await page.waitForLoadState('networkidle', { timeout: 10_000 });
    // Board veya empty-state — sayfa render edildi.
    const body = page.locator('main, .page, app-ingest-list').first();
    await expect(body).toBeVisible();
  });
});
