import { test, expect, type Page } from '@playwright/test';

/**
 * Dialog screenshots — light/dark her ikisinde:
 *  - Booking "Yeni İş" dialog
 *  - Booking düzenle dialog
 *
 * SCHED-B5a (Y5-1 ikinci revize 2026-05-08): Schedule "Yeni Ekle" / "Düzenle"
 * dialog'ları kaldırıldı (Canlı Yayın Plan B5a'da liste odaklı / read-only;
 * create/edit Yayın Planlama'dan). Schedule add dialog test'leri ile lig
 * dropdown test'i bu spec'ten silindi.
 *
 * Amaç: dialog formlarındaki light mode görünürlük sorunlarını yakala.
 */

async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((t) => {
    localStorage.setItem('bp.theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.waitForTimeout(150);
}

async function spaNav(page: Page, route: string) {
  const link = page.locator(`.side a[href="${route}"]`).first();
  await link.click();
  await page.waitForURL((u) => u.toString().endsWith(route), { timeout: 10_000 }).catch(() => {});
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`dialogs ${theme}`, () => {
    test('booking "Yeni İş" dialog screenshot', async ({ page }) => {
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle').catch(() => {});
      await setTheme(page, theme);
      await spaNav(page, '/bookings');

      const addBtn = page.getByRole('button', { name: /Yeni İş|Yeni İs/i }).first();
      const visible = await addBtn.isVisible().catch(() => false);
      if (!visible) test.skip(true, 'Yeni İş button not visible (no permission?)');

      await addBtn.click();
      const dialog = page.locator('mat-dialog-container').first();
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(400);

      await page.screenshot({
        path: `screenshots/${theme}-dialog-booking-new.png`,
        fullPage: false,
      });
    });

    test('booking düzenle dialog screenshot', async ({ page }) => {
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle').catch(() => {});
      await setTheme(page, theme);
      await spaNav(page, '/bookings');
      await page.waitForTimeout(500);

      // İlk row'da "düzenle" / "edit" ikon butonu
      const editBtn = page.locator('button[mat-icon-button], button.mat-mdc-icon-button')
        .filter({ has: page.locator('mat-icon:has-text("edit")') })
        .first();
      const has = await editBtn.count();
      if (!has) test.skip(true, 'no booking row with edit button');
      await editBtn.click();
      const dialog = page.locator('mat-dialog-container').first();
      const opened = await dialog.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
      if (!opened) test.skip(true, 'edit dialog did not open');
      await page.waitForTimeout(400);

      await page.screenshot({
        path: `screenshots/${theme}-dialog-booking-edit.png`,
        fullPage: false,
      });
    });

    test('dialog surface light mode — pastel-lavender değil net açık (regression)', async ({ page }) => {
      if (theme !== 'light') test.skip(true, 'sadece light mode için');
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle').catch(() => {});
      await setTheme(page, 'light');
      await spaNav(page, '/bookings');
      const addBtn = page.getByRole('button', { name: /Yeni İş/i }).first();
      const v = await addBtn.isVisible().catch(() => false);
      if (!v) test.skip(true, 'no add btn');
      await addBtn.click();
      const surface = page.locator('mat-dialog-container .mdc-dialog__surface').first();
      await surface.waitFor({ state: 'visible' });

      const bg = await surface.evaluate((el) => getComputedStyle(el).backgroundColor);
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      expect(m, `bg=${bg}`).not.toBeNull();
      if (m) {
        const sum = +m[1] + +m[2] + +m[3];
        expect(sum, `dialog surface light olsun (sum > 720), got ${sum} (${bg})`).toBeGreaterThan(720);
      }
    });
  });
}

// SCHED-B5a (Y5-1 ikinci revize 2026-05-08): "schedule add dialog — lig
// dropdown" + "schedule list — lig bg theme switch" test'leri silindi.
// ScheduleAddDialog kaldırıldı; lig dropdown ve schedule add aksiyonları yok.
