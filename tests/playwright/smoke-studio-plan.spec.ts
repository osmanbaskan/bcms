import { test, expect, type Page } from '@playwright/test';

/**
 * 2026-05-15: Stüdyo Planı smoke — 15 dakikalık slot dönüşümü sonrası.
 */

async function goToStudioPlanViaNav(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 }).catch(() => undefined);
  await page.locator('aside a').filter({ hasText: /Stüdyo Planı/ }).first().click();
  await page.waitForURL(/\/studio-plan/, { timeout: 10_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 });
}

test.describe('Stüdyo Planı smoke', () => {
  test('sayfa açılır + 15 dakikalık slot mesajı + ekspor butonları', async ({ page }) => {
    await goToStudioPlanViaNav(page);
    await expect(page.getByRole('heading', { name: /Stüdyo Plan/i })).toBeVisible();
    await expect(page.getByText(/15 dakikalık slotlar?/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Export PDF/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Export Excel/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Tam Ekran/i })).toBeVisible();
  });

  test('zaman ekseni 06:00 ile başlar', async ({ page }) => {
    await goToStudioPlanViaNav(page);
    const sixAm = page.locator('text=/^06:00$/');
    await expect(sixAm.first()).toBeVisible({ timeout: 10_000 });
  });
});
