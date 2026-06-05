import { XMLParser } from 'fast-xml-parser';

/**
 * NewsML-G2 (IPTC 2.9) ayrıştırıcı — 2026-06-05.
 *
 * AA (Anadolu Ajansı, /abone/document/{id}/newsml29) ve AP (APTN NewsML-G2)
 * **ortak** kullanır; ikisi de aynı standart. Çıktı NewsWireItem'a map edilir.
 *
 * AA özellikleri:
 *  - newsItem@guid                              → externalId  (aa:text:YYYYMMDD:NNN)
 *  - contentMeta/headline | nitf hl1            → headline
 *  - contentMeta/subject[@qcode^="AAcat:"]/name → category (tr ad, ör. "Spor")
 *  - nitf/body/body.content                     → body (HTML-escaped <p> blokları)
 *  - itemMeta/versionCreated | sent             → receivedAt
 *  - byline/byttl                               → byline
 */

export interface ParsedNewsItem {
  externalId: string;
  headline: string;
  body: string | null;
  category: string | null;
  priority: 'FLASH' | 'NORMAL';
  receivedAt: Date;
  byline: string | null;
}

// Türkçe İ/I sorunu: JS `/i` flag'i "SON DAKİKA"daki İ'yi 'i'ye katlamaz.
// Bu yüzden eşleşme öncesi tr-TR locale ile küçültüyoruz (İ→i, Ş→ş).
const FLASH_RE = /son dakika|flaş|flas|breaking/;
function isFlashHeadline(headline: string): boolean {
  return FLASH_RE.test(headline.toLocaleLowerCase('tr-TR'));
}

const parser = new XMLParser({ ignoreAttributes: false, processEntities: true, trimValues: true });

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#text' in o) return String(o['#text'] ?? '').trim();
  }
  return '';
}

/** Çok-dilli <name> listesinden Türkçe olanı (yoksa ilkini) seç. */
function localizedName(subject: Record<string, unknown>): string {
  const names = asArray(subject?.name as unknown);
  for (const n of names) {
    if (typeof n === 'object' && n && (n as Record<string, unknown>)['@_xml:lang'] === 'tr') {
      return textOf(n);
    }
  }
  return names.length ? textOf(names[0]) : '';
}

const NAMED: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>' };
function unescapeHtml(s: string): string {
  return s
    .replace(/&(quot|apos|amp|lt|gt);/g, (m) => NAMED[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => safeCp(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => safeCp(parseInt(n, 16)));
}
function safeCp(n: number): string {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

/** nitf body.content (escaped <p> blokları) → düz metin (paragraflar \n\n). */
function htmlToText(s: string): string {
  const stripped = s
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return unescapeHtml(stripped).replace(/\n{3,}/g, '\n\n').trim();
}

export function parseNewsMlG2(xml: string): ParsedNewsItem[] {
  const doc = parser.parse(xml) as Record<string, any>;
  const root = doc?.newsMessage ?? doc;
  let items = asArray(root?.itemSet?.newsItem);
  if (!items.length) items = asArray(root?.newsItem);
  if (!items.length) items = asArray(root?.packageItem); // güvenlik

  const out: ParsedNewsItem[] = [];
  for (const ni of items) {
    const guid = ni?.['@_guid'] ?? ni?.['@_GUID'] ?? '';
    if (!guid) continue;
    const contentMeta = ni.contentMeta ?? {};
    const itemMeta = ni.itemMeta ?? {};

    let headline = textOf(contentMeta.headline);

    let category: string | null = null;
    for (const s of asArray(contentMeta.subject)) {
      const qc = String((s as Record<string, unknown>)?.['@_qcode'] ?? '');
      if (qc.startsWith('AAcat:')) {
        category = localizedName(s as Record<string, unknown>) || qc.split(':')[1] || null;
        break;
      }
    }

    let body: string | null = null;
    let byline: string | null = null;
    const nitf = ni?.contentSet?.inlineXML?.nitf;
    if (nitf?.body) {
      const head = nitf.body['body.head'];
      if (!headline) headline = textOf(head?.headline?.hl1);
      byline = textOf(head?.byline?.byttl) || null;
      const bc = nitf.body['body.content'];
      if (bc != null) {
        const raw = typeof bc === 'string' ? bc : textOf(bc);
        body = htmlToText(raw) || null;
      }
    }

    const ts = textOf(itemMeta.versionCreated) || textOf(itemMeta.sent) || textOf(contentMeta.contentCreated);
    const receivedAt = ts ? new Date(ts) : new Date();
    const prioNum = parseInt(textOf(itemMeta.priority), 10);
    const flash = isFlashHeadline(headline) || (Number.isFinite(prioNum) && prioNum <= 2);

    out.push({
      externalId: String(guid),
      headline: headline || '(başlıksız)',
      body,
      category,
      priority: flash ? 'FLASH' : 'NORMAL',
      receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
      byline,
    });
  }
  return out;
}
