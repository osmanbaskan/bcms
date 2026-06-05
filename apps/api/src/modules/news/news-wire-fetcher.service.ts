import { XMLParser } from 'fast-xml-parser';
import type { FastifyInstance } from 'fastify';

/**
 * news-wire-fetcher — worker background servisi (2026-06-05).
 *
 * Konfigüre RSS kaynaklarını periyodik çeker, item'ları NewsWireItem olarak
 * upsert eder (dedup: source + externalId). EGS "Ajans Penceresi" beslemesinin
 * v1 karşılığı: canlı ajans API'si yokken RSS somut/çalışan kaynak; manuel
 * giriş de ayrıca mümkün (POST /wires).
 *
 * Config (env):
 *   NEWS_WIRE_RSS_URLS    "AA=https://...,Manşet=https://..." (virgülle; Ad=URL veya düz URL)
 *   NEWS_WIRE_POLL_SECONDS  varsayılan 300
 */

// Türkçe İ/I: tr-TR locale ile küçültüp eşleştir (JS `/i` "DAKİKA"yı çözmez).
const FLASH_PATTERNS = /son dakika|flaş|flas|breaking|acil/;
function isFlash(text: string): boolean {
  return FLASH_PATTERNS.test(text.toLocaleLowerCase('tr-TR'));
}
const FETCH_TIMEOUT_MS = 10_000;
// Bazı ajanslar (ör. Anadolu Ajansı www.aa.com.tr/tr/rss) bot User-Agent'ı
// CDN'de 502 ile reddediyor; tarayıcı UA + Accept ile RSS dönüyor.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_HEADERS = {
  'User-Agent': BROWSER_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'tr-TR,tr;q=0.9',
};

export interface RssSource {
  name: string;
  url: string;
}

export function configuredRssSources(): RssSource[] {
  const raw = process.env.NEWS_WIRE_RSS_URLS ?? '';
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq > 0) return { name: part.slice(0, eq).trim(), url: part.slice(eq + 1).trim() };
      try {
        return { name: new URL(part).hostname.replace(/^www\./, ''), url: part };
      } catch {
        return { name: part, url: part };
      }
    })
    .filter((s) => /^https?:\/\//.test(s.url));
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['#text'] ?? '').trim();
  }
  return String(value).trim();
}

interface ParsedItem {
  externalId: string;
  category: string | null;
  priority: 'FLASH' | 'NORMAL';
  headline: string;
  body: string | null;
  receivedAt: Date;
}

function parseFeed(xml: string): ParsedItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  const doc = parser.parse(xml) as Record<string, any>;

  // RSS 2.0: rss.channel.item[] | Atom: feed.entry[]
  const rssItems = asArray(doc?.rss?.channel?.item);
  const atomItems = asArray(doc?.feed?.entry);
  const raw = rssItems.length ? rssItems : atomItems;

  const out: ParsedItem[] = [];
  for (const it of raw) {
    const headline = textOf(it.title);
    if (!headline) continue;
    const link = textOf(it.link?.['@_href'] ?? it.link);
    const guid = textOf(it.guid) || textOf(it.id) || link || headline;
    const body = textOf(it.description) || textOf(it.summary) || textOf(it.content) || null;
    const category = textOf(asArray(it.category)[0]) || null;
    const dateStr = textOf(it.pubDate) || textOf(it.updated) || textOf(it.published);
    const parsed = dateStr ? new Date(dateStr) : new Date();
    out.push({
      externalId: guid.slice(0, 200),
      category: category ? category.slice(0, 120) : null,
      priority: isFlash(headline) ? 'FLASH' : 'NORMAL',
      headline: headline.slice(0, 500),
      body,
      receivedAt: Number.isNaN(parsed.getTime()) ? new Date() : parsed,
    });
  }
  return out;
}

async function fetchSource(app: FastifyInstance, source: RssSource): Promise<void> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let xml: string;
  try {
    const res = await fetch(source.url, { signal: controller.signal, headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } finally {
    clearTimeout(t);
  }

  const items = parseFeed(xml);
  let upserted = 0;
  for (const it of items) {
    await app.prisma.newsWireItem.upsert({
      where: { source_externalId: { source: source.name, externalId: it.externalId } },
      update: { headline: it.headline, body: it.body, category: it.category, priority: it.priority },
      create: {
        source: source.name,
        externalId: it.externalId,
        category: it.category,
        priority: it.priority,
        headline: it.headline,
        body: it.body,
        receivedAt: it.receivedAt,
      },
    });
    upserted += 1;
  }
  app.log.info({ source: source.name, items: upserted }, 'news-wire-fetcher: kaynak çekildi');
}

export function startNewsWireFetcher(app: FastifyInstance): void {
  const sources = configuredRssSources();
  const intervalSec = parseInt(process.env.NEWS_WIRE_POLL_SECONDS ?? '300', 10);
  if (sources.length === 0) {
    app.log.info('news-wire-fetcher: RSS kaynağı yok (NEWS_WIRE_RSS_URLS boş) — yalnız manuel giriş aktif');
    return;
  }

  let stopping = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopping || running) return;
    running = true;
    try {
      for (const source of sources) {
        if (stopping) break;
        try {
          await fetchSource(app, source);
        } catch (err) {
          app.log.warn({ err, source: source.name }, 'news-wire-fetcher: kaynak çekilemedi');
        }
      }
    } finally {
      running = false;
    }
  };

  // İlk çekimi boot'u bloklamamak için 15 sn sonraya al.
  const kickoff = setTimeout(() => { tick().catch(() => {}); }, 15_000);
  kickoff.unref?.();
  const timer = setInterval(() => {
    tick().catch((err) => app.log.error({ err }, 'news-wire-fetcher tick hatası'));
  }, Math.max(60, intervalSec) * 1_000);
  timer.unref?.();

  app.addHook('onClose', async () => {
    stopping = true;
    clearTimeout(kickoff);
    clearInterval(timer);
  });
}
