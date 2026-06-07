import { test, expect, type Page } from '@playwright/test';

/**
 * Haber sekmesi — buton stil eşleşmesi (kullanıcı isteği 2026-06-07, 2. revize):
 *  - "+ Yeni Bülten" (.btn-new) ve "+ Havuza Haber" (.pool-new) → Akış-AKTİF
 *    butonuyla AYNI: DOLU mor (var(--bp-purple-500), beyaz yazı).
 *  - Prompter/Akış toggle'da AKTİF olan dolu görünür; inaktif olan tint kalır.
 *
 * Hem LIGHT hem DARK temada doğrulanır (stil tema-bağımsız token kullanır;
 * her temada ölçülen değerler birbirine eşit olmalı).
 */

async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((t) => {
    localStorage.setItem('bp.theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.waitForTimeout(150);
}

test.describe('Haber — buton stil eşleşmesi (dark + light)', () => {
  test.beforeEach(({}, info) =>
    test.skip(info.project.name === 'mobile-chrome', 'BCMS desktop-first.'),
  );

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: Yeni Bülten + Havuza Haber == Akış-aktif (dolu); Prompter inaktif = tint`, async ({ page }) => {
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      await setTheme(page, theme);
      const link = page.locator('.side a[href="/news"]').first();
      if (await link.count()) await link.click();
      await page.waitForURL((u) => u.toString().includes('/news'), { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(900);
      await setTheme(page, theme); // route sonrası tema garanti

      const r = await page.evaluate(() => {
        function st(el: Element | null | undefined) {
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, border: cs.borderTopColor, color: cs.color };
        }
        const aktif = document.querySelector('.nh-views button.on');
        const yeniBulten = document.querySelector('.btn-new');
        const havuza = document.querySelector('.pool-new');
        const prompterInaktif = Array.from(document.querySelectorAll('.nh-views button'))
          .find((b) => /Prompter/.test(b.textContent || '') && !b.classList.contains('on'));
        return { aktif: st(aktif), yeniBulten: st(yeniBulten), havuza: st(havuza), prompterInaktif: st(prompterInaktif) };
      });

      console.log(`\n=== [${theme}] Buton stil eşleşmesi ===`);
      console.log('Akış (aktif, REF)  :', JSON.stringify(r.aktif));
      console.log('+ Yeni Bülten      :', JSON.stringify(r.yeniBulten));
      console.log('+ Havuza Haber     :', JSON.stringify(r.havuza));
      console.log('Prompter (inaktif) :', JSON.stringify(r.prompterInaktif));

      const WHITE = 'rgb(255, 255, 255)';

      // Akış-aktif: dolu (opak, alpha içermez) + beyaz yazı
      expect(r.aktif?.bg, 'Akış-aktif opak dolgu').not.toContain('rgba');
      expect(r.aktif?.color, 'Akış-aktif beyaz yazı').toBe(WHITE);

      // Yeni Bülten == Akış-aktif
      expect(r.yeniBulten?.bg, '+Yeni Bülten bg = Akış-aktif').toBe(r.aktif?.bg);
      expect(r.yeniBulten?.color, '+Yeni Bülten beyaz yazı').toBe(WHITE);

      // Havuza Haber == Akış-aktif
      expect(r.havuza?.bg, '+Havuza Haber bg = Akış-aktif').toBe(r.aktif?.bg);
      expect(r.havuza?.color, '+Havuza Haber beyaz yazı').toBe(WHITE);

      // Prompter inaktif = tint (yarı saydam) → dolu DEĞİL, toggle ayrımı korunur
      expect(r.prompterInaktif?.bg, 'Prompter inaktif yarı-saydam tint').toContain('rgba');
      expect(r.prompterInaktif?.bg, 'Prompter inaktif ≠ Akış-aktif').not.toBe(r.aktif?.bg);
    });
  }
});
