/**
 * Dashboard hero — bugünün CANLI event listesi (Provys) (2026-05-29).
 *
 * Eski "Canlı yayın takibi henüz bağlı değil" placeholder'ı kaldırıldı; hero
 * artık /provys/live-today'den bugünün tüm kanallar CANLI event'lerini gösterir.
 * Kontroller:
 *  1. Eski placeholder metni YOK.
 *  2. Hero'da "CANLI" rozeti var.
 *  3. Liste varsa: her satır saat (HH:MM) + kanal + başlık; DC kod YOK.
 *  4. Sayaç ("N yayın") satır sayısıyla tutarlı.
 *  (Veri bugüne bağlı; satır yoksa boş-durum mesajı kabul edilir.)
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCREEN_DIR = path.join(__dirname, 'screenshots', 'dashboard-live-today');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

test('dashboard hero: Provys CANLI listesi + DC kod yok', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/dashboard$|\/$/, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForSelector('.hero', { timeout: 15_000 });
  await page.waitForTimeout(2_000); // /provys/live-today fetch settle

  // 1. Eski placeholder metni gitmiş olmalı.
  await expect(
    page.getByText('Canlı yayın takibi henüz bağlı değil'),
    'eski placeholder metni kalmamalı',
  ).toHaveCount(0);

  // 2. CANLI rozeti.
  await expect(page.locator('.hero .hero-badge')).toContainText('CANLI');

  const rows = page.locator('.hero-live-row');
  const n = await rows.count();
  console.log(`[dashboard] hero-live-row sayısı = ${n}`);

  await page.screenshot({ path: path.join(SCREEN_DIR, 'hero.png') });

  // KPI "Bugün canlı yayın" = tüm kanallar CANLI toplamı (= hero satır sayısı).
  // Aynı /provys/live-today kaynağı; yeni kanal otomatik sayıya dahil.
  const liveKpi = page.locator('bp-kpi').filter({ hasText: 'Bugün canlı yayın' });
  await expect(liveKpi.locator('.value')).toContainText(String(n));
  // Sub-label kaldırıldı: KPI'da alt yazı (sub) olmamalı.
  await expect(liveKpi.locator('.sub')).toHaveCount(0);
  await expect(page.getByText('tüm kanallar · Provys')).toHaveCount(0);

  if (n === 0) {
    // Boş/yükleniyor durumu kabul (o günde CANLI olmayabilir).
    await expect(page.locator('.hero-live-state')).toBeVisible();
    return;
  }

  // 4. Sayaç tutarlı.
  await expect(page.locator('.hero-live-count')).toContainText(`${n} yayın`);

  // 3. Satır yapısı: saat HH:MM + kanal + başlık dolu; DC kod elementi yok.
  for (let i = 0; i < Math.min(n, 8); i++) {
    const r = rows.nth(i);
    await expect(r.locator('.hl-time')).toHaveText(/^(\d{2}:\d{2}|—)$/);
    expect((await r.locator('.hl-channel').innerText()).trim().length).toBeGreaterThan(0);
    expect((await r.locator('.hl-title').innerText()).trim().length).toBeGreaterThan(0);
  }

  // DC kod hiçbir hero satırında render edilmemeli (col-dc / dc-code class yok).
  await expect(page.locator('.hero .col-dc, .hero .row-dc, .hero .hl-dc')).toHaveCount(0);
});
