import { Buffer } from 'node:buffer';
import type { FastifyInstance } from 'fastify';
import { parseNewsMlG2 } from './newsml-g2.parser.js';

/**
 * news-aa-fetcher — worker background servisi (2026-06-05).
 *
 * AA (Anadolu Ajansı) Media API'sinden DOĞRUDAN haber çeker (IOSTEK'ten bağımsız;
 * IOSTEK ürün lisansı ölü → baypas). Akış:
 *   POST /abone/search/  (filter_type=1 metin, filter_language=1 TR)  → id listesi
 *   GET  /abone/document/{id}/newsml29  → NewsML-G2  → parse  → NewsWireItem (source=AA)
 * Dedup: (source, externalId) unique — zaten var olanı atla (cursor'a gerek yok).
 *
 * Config (env): AA_API_USER / AA_API_PASS (Basic auth) yoksa servis kapalı.
 *   AA_API_BASE(=https://api.aa.com.tr) AA_API_POLL_SECONDS(=300)
 *   AA_API_FILTER_TYPE(=1) AA_API_FILTER_LANGUAGE(=1) AA_API_FILTER_CATEGORY
 *   AA_API_SEARCH_LIMIT(=30) AA_API_DOC_FORMAT(=newsml29)
 */

const FETCH_TIMEOUT_MS = 15_000;

interface AaConfig {
  base: string; user: string; pass: string; pollSec: number;
  filterType: string; filterLang: string; filterCategory: string;
  limit: number; docFormat: string;
}

function readConfig(): AaConfig {
  return {
    base: (process.env.AA_API_BASE ?? 'https://api.aa.com.tr').replace(/\/$/, ''),
    user: process.env.AA_API_USER ?? '',
    pass: process.env.AA_API_PASS ?? '',
    pollSec: Math.max(60, parseInt(process.env.AA_API_POLL_SECONDS ?? '300', 10)),
    filterType: process.env.AA_API_FILTER_TYPE ?? '1',
    filterLang: process.env.AA_API_FILTER_LANGUAGE ?? '1',
    filterCategory: process.env.AA_API_FILTER_CATEGORY ?? '',
    limit: Math.min(100, Math.max(1, parseInt(process.env.AA_API_SEARCH_LIMIT ?? '30', 10))),
    docFormat: process.env.AA_API_DOC_FORMAT ?? 'newsml29',
  };
}

function authHeader(c: AaConfig): string {
  return 'Basic ' + Buffer.from(`${c.user}:${c.pass}`).toString('base64');
}

interface SearchItem { id: string; type?: string; date?: string; title?: string; }

async function aaSearch(c: AaConfig): Promise<SearchItem[]> {
  const body = new URLSearchParams();
  body.set('filter_type', c.filterType);
  body.set('filter_language', c.filterLang);
  if (c.filterCategory) body.set('filter_category', c.filterCategory);
  body.set('limit', String(c.limit));

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${c.base}/abone/search/`, {
      method: 'POST',
      headers: {
        Authorization: authHeader(c),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`search HTTP ${res.status}`);
    const json = (await res.json()) as {
      response?: { success?: boolean; message?: string };
      data?: { result?: SearchItem[] };
    };
    if (!json?.response?.success) throw new Error(`search reddedildi: ${json?.response?.message ?? 'bilinmiyor'}`);
    return json.data?.result ?? [];
  } finally {
    clearTimeout(t);
  }
}

async function aaDocument(c: AaConfig, id: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${c.base}/abone/document/${encodeURIComponent(id)}/${c.docFormat}`, {
      headers: { Authorization: authHeader(c) },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`document HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export function startNewsAaFetcher(app: FastifyInstance): void {
  const c = readConfig();
  if (!c.user || !c.pass) {
    app.log.info('news-aa-fetcher: AA_API_USER/PASS tanımsız — AA çekimi kapalı');
    return;
  }

  let stopping = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopping || running) return;
    running = true;
    try {
      const items = await aaSearch(c);
      let added = 0;
      for (const it of items) {
        if (stopping) break;
        if (!it.id) continue;

        const existing = await app.prisma.newsWireItem.findUnique({
          where: { source_externalId: { source: 'AA', externalId: it.id } },
          select: { id: true, body: true },
        });
        // Gövdeli (tam) item → atla. Gövdesiz (önceki doküman çekimi başarısız)
        // VEYA yeni → dokümanı (yeniden) çek = self-heal.
        if (existing?.body) continue;

        let parsed: ReturnType<typeof parseNewsMlG2>[number] | undefined;
        try {
          const xml = await aaDocument(c, it.id);
          parsed = parseNewsMlG2(xml)[0];
        } catch (err) {
          app.log.warn({ err, id: it.id }, 'news-aa-fetcher: doküman alınamadı (metadata ile devam)');
        }

        if (existing) {
          // Gövdesiz mevcut item → parse başarılıysa kategori/gövde doldur (self-heal).
          if (parsed) {
            await app.prisma.newsWireItem.update({
              where: { id: existing.id },
              data: { category: parsed.category, body: parsed.body, priority: parsed.priority },
            });
            added += 1;
          }
        } else {
          await app.prisma.newsWireItem.create({
            data: {
              source: 'AA',
              externalId: it.id,
              category: parsed?.category ?? null,
              priority: parsed?.priority ?? 'NORMAL',
              headline: (parsed?.headline ?? it.title ?? '(başlıksız)').slice(0, 500),
              body: parsed?.body ?? null,
              receivedAt: parsed?.receivedAt ?? (it.date ? new Date(it.date) : new Date()),
            },
          });
          added += 1;
        }
      }
      if (added) app.log.info({ added, scanned: items.length }, 'news-aa-fetcher: yeni AA haberleri eklendi');
    } catch (err) {
      app.log.warn({ err }, 'news-aa-fetcher tick hatası');
    } finally {
      running = false;
    }
  };

  // İlk çekimi boot'u bloklamamak için 12 sn sonraya al.
  const kickoff = setTimeout(() => { tick().catch(() => {}); }, 12_000);
  kickoff.unref?.();
  const timer = setInterval(() => {
    tick().catch((err) => app.log.error({ err }, 'news-aa-fetcher tick hatası'));
  }, c.pollSec * 1_000);
  timer.unref?.();

  app.addHook('onClose', async () => {
    stopping = true;
    clearTimeout(kickoff);
    clearInterval(timer);
  });

  app.log.info({ pollSec: c.pollSec, filterType: c.filterType, lang: c.filterLang, limit: c.limit }, 'news-aa-fetcher başladı');
}
