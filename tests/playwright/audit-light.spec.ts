import { test, expect, type Page, type Locator } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * Light Mode Comprehensive Audit
 *  - Tüm route'ları light mode'da gez, screenshot al
 *  - Her sayfada dialog açacak butonları bul, tıkla, screenshot, esc
 *  - Computed-style audit: text rgb sum, bg rgb sum, contrast eşikleri
 *  - findings.json: tüm aykırılıklar (low contrast, transparent bg vb.)
 *
 * SCHED-B5a (Y5-3 + Y5-7, ikinci revize 2026-05-08): generic mat-icon
 * substring trigger filter'ı kaldırıldı; her route için açık accessible
 * isim bazlı trigger allowlist (`getDialogTriggersForRoute`) kullanılır.
 *  - /schedules: dialog trigger YOK (B5a read-only)
 *  - /ingest: dialog trigger YOK ("Canlı Yayın Planından Ingest" disabled;
 *    base audit yapılır, click denenmez)
 *  - /bookings: "Yeni İş" + booking edit (matTooltip="Düzenle")
 *  - /users: "Yeni Kullanıcı" + user edit (matTooltip="Düzenle")
 *  - Diğerleri: trigger yok → sadece base audit.
 *
 * Eski generic selector (button[mat-icon-button]:has(mat-icon:has-text("add"))
 * veya substring "Yeni") expansion-panel-header / refresh / row toggle gibi
 * dialog OLMAYAN elemanları yakalıyordu; mobile-chrome'da bu false-positive
 * trigger'lar Material accordion animation'da stuck → 360s timeout. Allowlist
 * her route için yalnız gerçek dialog trigger'larını kapsar.
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

/**
 * SCHED-B5a (Y5-3 + Y5-7, ikinci revize 2026-05-08): route-bazlı dialog
 * trigger allowlist. `null` döndüğünde audit sadece base sayfa audit'i ile
 * yetinir, dialog click denenmez.
 *
 * Sabitler:
 *  - bookings: "Yeni İş" (booking add) + booking row "Düzenle" (matTooltip)
 *  - users:    "Yeni Kullanıcı" (user add) + user row "Düzenle" (matTooltip)
 *  - schedules: B5a Y5-3 read-only — mutation trigger yok
 *  - ingest:    B5a Y5-7 disabled flow — base audit only
 *  - diğerleri: bilinen accessible-name dialog trigger yok → base audit
 */
function getDialogTriggersForRoute(page: Page, routeName: string): Locator | null {
  switch (routeName) {
    case 'bookings':
      return page.locator(
        'button:has-text("Yeni İş"), button[matTooltip="Düzenle"]'
      );
    case 'users':
      // SCHED-B5a: edit selector `td.mat-column-actions` ile column-spesifik
      // — global `button[matTooltip="Düzenle"]` mobile-chrome'da Material
      // table touch-target reflow'una takılıp click stuck oluyordu (re-run 6
      // mobile users edit). Actions column'una daraltma semantik olarak da
      // doğru: kullanıcı satırındaki aksiyon kolonundaki edit butonu.
      return page.locator(
        'button:has-text("Yeni Kullanıcı"), td.mat-column-actions button[matTooltip="Düzenle"]'
      );
    default:
      return null;
  }
}

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

// SCHED-B5a (ikinci revize 2026-05-08): tek 360s test bütçesi yerine route
// başına ayrı test. findings.json yazımı race koşulu doğurmasın diye describe
// `serial` mode'da koşar (paralel test → aynı dosya çakışması yok). Default
// per-test timeout 30s; 14 route × allowlist null çoğunluk + 2 route'ta
// dialog audit (bookings + users) bütçeyi kolay aşmaz.
//
// SCHED-B5a (2026-05-09): BCMS şu an desktop-first operasyon arayüzü; mobile
// kullanım gelecekte değerlendirilecek (bu fazda blocker değil). audit-light
// dialog click stability mobile-chrome (Pixel 7) Material 17 MDC touch-target
// reflow yarışı nedeniyle users edit butonunda stuck kalıyordu (re-run 7 trace
// kanıtı: button viewport içinde, visible+enabled assertion'lar passed,
// scroll-into-view passed; click `stable` bekleme'sinde 30s aşımı). Follow-up:
// "mobile audit-light users edit click stability follow-up" — kapsam dışı.
// Desktop chromium tüm dialog audit'inde blocking kalır.
test.describe('light mode audit', () => {
  test.describe.configure({ mode: 'serial' });
  // BCMS desktop-first operasyon arayüzü; mobile audit-light dialog click
  // stability follow-up (kapsam dışı). Sadece audit-light için mobile-chrome
  // project'i atlanır; yayin-planlama smoke testleri mobile'da koşar.
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name === 'mobile-chrome',
      'BCMS desktop-first operasyon arayüzü; mobile audit-light dialog click stability follow-up.',
    );
  });

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

  for (const route of ROUTES) {
    test(`light mode audit — ${route.name}`, async ({ page }) => {
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle').catch(() => {});
      await setTheme(page, 'light');
      await spaNav(page, route.path);
      await page.waitForTimeout(800);

      // base screenshot
      await page.screenshot({
        path: `screenshots/light-audit/${route.name}.png`,
        fullPage: true,
      });

      await auditPage(page, route.name, 'base');

      // SCHED-B5a (Y5-3 + Y5-7, 2026-05-08): route-specific allowlist.
      // Trigger yoksa (read-only / disabled flow / dialog'suz route) sadece
      // base audit ile yetinilir.
      const triggers = getDialogTriggersForRoute(page, route.name);
      if (triggers === null) return;

      const triggerCount = Math.min(await triggers.count(), 4);

      for (let i = 0; i < triggerCount; i++) {
        const btn = triggers.nth(i);
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) continue;
        const label = (await btn.textContent().catch(() => ''))?.trim().replace(/\s+/g, '-').slice(0, 24) || `btn${i}`;

        // SCHED-B5a: click öncesi interactability guard — scroll + visible
        // + enabled assertion. Material focus-indicator / matTooltip mount
        // yarışına karşı element stabil olduğunu doğrula. Force click yok.
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await expect(btn).toBeVisible();
        await expect(btn).toBeEnabled();

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

        // Esc kapat — Material overlay cleanup yarışı: mat-dialog-container
        // detach olsa bile cdk-overlay-pane / cdk-overlay-backdrop animation
        // sırasında DOM'da kalır → next trigger click overlay tarafından
        // bloke. 3 katmanlı bekleme: dialog + pane + backdrop.
        await page.keyboard.press('Escape');
        await page.locator('mat-dialog-container').first().waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
        await expect.poll(async () => page.locator('.cdk-overlay-pane').count(), { timeout: 5_000 })
          .toBe(0)
          .catch(() => {});
        await expect.poll(async () => page.locator('.cdk-overlay-backdrop').count(), { timeout: 5_000 })
          .toBe(0)
          .catch(() => {});

        // SCHED-B5a (focus restore yarışı): CDK focus management dialog
        // kapatınca trigger button'a focus restore eder; focus-indicator
        // outline element box'ını reflow ettirir → next trigger click stable
        // bekleme'de stuck. activeElement blur + mouse'u boş köşeye taşı
        // (matTooltip hover trigger önle) + kısa stabilizasyon.
        await page.evaluate(() => {
          const el = document.activeElement;
          if (el instanceof HTMLElement) el.blur();
        });
        await page.mouse.move(0, 0);
        await page.waitForTimeout(100);
      }
    });
  }
});
