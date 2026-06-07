import { test, expect, type Page } from '@playwright/test';

/**
 * Haber Havuzu — 22 materyal/sayfa sınırı + fazlası sayfalanır
 * (kullanıcı isteği 2026-06-07). Canlı havuz sayısına göre adaptif:
 *  - her zaman: render edilen .pool-item ≤ 22 ve == min(total, 22)
 *  - pager yalnız total > 22 iken görünür
 *  - total > 22 ise sonraki sayfa kalan materyalleri gösterir
 */
async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((t) => {
    localStorage.setItem('bp.theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.waitForTimeout(150);
}

test.describe('Haber Havuzu — 22/sayfa', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name === 'mobile-chrome', 'desktop'));

  test('22 cap + pager (>22 ise sayfalama)', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await setTheme(page, 'light');
    const link = page.locator('.side a[href="/news"]').first();
    if (await link.count()) await link.click();
    await page.waitForURL((u) => u.toString().includes('/news'), { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(900);

    const total = Number((await page.locator('.pool-h span').first().innerText()).trim());
    const rendered = await page.locator('.pool-item').count();
    console.log(`HAVUZ total=${total} · sayfa1 render=${rendered} (cap 22)`);

    expect(rendered).toBeLessThanOrEqual(22);
    expect(rendered).toBe(Math.min(total, 22));

    const pagerVisible = await page.locator('.pool-pager').isVisible().catch(() => false);
    console.log(`pager görünür=${pagerVisible} (beklenen: total>22 → ${total > 22})`);
    expect(pagerVisible).toBe(total > 22);

    if (total > 22) {
      expect((await page.locator('.pool-pager .pg').innerText()).trim()).toMatch(/^1 \//);
      await page.locator('.pool-pager button').nth(1).click(); // sonraki
      await page.waitForTimeout(250);
      const rendered2 = await page.locator('.pool-item').count();
      console.log(`sayfa2 render=${rendered2} (beklenen ${Math.min(total - 22, 22)})`);
      expect(rendered2).toBe(Math.min(total - 22, 22));
      expect((await page.locator('.pool-pager .pg').innerText()).trim()).toMatch(/^2 \//);
    } else {
      console.log('NOT: canlı havuz ≤22 → çok sayfa senaryosu bu veriyle tetiklenmedi (cap doğrulandı).');
    }
  });
});
