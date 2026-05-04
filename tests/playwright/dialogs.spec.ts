import { test, expect, type Page } from '@playwright/test';

/**
 * Dialog screenshots — light/dark her ikisinde:
 *  - Schedule "Yeni Ekle" dialog (add)
 *  - Schedule "Düzenle" dialog (edit, ilk schedule kaydı varsa)
 *  - Booking "Yeni İş" dialog
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
    test('schedule "Yeni Ekle" dialog screenshot', async ({ page }) => {
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle').catch(() => {});
      await setTheme(page, theme);
      await spaNav(page, '/schedules');

      // "Yeni Ekle" butonu
      const addBtn = page.getByRole('button', { name: /Yeni Ekle/i }).first();
      await addBtn.waitFor({ state: 'visible', timeout: 10_000 });
      await addBtn.click();

      // Dialog görünür olsun
      const dialog = page.locator('mat-dialog-container').first();
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(400);

      await page.screenshot({
        path: `screenshots/${theme}-dialog-schedule-add.png`,
        fullPage: false,
      });
    });

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

test.describe('schedule add dialog — lig dropdown', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} — lig option'larda vivid bg + beyaz metin`, async ({ page }) => {
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle').catch(() => {});
      await setTheme(page, theme);
      await spaNav(page, '/schedules');

      const addBtn = page.getByRole('button', { name: /Yeni Ekle/i }).first();
      await addBtn.click();
      const dlg = page.locator('mat-dialog-container').first();
      await dlg.waitFor({ state: 'visible' });

      // Adım 1: dialog içindeki ilk mat-select → "İçerik Türü" → "Maç"
      await dlg.locator('mat-select').first().click();
      await page.waitForTimeout(200);
      const matchOpt = page.locator('.cdk-overlay-pane mat-option').filter({ hasText: /Müsabaka|Maç/i }).first();
      const has = await matchOpt.count();
      if (!has) test.skip(true, 'Müsabaka içerik türü mevcut değil');
      await matchOpt.click();
      await page.waitForTimeout(400);

      // Adım 2: dialog içindeki Lig/Turnuva select (artık 2.veya sonraki select)
      const selects = dlg.locator('mat-select');
      const selCount = await selects.count();
      if (selCount < 2) test.skip(true, 'lig select görünmedi');
      await selects.nth(selCount - 1).click();
      await page.waitForTimeout(400);

      // mat-option.league-option'lar açılır panel içinde
      const leagueOptions = page.locator('.cdk-overlay-pane mat-option.league-option, .cdk-overlay-pane mat-option[style*="background"]');
      const optCount = await leagueOptions.count();
      if (optCount === 0) test.skip(true, 'lig option yok');

      // Screenshot
      await page.screenshot({
        path: `screenshots/${theme}-dialog-league-dropdown.png`,
        fullPage: false,
      });

      // İlk 3 option'ın bg vivid (rgb sum < 600, koyu) ve text beyaz olmalı
      const samples = await leagueOptions.evaluateAll((els) =>
        els.slice(0, 3).map((el) => {
          const cs = getComputedStyle(el as HTMLElement);
          const text = el.querySelector('.mdc-list-item__primary-text, span') as HTMLElement | null;
          const textCs = text ? getComputedStyle(text) : cs;
          return { bg: cs.backgroundColor, color: textCs.color };
        }));

      for (const s of samples) {
        const bgM = s.bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        const txtM = s.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!bgM || !txtM) continue;
        const bgSum = +bgM[1] + +bgM[2] + +bgM[3];
        const txtSum = +txtM[1] + +txtM[2] + +txtM[3];
        expect(bgSum, `option bg=${s.bg} should be vivid (sum<500), got ${bgSum}`).toBeLessThan(500);
        expect(txtSum, `option text=${s.color} should be white (sum>720), got ${txtSum}`).toBeGreaterThan(720);
      }
    });
  }
});

test.describe('schedule list — lig bg theme switch', () => {
  test('row bg vivid (mevcut kayıt varsa)', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle').catch(() => {});
    await setTheme(page, 'light');
    await spaNav(page, '/schedules');
    await page.waitForTimeout(800);

    const rows = page.locator('tr.has-league-color');
    const count = await rows.count();
    if (count === 0) test.skip(true, 'no schedule rows with league color');

    const samples = await rows.evaluateAll((els) =>
      els.slice(0, 3).map((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color };
      }));

    for (const s of samples) {
      const bgM = s.bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      const txtM = s.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!bgM || !txtM) continue;
      const bgSum = +bgM[1] + +bgM[2] + +bgM[3];
      const txtSum = +txtM[1] + +txtM[2] + +txtM[3];
      expect(bgSum, `row bg=${s.bg} should be vivid (sum<500)`).toBeLessThan(500);
      expect(txtSum, `row text=${s.color} should be white`).toBeGreaterThan(720);
    }
  });
});
