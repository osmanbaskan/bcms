import { test, expect, type Page } from '@playwright/test';

/**
 * Haber (news) sekmesi — çerçeveli kontrol kontrast audit'i.
 *
 * Kullanıcı raporu (2026-06-07): "+ Havuza Haber" ve diğer çerçeveli butonların
 * iç dolgusu (frame içi) çevredeki sayfa bg'siyle aynı → light temada buton
 * kayboluyor. Sebep: kontroller `--bp-bg-0` (#e8e2f6) kullanıyordu, konteyner
 * `--bp-bg-1` (#eee9f8) ile neredeyse aynı lavanta (ΔRGB≈15). Fix: kontroller
 * `--bp-bg-2` (light beyaz) → ΔRGB≈46.
 *
 * Bu test light temada bp-news-shell içindeki TÜM çerçeveli (border'lı)
 * button/input/select/textarea elemanlarının iç-dolgu rengini, climb ile
 * bulunan konteyner bg'siyle karşılaştırır; ΔRGB(sum) < 18 ise "blend" sayar
 * ve sıfır blend olmasını şart koşar.
 */

async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((t) => {
    localStorage.setItem('bp.theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.waitForTimeout(150);
}

interface ControlReport {
  sel: string;
  label: string;
  own: string;
  container: string;
  dist: number;
  blend: boolean;
}

test.describe('Haber sekmesi — çerçeveli buton bg audit', () => {
  test.beforeEach(({}, info) =>
    test.skip(info.project.name === 'mobile-chrome', 'BCMS desktop-first operasyon arayüzü.'),
  );

  test('light: çerçeveli kontrollerin iç bg\'si konteyner bg\'sinden farklı', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await setTheme(page, 'light');

    // SPA-nav → /news (sol menü linki; yoksa pushState)
    const link = page.locator('.side a[href="/news"]').first();
    if (await link.count()) await link.click();
    else await page.evaluate(() => { history.pushState({}, '', '/news'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForURL((u) => u.toString().includes('/news'), { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(900);

    // Gizli formları aç: "Yeni Bülten" inline form + Ajans "Manuel ekle" form
    await page.locator('.btn-new').first().click().catch(() => {});
    await page.locator('.wh-tools .t').nth(1).click().catch(() => {}); // add (refresh=0, add=1)
    await page.waitForTimeout(400);

    const report: ControlReport[] = await page.evaluate(() => {
      type RGBA = { r: number; g: number; b: number; a: number };
      function parse(c: string): RGBA | null {
        const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (!m) return null;
        return { r: +m[1], g: +m[2], b: +m[3], a: m[4] != null ? parseFloat(m[4]) : 1 };
      }
      function effContainerBg(el: Element): string {
        let cur: Element | null = el.parentElement;
        while (cur) {
          const c = getComputedStyle(cur).backgroundColor;
          const p = parse(c);
          if (p && p.a > 0.05) return c;
          cur = cur.parentElement;
        }
        return 'rgb(255, 255, 255)';
      }
      function compositeOver(top: RGBA, under: RGBA): RGBA {
        const a = top.a;
        return {
          r: Math.round(top.r * a + under.r * (1 - a)),
          g: Math.round(top.g * a + under.g * (1 - a)),
          b: Math.round(top.b * a + under.b * (1 - a)),
          a: 1,
        };
      }
      function dist(a: RGBA, b: RGBA): number {
        return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
      }

      const root = document.querySelector('bp-news-shell');
      const out: ControlReport[] = [];
      if (!root) return out;

      root.querySelectorAll('button, input, select, textarea').forEach((el) => {
        const cs = getComputedStyle(el);
        const bw = parseFloat(cs.borderTopWidth) || 0;
        const framed = bw > 0 && cs.borderTopStyle !== 'none';
        if (!framed) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4 || cs.visibility !== 'visible' || cs.display === 'none') return;

        const ownRaw = cs.backgroundColor;
        const own = parse(ownRaw) ?? { r: 0, g: 0, b: 0, a: 0 };
        const contRaw = effContainerBg(el);
        const cont = parse(contRaw) ?? { r: 255, g: 255, b: 255, a: 1 };
        // Yarı-saydam dolgu konteyner üstüne composite edilir → gerçek görünen iç renk
        const inner = own.a >= 1 ? { ...own, a: 1 } : compositeOver(own, cont);
        const d = dist(inner, { ...cont, a: 1 });

        const label = ((el as HTMLElement).innerText || el.getAttribute('placeholder') || (el as HTMLInputElement).type || '').trim().replace(/\s+/g, ' ').slice(0, 22);
        const cls = (el.getAttribute('class') || '').split(' ').filter(Boolean).slice(0, 2).join('.');
        out.push({ sel: `${el.tagName.toLowerCase()}.${cls}`, label, own: ownRaw, container: contRaw, dist: d, blend: d < 18 });
      });
      return out;
    });

    console.log('\n=== Haber sekmesi — çerçeveli kontroller (light tema) ===');
    for (const r of report) {
      console.log(`${r.blend ? '❌ BLEND' : '✅ ok   '}  ΔRGB=${String(r.dist).padStart(3)}  ${r.sel.padEnd(22)} "${r.label}"  iç=${r.own}  kap=${r.container}`);
    }
    const blends = report.filter((r) => r.blend);
    console.log(`\nToplam ${report.length} çerçeveli kontrol · ${blends.length} blend (iç≈kap).`);

    expect(report.length, 'En az birkaç çerçeveli kontrol bulunmalı').toBeGreaterThan(4);
    expect(
      blends,
      `İç dolgusu konteyner bg'siyle aynı (blend) kontroller: ${blends.map((b) => `${b.sel} "${b.label}"`).join(' | ')}`,
    ).toHaveLength(0);
  });
});
