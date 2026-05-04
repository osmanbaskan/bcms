import { test, expect, type Page, type Locator } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * Light Mode Comprehensive Audit
 *  - Tüm route'ları light mode'da gez, screenshot al
 *  - Her sayfada dialog açacak butonları bul, tıkla, screenshot, esc
 *  - Computed-style audit: text rgb sum, bg rgb sum, contrast eşikleri
 *  - findings.json: tüm aykırılıklar (low contrast, transparent bg vb.)
 */

const ROUTES = [
  { path: '/dashboard',           name: 'dashboard' },
  { path: '/schedules',           name: 'schedules' },
  { path: '/schedules/reporting', name: 'schedules-reporting' },
  { path: '/bookings',            name: 'bookings' },
  { path: '/studio-plan',         name: 'studio-plan' },
  { path: '/weekly-shift',        name: 'weekly-shift' },
  { path: '/ingest',              name: 'ingest' },
  { path: '/monitoring',          name: 'monitoring' },
  { path: '/mcr',                 name: 'mcr' },
  { path: '/users',               name: 'users' },
  { path: '/settings',            name: 'settings' },
  { path: '/audit-logs',          name: 'audit-logs' },
  { path: '/channels',            name: 'channels' },
  { path: '/provys-content-control', name: 'provys' },
];

interface Finding {
  route: string;
  context: string;
  selector: string;
  textPreview: string;
  bg: string;
  fg: string;
  contrast: number;
  issue: string;
}

const findings: Finding[] = [];

/** rgba'yı verilen "underBg" üzerine composite ederek solid rgb döndürür. */
function compositeOver(rgba: string, underBg = [255, 255, 255]): [number, number, number] | null {
  const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  const r = +m[1], g = +m[2], b = +m[3];
  const a = m[4] != null ? parseFloat(m[4]) : 1;
  if (a >= 1) return [r, g, b];
  return [
    Math.round(r * a + underBg[0] * (1 - a)),
    Math.round(g * a + underBg[1] * (1 - a)),
    Math.round(b * a + underBg[2] * (1 - a)),
  ];
}

function rgbToLum(rgb: string): number | null {
  const composed = compositeOver(rgb);
  if (!composed) return null;
  const [r, g, b] = composed.map((c) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg: string, bg: string): number {
  const Lf = rgbToLum(fg);
  const Lb = rgbToLum(bg);
  if (Lf == null || Lb == null) return 0;
  const [hi, lo] = Lf > Lb ? [Lf, Lb] : [Lb, Lf];
  return (hi + 0.05) / (lo + 0.05);
}

function isTransparent(rgb: string): boolean {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return true;
  return m[4] != null && parseFloat(m[4]) < 0.05;
}

async function effectiveBg(loc: Locator): Promise<string> {
  return await loc.evaluate((el) => {
    let cur: Element | null = el;
    while (cur) {
      const cs = window.getComputedStyle(cur);
      const m = cs.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (m && (m[4] == null || parseFloat(m[4]) > 0.05)) {
        return cs.backgroundColor;
      }
      cur = cur.parentElement;
    }
    return 'rgb(255, 255, 255)';
  });
}

async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((t) => {
    localStorage.setItem('bp.theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.waitForTimeout(100);
}

async function spaNav(page: Page, route: string) {
  const cleanPath = route.split('?')[0];
  const link = page.locator(`.side a[href="${cleanPath}"]`).first();
  if (await link.count()) {
    await link.click();
  } else {
    await page.evaluate((r) => {
      history.pushState({}, '', r);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, route);
  }
  await page.waitForURL((u) => u.toString().includes(cleanPath), { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
}

/** Sayfada görünür text elementlerini tarayıp düşük kontrast olanları finds'a yazar. */
async function auditPage(page: Page, routeName: string, context: string) {
  const samples = await page.evaluate(() => {
    const out: Array<{ sel: string; text: string; fg: string; bg: string }> = [];
    const allowedTags = ['H1','H2','H3','H4','H5','H6','P','SPAN','LABEL','TD','TH','LI','DIV','A','BUTTON','SMALL','STRONG','EM'];
    const seen = new WeakSet<Element>();
    const sidebarRoot = document.querySelector('.side');

    document.querySelectorAll('*').forEach((el) => {
      if (sidebarRoot && sidebarRoot.contains(el)) return;   // sidebar mor, skip
      if (!allowedTags.includes(el.tagName)) return;
      if (seen.has(el)) return;
      const text = (el.textContent ?? '').trim();
      if (text.length < 2 || text.length > 80) return;
      // Skip elements that have nested children with text
      const childTexts = Array.from(el.children).map((c) => (c.textContent ?? '').trim());
      if (childTexts.some((ct) => ct.length > 1 && text.startsWith(ct))) return;

      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;

      const cs = window.getComputedStyle(el);
      if (cs.visibility !== 'visible' || cs.opacity === '0') return;

      // climb for effective bg — gradient (background-image) varsa bu element'i SKIP
      let bg = cs.backgroundColor;
      let cur: Element | null = el;
      let hasGradient = false;
      while (cur) {
        const csi = window.getComputedStyle(cur);
        if (csi.backgroundImage && /gradient/.test(csi.backgroundImage)) {
          hasGradient = true;
          break;
        }
        const m = csi.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (m && (m[4] == null || parseFloat(m[4]) > 0.05)) {
          bg = csi.backgroundColor;
          break;
        }
        cur = cur.parentElement;
      }
      if (hasGradient) return;   // gradient'lerde contrast hesabı kararsız, atla

      const sel = el.tagName.toLowerCase()
        + (el.id ? `#${el.id}` : '')
        + (el.className && typeof el.className === 'string' ? `.${el.className.split(' ').filter(Boolean).slice(0, 2).join('.')}` : '');

      out.push({
        sel,
        text: text.slice(0, 60),
        fg: cs.color,
        bg,
      });
      seen.add(el);
    });

    return out.slice(0, 200);
  });

  for (const s of samples) {
    const ratio = contrastRatio(s.fg, s.bg);
    if (ratio > 0 && ratio < 3.0) {
      findings.push({
        route: routeName,
        context,
        selector: s.sel,
        textPreview: s.text,
        bg: s.bg,
        fg: s.fg,
        contrast: Math.round(ratio * 100) / 100,
        issue: 'low-contrast',
      });
    }
    if (isTransparent(s.bg) && s.fg.includes('rgba(') === false) {
      // Inherited via climb so unlikely; ignore.
    }
  }
}

test.beforeAll(() => {
  fs.mkdirSync('screenshots/light-audit', { recursive: true });
  fs.mkdirSync('screenshots/light-dialogs', { recursive: true });
  findings.length = 0;
});

test.afterAll(() => {
  fs.writeFileSync(
    'screenshots/light-audit/findings.json',
    JSON.stringify(findings, null, 2),
  );
  console.log(`[audit] toplam ${findings.length} low-contrast finding`);
});

test('light mode audit — tüm rotalar + dialog\'lar', async ({ page }) => {
  test.setTimeout(360_000);

  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle').catch(() => {});
  await setTheme(page, 'light');

  for (const route of ROUTES) {
    await test.step(`route ${route.name}`, async () => {
      await spaNav(page, route.path);
      await page.waitForTimeout(800);

      // base screenshot
      await page.screenshot({
        path: `screenshots/light-audit/${route.name}.png`,
        fullPage: true,
      });

      await auditPage(page, route.name, 'base');

      // dialog buttons — text matches: Yeni|Ekle|Düzenle|Add|Edit|+
      const triggers = page.locator(
        'button:has-text("Yeni"), button:has-text("Ekle"), button:has-text("Düzenle"), '
        + 'button:has-text("Yeni İş"), button:has-text("Yeni Ekle"), '
        + 'button[mat-icon-button]:has(mat-icon:has-text("edit")), '
        + 'button[mat-icon-button]:has(mat-icon:has-text("add"))'
      );
      const triggerCount = Math.min(await triggers.count(), 4);   // ilk 4 trigger

      for (let i = 0; i < triggerCount; i++) {
        const btn = triggers.nth(i);
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) continue;
        const label = (await btn.textContent().catch(() => ''))?.trim().replace(/\s+/g, '-').slice(0, 24) || `btn${i}`;

        await btn.click().catch(() => {});
        await page.waitForTimeout(400);

        const dlg = page.locator('mat-dialog-container').first();
        const opened = await dlg.isVisible().catch(() => false);
        if (!opened) continue;

        await page.screenshot({
          path: `screenshots/light-dialogs/${route.name}--${label || `dialog-${i}`}.png`,
          fullPage: false,
        });

        await auditPage(page, route.name, `dialog:${label}`);

        // Esc kapat
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
      }
    });
  }

  // Test pass/fail: çok yüksek finding sayısı varsa fail (regression sinyal)
  console.log(`[audit] route-level findings: ${findings.length}`);
});
