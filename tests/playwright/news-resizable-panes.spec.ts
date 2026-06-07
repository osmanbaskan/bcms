import { test, expect, type Page } from '@playwright/test';

/**
 * Haber sekmesi — sol pane (bülten+havuz) ve sağ pane (Anadolu Ajansı)
 * sürüklenerek genişletilebilir; MIN 300px (kullanıcı isteği 2026-06-07);
 * genişlik localStorage'da kişiye özel. Splitter'lar .ns-body içinde.
 */

async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((t) => {
    localStorage.setItem('bp.theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.waitForTimeout(150);
}

test.describe('Haber — resizable panes (min 300)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name === 'mobile-chrome', 'desktop'));

  test('sol + sağ pane sürüklenir, min 300px clamp, localStorage', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await setTheme(page, 'light');
    // localStorage temiz başla
    await page.evaluate(() => { localStorage.removeItem('bp.news.leftW'); localStorage.removeItem('bp.news.rightW'); });
    const link = page.locator('.side a[href="/news"]').first();
    if (await link.count()) await link.click();
    await page.waitForURL((u) => u.toString().includes('/news'), { timeout: 10_000 }).catch(() => {});
    await page.reload();
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);

    const cols = () => page.evaluate(() => (document.querySelector('.ns-body') as HTMLElement).style.gridTemplateColumns);
    const lw = () => page.evaluate(() => Number(localStorage.getItem('bp.news.leftW')));
    const rw = () => page.evaluate(() => Number(localStorage.getItem('bp.news.rightW')));

    console.log('init cols:', await cols());
    expect(await cols()).toContain('450px'); // varsayılan sol 450

    const drag = async (idx: number, toX: number) => {
      const b = await page.locator('.splitter').nth(idx).boundingBox();
      if (!b) throw new Error('splitter yok');
      const y = b.y + 150; // viewport içi tut (ns-body viewport'tan uzun olabilir)
      await page.mouse.move(b.x + b.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(toX, y, { steps: 14 });
      await page.mouse.up();
      await page.waitForTimeout(150);
    };

    // 1) Sol splitter'ı çok sola sürükle → MIN 300 clamp
    await drag(0, 60);
    console.log('sol min sonrası leftW =', await lw(), ' cols:', await cols());
    expect(await lw()).toBe(300);

    // 2) Sol splitter'ı sağa ~+150 → ~450 (resize çalışıyor)
    const b0 = await page.locator('.splitter').nth(0).boundingBox();
    await drag(0, b0!.x + b0!.width / 2 + 150);
    const lw2 = await lw();
    console.log('sol +150 sonrası leftW =', lw2);
    expect(lw2).toBeGreaterThanOrEqual(430);
    expect(lw2).toBeLessThanOrEqual(470);

    // 3) Sağ splitter'ı sağa sürükle → sağ pane küçülür → MIN 300 clamp
    const b1 = await page.locator('.splitter').nth(1).boundingBox();
    await drag(1, b1!.x + b1!.width / 2 + 300);
    console.log('sağ min sonrası rightW =', await rw(), ' cols:', await cols());
    expect(await rw()).toBe(300);

    // 4) Kalıcılık: reload sonrası genişlikler korunur
    await page.reload();
    await page.waitForTimeout(700);
    console.log('reload sonrası cols:', await cols());
    expect(await lw()).toBe(lw2);
    expect(await rw()).toBe(300);
  });
});
