/**
 * Mobil görünüm screenshot'ları (2026-05-30) — Android (Pixel 7) + iPhone (14).
 * WebKit kurulu olmadığından iPhone da Chromium motorunda cihaz emülasyonu ile
 * (viewport + UA + deviceScaleFactor + isMobile + hasTouch). Tamamen offline.
 *
 * setup (auth.setup) dependency'sinden taze storageState alır.
 */
import { test, devices, chromium } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIR = path.join(__dirname, 'screenshots', 'mobile');
fs.mkdirSync(DIR, { recursive: true });
const STORAGE = path.join(__dirname, 'storage', 'auth.json');
const BASE = process.env.BCMS_BASE_URL ?? 'https://beinport';

const TARGETS = [
  { key: 'android', label: 'Android · Pixel 7', device: devices['Pixel 7'] },
  { key: 'iphone',  label: 'iPhone · 14',       device: devices['iPhone 14'] },
];

const PAGES = [
  { name: 'dashboard',     url: '/',                       wait: '.hero, .kpi-rail' },
  { name: 'provys',        url: '/provys-content-control', wait: 'table.provys-list, .state' },
  { name: 'asrun',         url: '/asrun',                  wait: 'table.asrun-list, .state' },
  { name: 'weekly-shift',  url: '/weekly-shift',           wait: '.shift-table, .empty' },
];

test('mobil screenshots — Android + iPhone', async () => {
  test.setTimeout(180_000);
  const browser = await chromium.launch();
  try {
    for (const t of TARGETS) {
      // device descriptor'ı chromium'a uygula (defaultBrowserType yok sayılır).
      const context = await browser.newContext({
        ...t.device,
        storageState: STORAGE,
        ignoreHTTPSErrors: true,
        baseURL: BASE,
        locale: 'tr-TR',
        timezoneId: 'Europe/Istanbul',
      });
      const page = await context.newPage();
      const vp = page.viewportSize();
      console.log(`\n=== ${t.label} (viewport ${vp?.width}x${vp?.height}, dpr ${t.device.deviceScaleFactor}) ===`);

      for (const p of PAGES) {
        try {
          await page.goto(p.url, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector(p.wait, { timeout: 15_000 }).catch(() => undefined);
          await page.waitForTimeout(1500);
          const file = path.join(DIR, `${t.key}-${p.name}.png`);
          await page.screenshot({ path: file });
          console.log(`  ✓ ${p.name} → ${path.basename(file)}`);
        } catch (e) {
          console.log(`  ✗ ${p.name}: ${String(e).slice(0, 90)}`);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
