/**
 * Mobil — sidebar KAPALI (collapsed) screenshot'ları (2026-05-30).
 * Her sayfa için ayrı dosya; iPhone 14 + Android Pixel 7.
 * Sidebar collapse: .collapse-btn (aria "Menüyü küçült") → .side.collapsed (64px).
 */
import { test, devices, chromium } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIR = path.join(__dirname, 'screenshots', 'mobile-collapsed');
fs.mkdirSync(DIR, { recursive: true });
const STORAGE = path.join(__dirname, 'storage', 'auth.json');
const BASE = process.env.BCMS_BASE_URL ?? 'https://beinport';

const TARGETS = [
  { key: 'iphone',  device: devices['iPhone 14'] },
  { key: 'android', device: devices['Pixel 7'] },
];
const PAGES = [
  { name: 'dashboard',     url: '/',                       wait: '.hero, .kpi-rail' },
  { name: 'provys',        url: '/provys-content-control', wait: 'table.provys-list, .state' },
  { name: 'asrun',         url: '/asrun',                  wait: 'table.asrun-list, .state' },
  { name: 'weekly-shift',  url: '/weekly-shift',           wait: '.shift-table, .empty' },
];

test('mobil collapsed sidebar screenshots', async () => {
  test.setTimeout(180_000);
  const browser = await chromium.launch();
  try {
    for (const t of TARGETS) {
      const ctx = await browser.newContext({
        ...t.device, storageState: STORAGE, ignoreHTTPSErrors: true,
        baseURL: BASE, locale: 'tr-TR', timezoneId: 'Europe/Istanbul',
      });
      const page = await ctx.newPage();
      console.log(`\n=== ${t.key} ===`);
      for (const p of PAGES) {
        await page.goto(p.url, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(p.wait, { timeout: 15_000 }).catch(() => undefined);
        // Sidebar'ı kapat (zaten kapalı değilse).
        const collapsed = await page.locator('aside.side.collapsed').count();
        if (collapsed === 0) {
          await page.locator('.collapse-btn').click().catch(() => undefined);
          await page.waitForTimeout(500);
        }
        await page.waitForTimeout(800);
        const file = path.join(DIR, `${t.key}-${p.name}.png`);
        await page.screenshot({ path: file });
        console.log(`  ✓ ${p.name} → ${path.basename(file)}`);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});
