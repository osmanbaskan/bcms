import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * 2026-05-15: Kalıcı navigation smoke. Sunum öncesi her büyük route'un
 * sidebar'dan açıldığını, console error veya 500 üretmediğini doğrular.
 *
 * Strateji: `page.goto(route)` direct URL Keycloak login redirect cycle
 * yüzünden ` `/` → `/dashboard` `'a düşüyor (app.config.ts redirectUri).
 * Operatör senaryosu sidebar tıklamasıyla; smoke da bu pattern'i kullanır:
 *   1. `goto('/')` → dashboard'a yerleş.
 *   2. Sidebar link'ine tıkla → `waitForURL(<route>)`.
 *   3. Heading + console/network error kontrol.
 *
 * Sidebar'da OLMAYAN route'lar (örn. /admin/manual-leagues) bu spec
 * dışında — settings card üzerinden smoke-admin-settings.spec.ts kapsar.
 */

interface RouteSpec {
  /** Sidebar link metni (regex). */
  navLabel: RegExp;
  /** Hedef URL pattern. */
  routePattern: RegExp;
  /** Sayfada bulunması beklenen metin/indicator (heading veya butona kadar
   *  geniş). Sayfa render edip etmediğinin marker'ı; spesifik route için. */
  marker: RegExp;
}

const ROUTES: RouteSpec[] = [
  { navLabel: /Genel Bakış/,         routePattern: /\/dashboard/,        marker: /Bugünün|Genel Bakış|Operasyon/i },
  { navLabel: /Canlı Yayın Plan/,    routePattern: /\/schedules$/,       marker: /Yeni Ekle|Yayın|Canlı/i },
  { navLabel: /Yayın Planlama/,      routePattern: /\/yayin-planlama/,   marker: /Yayın Planlama|Excel/i },
  { navLabel: /Stüdyo Planı/,        routePattern: /\/studio-plan/,      marker: /Stüdyo Plan/i },
  { navLabel: /^cloud_uploadIngest$|^Ingest$/, routePattern: /\/ingest/, marker: /Ingest|Kayıt|Planlama/i },
  { navLabel: /İş Takip/,            routePattern: /\/bookings/,         marker: /İş Takip|Booking|Yeni/i },
  { navLabel: /Haftalık Shift/,      routePattern: /\/weekly-shift/,     marker: /Vardiya|Shift|Haftalık/i },
  { navLabel: /Dökümanlar/,          routePattern: /\/documents/,        marker: /Döküman|Yükle|Belge/i },
  { navLabel: /Raporlama/,           routePattern: /\/schedules\/reporting/, marker: /Rapor|Tarih|Toplam/i },
  { navLabel: /Audit Logları/,       routePattern: /\/audit-logs/,       marker: /Audit|Log|Tarih/i },
  { navLabel: /Kanallar/,            routePattern: /\/channels/,         marker: /Kanal|Channel/i },
  { navLabel: /Kullanıcılar/,        routePattern: /\/users/,            marker: /Kullanıcı|User|Grup/i },
  { navLabel: /Ayarlar/,             routePattern: /\/settings/,         marker: /Ayarlar|Sistem|OPTA SMB/i },
  { navLabel: /Live-Plan Lookup/,    routePattern: /\/admin\/live-plan-lookups/, marker: /Lookup|Live-Plan|Tablo/i },
  { navLabel: /OPTA Lig Görünürlüğü/, routePattern: /\/admin\/opta-competitions/, marker: /OPTA Lig|Görünür|Lig/i },
];

interface CollectedErrors {
  consoleErrors: string[];
  pageErrors:    string[];
  serverErrors:  Array<{ url: string; status: number }>;
}

function attachErrorListeners(page: Page): CollectedErrors {
  const collected: CollectedErrors = { consoleErrors: [], pageErrors: [], serverErrors: [] };
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      const txt = msg.text();
      // 4xx genelde auth/preload race veya benign client validation;
      // smoke amacı için yalnız 5xx ve uncaught error kritik. 4xx suppress.
      if (/Failed to load resource.*40[012345]/.test(txt)) return;
      collected.consoleErrors.push(txt);
    }
  });
  page.on('pageerror', (err) => collected.pageErrors.push(err.message));
  page.on('response', (res) => {
    if (res.status() >= 500) collected.serverErrors.push({ url: res.url(), status: res.status() });
  });
  return collected;
}

async function settle(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 }).catch(async () => {
    // Eğer dashboard'a düşmediyse en azından networkidle bekle.
    await page.waitForLoadState('networkidle', { timeout: 10_000 });
  });
}

test.describe('Navigation smoke — sidebar üzerinden tüm büyük route\'lar', () => {
  for (const route of ROUTES) {
    test(`nav → ${route.routePattern.source}`, async ({ page }, testInfo) => {
      const errors = attachErrorListeners(page);
      await settle(page);

      // Sidebar tıklama
      const link = page.locator('aside a').filter({ hasText: route.navLabel }).first();
      await expect(link, `sidebar link missing: ${route.navLabel}`).toBeVisible({ timeout: 5_000 });
      await link.click();

      await page.waitForURL(route.routePattern, { timeout: 10_000 });
      await page.waitForLoadState('networkidle', { timeout: 10_000 });

      // Marker kontrol — sayfa render etti mi (route'a özgü metin).
      // Heading varlığı sayfa-bazlı değişken; marker daha geniş alanda arar.
      const bodyText = await page.locator('main, .page, .page-container, app-root').first().innerText({ timeout: 3_000 }).catch(() => '');
      expect(bodyText, `marker @ ${route.routePattern.source}`).toMatch(route.marker);

      await page.screenshot({
        path: testInfo.outputPath(`smoke-nav-${route.routePattern.source.replace(/[^\w]/g, '_')}.png`),
        fullPage: false,
      });

      if (errors.consoleErrors.length || errors.pageErrors.length || errors.serverErrors.length) {
        await testInfo.attach('error-summary.json', {
          body: JSON.stringify(errors, null, 2),
          contentType: 'application/json',
        });
      }
      expect(errors.pageErrors,   `pageErrors @ ${route.routePattern.source}`).toEqual([]);
      expect(errors.serverErrors, `serverErrors @ ${route.routePattern.source}`).toEqual([]);
      expect(errors.consoleErrors, `consoleErrors @ ${route.routePattern.source}`).toEqual([]);
    });
  }
});
