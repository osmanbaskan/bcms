import { test, expect } from '@playwright/test';

/**
 * Smoke — kritik akışlar: app boot, sidebar nav, theme toggle, console error yok.
 */

test('app boot — dashboard yüklendi, runtime JS hatası yok', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle').catch(() => {});

  // Sidebar markı + dashboard nav active
  await expect(page.locator('.brand')).toBeVisible();
  await expect(page.locator('a[routerLink="/dashboard"], a[href*="/dashboard"]').first()).toBeVisible();

  // pageerror = runtime exception (network 4xx/console error değil — onlar normal)
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});

test('theme toggle — user footer butonu dark↔light', async ({ page }) => {
  await page.goto('/dashboard');

  const initial = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));

  // user footer'da güneş/ay buton
  const themeBtn = page.locator('.user .user-btn[title*="tema"], .user .user-btn[title*="Tema"]').first();
  await expect(themeBtn).toBeVisible();
  await themeBtn.click();

  const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(after).not.toBe(initial);

  // localStorage persist
  const persisted = await page.evaluate(() => localStorage.getItem('bp.theme'));
  expect(persisted).toBe(after);
});

test('sidebar collapse toggle', async ({ page }) => {
  await page.goto('/dashboard');
  const side = page.locator('.side');
  const initial = await side.evaluate((el) => el.classList.contains('collapsed'));

  await page.locator('.collapse-btn').click();

  const after = await side.evaluate((el) => el.classList.contains('collapsed'));
  expect(after).toBe(!initial);
});
