/**
 * Asrun sekmesi — kolon sırası + kutu (genişlik) kontrolü (2026-05-29).
 *
 * Değişiklik: "Süre" kolonu en sona (Başlık'tan sonra) taşındı.
 * Beklenen başlık sırası: # | Başlangıç | Kategori | DC Kod | Başlık | Süre
 *
 * Kontroller:
 *  1. Başlık satırı sırası doğru; son kolon `col-dur` ("Süre").
 *  2. Süre `col-dur` hücresi taşmıyor (scrollWidth ≤ clientWidth) — timecode kırpılmamalı.
 *  3. Regresyon: col-seq / col-time / col-dc da taşmamalı.
 *
 * table-layout:fixed olduğu için genişlikler class-bazlı; DOM sırası değişse de
 * sabit kolon genişlikleri korunmalı, Başlık (esnek) kalan alanı almalı.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Veri olan deterministik gün (DB: asrun_items 2026-05-28 tüm kanallarda dolu).
const DATA_DATE = '2026-05-28';
const EXPECTED_HEADERS = ['#', 'Başlangıç', 'Kategori', 'DC Kod', 'Başlık', 'Süre'];

const SCREEN_DIR = path.join(__dirname, 'screenshots', 'asrun-column-widths');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

test('asrun kolon sırası + col-dur/genişlik taşma kontrolü', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/asrun', { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/asrun$/, { timeout: 15_000 }).catch(() => undefined);

  // Deterministik gün seç (veri garantili). Default "dün"; testin koştuğu güne
  // bağımlı kalmamak için tarihi açıkça set ediyoruz.
  const dateInput = page.locator('input[type="date"]').first();
  await dateInput.fill(DATA_DATE);
  await dateInput.dispatchEvent('change');

  // Aktif kanal tabının tablosu render olana kadar bekle (veri varsa tablo gelir).
  await page.waitForSelector('table.asrun-list tbody tr', { timeout: 20_000 });
  await page.waitForTimeout(500); // layout settle (table-layout:fixed reflow)

  // ── 1. Başlık sırası ──────────────────────────────────────────────────────
  const headers = (await page.locator('table.asrun-list thead th').allTextContents())
    .map((t) => t.trim());
  console.log(`[asrun] başlık sırası = ${JSON.stringify(headers)}`);
  expect(headers, 'başlık sırası bekleneni karşılamalı (Süre en sonda)').toEqual(EXPECTED_HEADERS);

  const lastTh = page.locator('table.asrun-list thead th').last();
  await expect(lastTh, 'son başlık "Süre" olmalı').toHaveText('Süre');
  await expect(lastTh, 'son başlık col-dur class taşımalı').toHaveClass(/col-dur/);

  // ── 2 + 3. Hücre genişlikleri / taşma ölçümü ───────────────────────────────
  const result = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table.asrun-list tbody tr'));
    const measure = (c: HTMLElement | null) =>
      c
        ? {
            client: c.clientWidth,
            scroll: c.scrollWidth,
            overflow: c.scrollWidth > c.clientWidth + 1,
            text: (c.textContent ?? '').trim(),
          }
        : null;
    const rowData = rows.map((tr, idx) => {
      const lastCell = tr.lastElementChild as HTMLElement | null;
      return {
        idx,
        lastCellClass: lastCell?.className ?? '',
        seq: measure(tr.querySelector('td.col-seq')),
        time: measure(tr.querySelector('td.col-time')),
        dc: measure(tr.querySelector('td.col-dc')),
        dur: measure(tr.querySelector('td.col-dur')),
      };
    });
    // İlk satırdan kolon genişlik özeti (px).
    const first = rows[0];
    const widthOf = (sel: string) =>
      (first?.querySelector(sel) as HTMLElement | null)?.clientWidth ?? 0;
    return {
      rowData,
      widths: {
        seq: widthOf('td.col-seq'),
        time: widthOf('td.col-time'),
        cat: widthOf('td.col-cat'),
        dc: widthOf('td.col-dc'),
        title: widthOf('td.col-title'),
        dur: widthOf('td.col-dur'),
      },
    };
  });

  console.log(`[asrun] satır sayısı = ${result.rowData.length}`);
  console.log(`[asrun] kolon genişlikleri (px) = ${JSON.stringify(result.widths)}`);
  for (const r of result.rowData.slice(0, 8)) {
    console.log(
      `  row ${r.idx}: dur="${r.dur?.text}" client=${r.dur?.client} scroll=${r.dur?.scroll} overflow=${r.dur?.overflow}  son hücre=${r.lastCellClass}`,
    );
  }

  await page.screenshot({ path: path.join(SCREEN_DIR, 'desktop-1440.png'), fullPage: false });

  // Süre her satırda gerçekten son hücre olmalı (DOM sırası).
  const lastCellAlwaysDur = result.rowData.every((r) => /col-dur/.test(r.lastCellClass));
  expect(lastCellAlwaysDur, 'her satırda son <td> col-dur olmalı (Süre en sonda)').toBe(true);

  // Taşma kontrolleri (hard assertion).
  const durOverflow = result.rowData.some((r) => r.dur?.overflow);
  const timeOverflow = result.rowData.some((r) => r.time?.overflow);
  const dcOverflow = result.rowData.some((r) => r.dc?.overflow);
  const seqOverflow = result.rowData.some((r) => r.seq?.overflow);

  expect(durOverflow, 'col-dur (Süre) taşmamalı — timecode kırpılıyor').toBe(false);
  expect(timeOverflow, 'col-time (Başlangıç) taşmamalı').toBe(false);
  expect(dcOverflow, 'col-dc (DC Kod) taşmamalı').toBe(false);
  expect(seqOverflow, 'col-seq (#) taşmamalı').toBe(false);
});
