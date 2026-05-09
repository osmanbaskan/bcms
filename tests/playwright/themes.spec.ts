import { test, expect, type Page } from '@playwright/test';

/**
 * Theme test'leri — dark/light her birinde:
 *   1) Sayfa screenshot'ı al (görsel inceleme)
 *   2) Computed style assertion'ları (text rengi, border rengi)
 *
 * Talimatlar:
 *  - Sidebar mor (--bp-sidebar-gradient) — her temada SABİT
 *  - Light mode'da çerçeve = patlıcan moru (#5d2e5d ya da rgba(93,46,93,.32))
 *  - Schedules/Ingest/Studio-plan'de light mode metin = #4c1d95 (sidebar gradient top)
 */

const ROUTES = [
  { path: '/dashboard',   name: 'dashboard' },
  { path: '/schedules',   name: 'schedules' },
  { path: '/ingest',      name: 'ingest' },
  { path: '/studio-plan', name: 'studio-plan' },
  { path: '/bookings',    name: 'bookings' },
  { path: '/weekly-shift',name: 'weekly-shift' },
  { path: '/audit-logs',  name: 'audit-logs' },
];

async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((t) => {
    localStorage.setItem('bp.theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.waitForTimeout(150);
}

/** SPA navigation — sidebar link click; full reload yapma (Keycloak SSO race önle). */
async function spaNav(page: Page, route: string) {
  // Önce dashboard'da olduğumuzdan emin ol; çağıran fonk. /dashboard'a gitmiş olmalı
  const link = page.locator(`.side a[href="${route}"], .side a[routerLink="${route}"]`).first();
  if (await link.count()) {
    await link.click();
    await page.waitForURL((u) => u.toString().endsWith(route), { timeout: 10_000 }).catch(() => {});
  } else {
    // Sidebar'da yoksa router.navigateByUrl
    await page.evaluate((r) => {
      const root = (window as unknown as { ng?: { getInjector?: () => unknown } }).ng;
      // Fallback — direkt history pushState
      history.pushState({}, '', r);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, route);
  }
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`theme=${theme}`, () => {
    for (const route of ROUTES) {
      test(`${route.name} renders`, async ({ page }) => {
        await page.goto('/dashboard');
        await page.waitForLoadState('networkidle').catch(() => {});
        await setTheme(page, theme);
        if (route.path !== '/dashboard') await spaNav(page, route.path);
        await page.waitForTimeout(500);

        const dataTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
        expect(dataTheme).toBe(theme);

        await page.screenshot({
          path: `screenshots/${theme}-${route.name}.png`,
          fullPage: true,
        });
      });
    }

    test('sidebar gradient — her temada mor', async ({ page }) => {
      await page.goto('/dashboard');
      await setTheme(page, theme);

      const bg = await page.evaluate(() => {
        const side = document.querySelector('.side');
        return side ? getComputedStyle(side).background : '';
      });
      expect(bg).toContain('linear-gradient');
      expect(bg).toMatch(/rgb\(76,\s*29,\s*149\)|#4c1d95/i);
    });
  });
}

test.describe('light mode özel kurallar', () => {
  test('schedule-list metin rengi sidebar mor (#4c1d95)', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle').catch(() => {});
    await setTheme(page, 'light');
    await spaNav(page, '/schedules');
    await page.locator('app-schedule-list').waitFor({ state: 'attached', timeout: 10_000 });

    const fg1 = await page.evaluate(() => {
      const root = document.querySelector('app-schedule-list') as HTMLElement | null;
      if (!root) return 'NO_ELEMENT';
      return getComputedStyle(root).getPropertyValue('--bp-fg-1').trim();
    });
    expect(fg1.toLowerCase()).toBe('#4c1d95');
  });

  test('global çerçeve — patlıcan moru token', async ({ page }) => {
    await page.goto('/dashboard');
    await setTheme(page, 'light');
    const line = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bp-line').trim());
    expect(line.toLowerCase()).toBe('#5d2e5d');
  });

  test('time input bg — light (regression)', async ({ page }) => {
    // SCHED-B5a (Y5-7, ikinci revize 2026-05-08): "Canlı Yayın Planından
    // Ingest" flow disabled; ingest plan rows kalıcı boş ⇒ ingest-list
    // `.time-input`'u render edilmez. Test Yayın Planlama broadcast form'una
    // (`/yayin-planlama/new`) yönlendirildi — `input[type="time"]` orada
    // aktif (mat-input). Regression hâlâ geçerli: light mode'da time
    // input'un arka rengi beyaza yakın olmalı.
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle').catch(() => {});
    await setTheme(page, 'light');
    await spaNav(page, '/yayin-planlama/new');
    const ti = page.locator('input[type="time"]').first();
    await ti.waitFor({ state: 'attached', timeout: 10_000 });
    const styles = await ti.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, scheme: cs.colorScheme };
    });
    // bg light: rgb close to white (>= 240 on each channel) ya da inherited bg-2 (white)
    const m = styles.bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    expect(m, `bg=${styles.bg}`).not.toBeNull();
    if (m) {
      const r = +m[1], g = +m[2], b = +m[3];
      expect(r + g + b, `bg rgb sum=${r + g + b}`).toBeGreaterThan(700); // ~white
    }
  });

  test('ingest filter chip — light mode okunur (regression)', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle').catch(() => {});
    await setTheme(page, 'light');
    await spaNav(page, '/ingest');
    const chip = page.locator('.plan-filter-button').first();
    await chip.waitFor({ state: 'attached', timeout: 10_000 });
    const color = await chip.evaluate((el) => getComputedStyle(el).color);
    // Light mode'da metin rengi koyu olmalı (#3b0764 or var(--bp-fg-2))
    const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    expect(m, `color=${color}`).not.toBeNull();
    if (m) {
      const sum = +m[1] + +m[2] + +m[3];
      expect(sum, `text rgb sum=${sum}`).toBeLessThan(450); // koyu (light mode bg üzerinde okunur)
    }
  });

  test('mat-form-field underline — light mode purple', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle').catch(() => {});
    await setTheme(page, 'light');
    await spaNav(page, '/bookings');
    const ripple = page.locator('.mdc-line-ripple').first();
    if (await ripple.count() === 0) test.skip(true, 'no mat-form-field on this view');
    const before = await ripple.evaluate((el) => {
      const style = window.getComputedStyle(el, '::before');
      return style.borderBottomColor;
    });
    // var(--bp-line) = #5d2e5d → rgb(93, 46, 93)
    expect(before).toMatch(/rgb\(93,\s*46,\s*93\)/);
  });
});
