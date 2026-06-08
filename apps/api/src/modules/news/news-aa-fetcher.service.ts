import { Buffer } from 'node:buffer';
import type { FastifyInstance } from 'fastify';
import { parseNewsMlG2 } from './newsml-g2.parser.js';
import { getEffectiveAaConfig, type AaEffectiveConfig } from './news-settings.js';

/**
 * news-aa-fetcher — worker background servisi (2026-06-05).
 *
 * AA (Anadolu Ajansı) Media API'sinden DOĞRUDAN haber çeker (IOSTEK baypas).
 *   POST /abone/search/  (filter_type=1 metin, filter_language=1 TR)  → id listesi
 *   GET  /abone/document/{id}/newsml29  → NewsML-G2 → parse → NewsWireItem (source=AA)
 * Dedup: (source, externalId) unique. Self-heal: gövdesiz item sonraki poll'de doldurulur.
 *
 * Konfig **DB + env merge** (Ayarlar > Haber → news_settings tablosu) — her tick'te
 * okunur, **restart gerekmez**. Boş alan env'e (AA_API_*) düşer. enabled=false ya da
 * kullanıcı/şifre yoksa çekim atlanır. Poll aralığı (pollSec) DB'den dinamik.
 */

const FETCH_TIMEOUT_MS = 15_000;
const BASE_TICK_MS = 60_000; // sabit taban; gerçek çekim cfg.pollSec'e göre "due" olunca
// AA rate-limit (429) önleme: tick başına en çok N doküman + GET'ler arası gecikme.
// Kalan gövdesiz haberler sonraki tick'lerde self-heal ile dolar.
const MAX_DOCS_PER_TICK = 10;
const DOC_DELAY_MS = 500;
// Item başına gövde-çekme deneme sayacı (process-içi). 5 başarısız denemeden
// sonra o belgeden vazgeçilir (kronik 429 log'u kirletmesin). Worker restart'ında
// sıfırlanır → AA geçici 429 verdiyse belge sonradan yeniden denenir.
const MAX_BODY_ATTEMPTS = 5;
const bodyFailCounts = new Map<string, number>();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function authHeader(c: AaEffectiveConfig): string {
  return 'Basic ' + Buffer.from(`${c.user}:${c.pass}`).toString('base64');
}

interface SearchItem { id: string; type?: string; date?: string; title?: string; }

async function aaSearch(c: AaEffectiveConfig): Promise<SearchItem[]> {
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

async function aaDocument(c: AaEffectiveConfig, id: string): Promise<string> {
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

async function runFetch(app: FastifyInstance, c: AaEffectiveConfig): Promise<void> {
  const items = await aaSearch(c);
  let added = 0;
  let docFetches = 0;
  for (const it of items) {
    if (!it.id) continue;

    const existing = await app.prisma.newsWireItem.findUnique({
      where: { source_externalId: { source: 'AA', externalId: it.id } },
      select: { id: true, body: true },
    });
    if (existing?.body) continue; // tam → atla; gövdesiz/yeni → (yeniden) çek = self-heal
    if ((bodyFailCounts.get(it.id) ?? 0) >= MAX_BODY_ATTEMPTS) continue; // 5 deneme doldu → vazgeç

    let parsed: ReturnType<typeof parseNewsMlG2>[number] | undefined;
    // Doküman çekme: tick başına en çok MAX_DOCS_PER_TICK; GET'ler arası DOC_DELAY_MS
    // gecikme → AA rate-limit (429) önlenir. Cap aşılırsa bu tur sadece metadata;
    // gövdesiz satır sonraki tick'te yeniden denenir (self-heal).
    if (docFetches < MAX_DOCS_PER_TICK) {
      try {
        if (docFetches > 0) await sleep(DOC_DELAY_MS);
        parsed = parseNewsMlG2(await aaDocument(c, it.id))[0];
        bodyFailCounts.delete(it.id); // başarı → sayaç sıfırla
      } catch (err) {
        const n = (bodyFailCounts.get(it.id) ?? 0) + 1;
        bodyFailCounts.set(it.id, n);
        app.log.warn(
          { err, id: it.id, attempt: n, max: MAX_BODY_ATTEMPTS },
          n >= MAX_BODY_ATTEMPTS
            ? 'news-aa-fetcher: doküman alınamadı — 5 deneme doldu, bu belgeden vazgeçildi'
            : 'news-aa-fetcher: doküman alınamadı (metadata ile devam)',
        );
      }
      docFetches += 1;
    }

    if (existing) {
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
}

export function startNewsAaFetcher(app: FastifyInstance): void {
  let stopping = false;
  let running = false;
  let lastFetchAt = 0;

  const tick = async (): Promise<void> => {
    if (stopping || running) return;
    running = true;
    try {
      const { cfg } = await getEffectiveAaConfig(app.prisma);
      if (!cfg.enabled || !cfg.user || !cfg.pass) return; // kapalı / kimliksiz → atla
      if (Date.now() - lastFetchAt < cfg.pollSec * 1_000) return; // henüz vakti gelmedi
      lastFetchAt = Date.now();
      await runFetch(app, cfg);
    } catch (err) {
      app.log.warn({ err }, 'news-aa-fetcher tick hatası');
    } finally {
      running = false;
    }
  };

  const kickoff = setTimeout(() => { tick().catch(() => {}); }, 12_000);
  kickoff.unref?.();
  const timer = setInterval(() => {
    tick().catch((err) => app.log.error({ err }, 'news-aa-fetcher tick hatası'));
  }, BASE_TICK_MS);
  timer.unref?.();

  app.addHook('onClose', async () => {
    stopping = true;
    clearTimeout(kickoff);
    clearInterval(timer);
  });

  app.log.info('news-aa-fetcher başladı (konfig DB+env, her tick okunur)');
}
