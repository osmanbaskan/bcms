import { test, expect } from '@playwright/test';

/**
 * BCMS Dashboard — kanal kutuları + büyütme (READ-ONLY).
 *
 * 2026-05-31: "Bugünün yayın akışı" + "Son uyarılar" kartları kaldırıldı;
 * BUGÜN CANLİ YAYIN altına 6 kanal kutusu eklendi (her biri büyütülebilir).
 *
 * Önkoşul: dev server ayakta (:4200); storageState auth.setup'tan gelir.
 * Kapsam:
 *   - dashboard yüklenir (KPI rail görünür)
 *   - kaldırılan kartlar YOK ("Bugünün yayın akışı", "Son uyarılar")
 *   - 6 kanal kutusu render edilir
 *   - her kutuda büyütme (çapraz-ok) butonu var
 *   - büyütme → overlay açılır; kapatma → overlay kapanır
 * Görsel: full-page + overlay screenshot.
 */
test.describe('Dashboard kanal kutuları', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('dashboard yüklenir; KPI rail görünür', async ({ page }) => {
    await expect(page.locator('.kpi-rail')).toBeVisible();
    await expect(page.getByText('Bugün canlı yayın')).toBeVisible();
  });

  test('kaldırılan kartlar artık yok', async ({ page }) => {
    await expect(page.getByText('Bugünün yayın akışı')).toHaveCount(0);
    await expect(page.getByText('Son uyarılar')).toHaveCount(0);
  });

  test('6 kanal kutusu render edilir', async ({ page }) => {
    const boxes = page.locator('[data-test="channel-boxes"] .ch-box');
    await expect(boxes).toHaveCount(6);
    // İlk kutuda kanal adı görünür
    await expect(boxes.first().locator('.ch-name')).toBeVisible();
  });

  test('her kutuda büyütme (çapraz-ok) butonu var', async ({ page }) => {
    const expandBtns = page.locator('[data-test="channel-boxes"] .ch-box .ch-expand');
    await expect(expandBtns).toHaveCount(6);
  });

  test('büyütme overlay açar; kapatma kapatır; içerik ortalanır', async ({ page }) => {
    // overlay başta yok
    await expect(page.locator('[data-test="channel-overlay"]')).toHaveCount(0);

    // ilk kutuyu büyüt
    const firstBox = page.locator('[data-test="channel-boxes"] .ch-box').first();
    const firstName = (await firstBox.locator('.ch-name').textContent())?.trim() ?? '';
    await firstBox.locator('.ch-expand').click();

    // overlay + büyük kutu görünür, aynı kanal adı
    const overlay = page.locator('[data-test="channel-overlay"]');
    await expect(overlay).toBeVisible();
    const bigBox = overlay.locator('.ch-box--big');
    await expect(bigBox).toBeVisible();
    if (firstName) {
      await expect(bigBox.locator('.ch-name')).toHaveText(firstName);
    }

    // büyük kutu viewport'ta ortalanmış mı (kabaca merkeze yakın)
    const vp = page.viewportSize();
    const bb = await bigBox.boundingBox();
    if (vp && bb) {
      const cx = bb.x + bb.width / 2;
      const cy = bb.y + bb.height / 2;
      expect(Math.abs(cx - vp.width / 2)).toBeLessThan(vp.width * 0.18);
      expect(Math.abs(cy - vp.height / 2)).toBeLessThan(vp.height * 0.25);
    }

    // ekran görüntüsü (büyütülmüş hâli)
    await page.screenshot({ path: 'screenshots/dashboard-expanded.png', fullPage: false });

    // backdrop'a tıkla → kapanır
    await overlay.click({ position: { x: 5, y: 5 } });
    await expect(page.locator('[data-test="channel-overlay"]')).toHaveCount(0);
  });

  test('görsel: dashboard tam sayfa', async ({ page }) => {
    await expect(page.locator('.channels-row')).toBeVisible();
    await page.screenshot({ path: 'screenshots/dashboard-full.png', fullPage: true });
  });
});
