/**
 * Restore sekmesi — today-future scope HARD assertion testi (2026-05-28).
 *
 * Bu test SOFT GEÇMEZ. Dashboard'a redirect veya eski bundle görüldüğünde
 * doğrudan FAIL eder. Gerçek `/restore` sayfası + yeni UI (Gün kolonu,
 * date input yok, "Bugün ve gelecek" subtitle) zorunlu.
 *
 * Viewport × tema matrisi (4 ayrı test):
 *  - desktop 1440x900 dark / light
 *  - laptop  1280x720 dark / light
 *
 * Her test screenshot'ı assertion'lar BAŞARILI olduktan SONRA alır. Fail
 * durumunda Playwright otomatik failure-screenshot bırakır (config:
 * `screenshot: 'only-on-failure'`).
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCREEN_DIR = path.join(__dirname, 'screenshots', 'restore-today-future');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

const REQUIRED_HEADERS = [
  'Gün', 'Saat', 'Kanal', 'DC Kod', 'Başlık', 'Süre',
  'Kategori', 'SSDB', 'Ara', 'Restore', 'Transfer',
];

const viewports = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'laptop-1280x720',  width: 1280, height: 720 },
] as const;

const themes = ['dark', 'light'] as const;

for (const vp of viewports) {
  for (const theme of themes) {
    test(`restore today-future · ${vp.name} · ${theme}`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // Pattern: smoke-ingest.spec.ts (BCMS standart) — önce / dashboard, sonra
      // sidebar nav linkine click. Direct /restore goto Angular SPA initial
      // bootstrap'inden dolayı redirect alır.
      await page.goto('/');
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 }).catch(() => undefined);
      await page.locator('aside a').filter({ hasText: /^restore_pageRestore$|^Restore$/ }).first().click();

      // 1) URL hard assert: /restore'a varmış olmalıyız (dashboard redirect yasak).
      await page.waitForURL(/\/restore$/, { timeout: 15_000 });
      expect(page.url()).toMatch(/\/restore$/);

      // 2) app-restore root mount + h1 zorunlu (sidebar h1'lerden ayır).
      const appRestore = page.locator('app-restore');
      await appRestore.waitFor({ state: 'attached', timeout: 15_000 });
      const h1 = appRestore.locator('h1').first();
      await expect(h1).toBeVisible({ timeout: 15_000 });

      // 3) Tema set (BCMS html[data-theme]).
      await page.evaluate((t) => {
        document.documentElement.setAttribute('data-theme', t);
      }, theme);
      await page.waitForTimeout(400); // tema CSS uygulanması

      // 4) Subtitle "Bugün ve gelecek" hard assert.
      await expect(appRestore.locator('.subtitle').first()).toHaveText(/Bugün ve gelecek/i, { timeout: 5_000 });

      // 5) Date input artık YOK (yeni bundle koşulu).
      const dateInputCount = await appRestore.locator('input[type="date"]').count();
      expect(dateInputCount, 'Tarih input kaldırılmalı').toBe(0);

      // 6) Eksik Materyaller bölümü: tablo VEYA empty state. Tablo varsa tüm
      //    11 header görünmeli; yoksa empty state metni eşleşmeli.
      const tableExists = await appRestore.locator('table.restore-list').count() > 0;
      if (tableExists) {
        for (const h of REQUIRED_HEADERS) {
          await expect(
            appRestore.locator('table.restore-list thead th', { hasText: new RegExp(`^${h}$`, 'i') }).first(),
            `Tablo header "${h}" görünmeli`,
          ).toBeVisible();
        }
      } else {
        // Empty state — V1 metni "Seçili gün için SSDB'de eksik materyal yok" idi.
        // Today-future scope için bu metin değişmedi; yeterli kabul (data-yokluk).
        await expect(
          appRestore.locator('.state.empty', { hasText: /eksik materyal yok/i }).first(),
          'Empty state "eksik materyal yok" mesajı görünmeli',
        ).toBeVisible({ timeout: 5_000 });
      }

      // 7) Layout patlamasının ilk testi: page-level horizontal scroll YOK
      //    (.table-wrap kendi içinde scroll edebilir).
      const docOverflowsX = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
      });
      expect(docOverflowsX, 'Sayfa genelinde yatay scroll patlaması olmamalı').toBe(false);

      // 8) Tüm assert'ler geçti; screenshot kaydet.
      const file = path.join(SCREEN_DIR, `${vp.name}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`[restore-today-future] OK · ${vp.name} · ${theme} → ${file}`);
    });
  }
}
