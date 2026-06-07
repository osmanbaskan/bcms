import { test, expect, type Page } from '@playwright/test';

/**
 * Haber → Prompter: scroll yalnız prompter alanında (.pr-scroll) olmalı; TÜM
 * sayfa kaymamalı (kullanıcı isteği 2026-06-07). Merkez pane bileşen host'ları
 * flex:1 ile pane'i doldurunca iç overflow:auto devreye girer.
 */
async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((t) => {
    localStorage.setItem('bp.theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.waitForTimeout(150);
}

test.describe('Haber Prompter — alan-içi scroll', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name === 'mobile-chrome', 'desktop'));

  test('prompter kendi içinde kayar, sayfa kaymaz', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await setTheme(page, 'light');
    const link = page.locator('.side a[href="/news"]').first();
    if (await link.count()) await link.click();
    await page.waitForURL((u) => u.toString().includes('/news'), { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);

    // Bülten seç (varsa) — prompter içeriği için
    const optCount = await page.locator('.bl-select option').count();
    if (optCount > 1) {
      await page.locator('.bl-select').selectOption({ index: 1 });
      await page.waitForTimeout(600);
    }

    // Prompter görünümüne geç
    await page.locator('.nh-views button', { hasText: 'Prompter' }).click();
    await page.waitForTimeout(400);

    const before = await page.evaluate(() => {
      const sc = document.querySelector('.pr-scroll') as HTMLElement | null;
      const doc = (document.scrollingElement || document.documentElement) as HTMLElement;
      return {
        prScrollVar: !!sc,
        hasInnerScroll: sc ? sc.scrollHeight > sc.clientHeight + 2 : false,
        clientH: sc?.clientHeight ?? -1,
        scrollH: sc?.scrollHeight ?? -1,
        pageOverflow: doc.scrollHeight > doc.clientHeight + 2,
      };
    });

    // Prompter alanı içinde aşağı kaydır
    await page.evaluate(() => { const sc = document.querySelector('.pr-scroll') as HTMLElement; if (sc) sc.scrollTop = 400; });
    await page.waitForTimeout(150);

    const after = await page.evaluate(() => {
      const sc = document.querySelector('.pr-scroll') as HTMLElement;
      return { prScrollTop: sc?.scrollTop ?? -1, windowScrollY: window.scrollY };
    });

    console.log('before:', JSON.stringify(before));
    console.log('after :', JSON.stringify(after));

    expect(before.prScrollVar, '.pr-scroll mevcut').toBe(true);
    expect(before.hasInnerScroll, 'prompter alanı kaydırılabilir (içerik > kap)').toBe(true);
    expect(after.prScrollTop, 'prompter gerçekten kaydı').toBeGreaterThan(0);
    expect(after.windowScrollY, 'TÜM SAYFA kaymadı').toBe(0);
    expect(before.pageOverflow, 'sayfa dikey overflow etmiyor (viewport-sınırlı)').toBe(false);
  });
});
