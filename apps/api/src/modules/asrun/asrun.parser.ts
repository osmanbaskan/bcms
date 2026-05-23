import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { classifyCategory } from '../provys/provys.classifier.js';
import { composeIstanbulInstant } from '../../core/tz.js';
import type { ParsedItem } from '../provys/provys.parser.js';

/**
 * Asrun (as-run playout log) BXF parser — Provys playlist parser'ından
 * tamamen ayrı. Asrun BXF schema'sı `<Schedule ext:usage="AsRun">` altında
 * `<AsRun><BasicAsRun>` event'leri taşır; Provys'in `<ScheduledEvent>
 * <EventData>` yapısıyla uyumsuz.
 *
 * Çıktı tipi paylaşılır: `ParsedItem` (Provys ile aynı kontrat), böylece
 * service tarafında DB upsert/diff pattern aynen kullanılır.
 *
 * Eksik veya bozuk alanlarda event SKIP edilir; tüm dosya fail edilmez —
 * "fail-soft" davranış (Provys parser da aynı pattern).
 */

export class AsrunParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AsrunParseError';
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SMPTE_TIMECODE_RE = /^\d{1,3}:\d{1,2}:\d{1,2}:\d{1,3}$/;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** SMPTE timecode `HH:MM:SS:FF` + frameRate → toplam ms. */
function smpteTimecodeToMs(timecode: string | undefined, frameRate: number | undefined): number | null {
  if (!timecode) return null;
  const m = String(timecode).trim().match(/^(\d{1,3}):(\d{1,2}):(\d{1,2}):(\d{1,3})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const frames = Number(m[4]);
  if (min >= 60 || sec >= 60) return null;
  const fr = frameRate && frameRate > 0 ? frameRate : 25;
  const ms = (h * 3600 + min * 60 + sec) * 1000 + Math.round((frames / fr) * 1000);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** SmpteTimeCode "HH:MM:SS:FF" → "HH:MM:SS" (Europe/Istanbul helper uyumlu). */
function smpteToWallClock(timecode: string | undefined): string | null {
  if (!timecode) return null;
  const m = String(timecode).trim().match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})(?::\d+)?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (h >= 24 || min >= 60 || sec >= 60) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

interface StartFields {
  instant: Date | null;
  timecode: string | null;
  frameRate: number | null;
  broadcastDate: string | null;
}

function readSmpteDateTime(node: unknown): StartFields {
  if (!node || typeof node !== 'object') {
    return { instant: null, timecode: null, frameRate: null, broadcastDate: null };
  }
  const smpte = (node as Record<string, unknown>)['SmpteDateTime'] as Record<string, unknown> | undefined;
  if (!smpte) return { instant: null, timecode: null, frameRate: null, broadcastDate: null };
  const rawBroadcastDate = String(smpte['@_broadcastDate'] ?? '').trim();
  const broadcastDate = ISO_DATE_RE.test(rawBroadcastDate) ? rawBroadcastDate : null;
  const rawTc = String(smpte['SmpteTimeCode'] ?? '').trim();
  const timecode = SMPTE_TIMECODE_RE.test(rawTc) ? rawTc : null;
  const wall = smpteToWallClock(rawTc);
  const frAttr = Number(smpte['@_frameRate']);
  const frameRate = Number.isFinite(frAttr) && frAttr > 0 ? frAttr : null;
  if (!broadcastDate || !wall) return { instant: null, timecode, frameRate, broadcastDate };
  try {
    const dt = composeIstanbulInstant(broadcastDate, wall);
    return {
      instant: Number.isNaN(dt.getTime()) ? null : dt,
      timecode, frameRate, broadcastDate,
    };
  } catch {
    return { instant: null, timecode, frameRate, broadcastDate };
  }
}

function readSmpteDuration(node: unknown): { ms: number | null; timecode: string | null; frameRate: number | null } {
  if (!node || typeof node !== 'object') return { ms: null, timecode: null, frameRate: null };
  const dur = (node as Record<string, unknown>)['SmpteDuration'] as Record<string, unknown> | undefined;
  if (!dur) return { ms: null, timecode: null, frameRate: null };
  const rawTc = String(dur['SmpteTimeCode'] ?? '').trim();
  const timecode = SMPTE_TIMECODE_RE.test(rawTc) ? rawTc : null;
  const frAttr = Number(dur['@_frameRate']);
  const frameRate = Number.isFinite(frAttr) && frAttr > 0 ? frAttr : null;
  const ms = smpteTimecodeToMs(rawTc || undefined, frameRate ?? undefined);
  return { ms, timecode, frameRate };
}

function pickEventId(asRun: Record<string, unknown>, fallback: string): string {
  const inner = asRun['AsRunEventId'] as Record<string, unknown> | undefined;
  const nested = inner?.['EventId'];
  if (typeof nested === 'string' && nested.trim()) return nested.trim();
  // Bazı exporter'lar EventId'yi nested olarak da sarmalayabilir
  if (nested && typeof nested === 'object') {
    const sub = (nested as Record<string, unknown>)['EventId'];
    if (typeof sub === 'string' && sub.trim()) return sub.trim();
  }
  return fallback;
}

function pickTitle(content: Record<string, unknown> | undefined, dcCode: string | null): string {
  if (content) {
    const name = content['Name'];
    if (typeof name === 'string' && name.trim()) return name.trim();
    const desc = content['Description'];
    if (typeof desc === 'string' && desc.trim()) return desc.trim();
  }
  if (dcCode) return dcCode;
  return 'Untitled';
}

function pickDcCode(content: Record<string, unknown> | undefined): string | null {
  if (!content) return null;
  const cid = content['ContentId'] as Record<string, unknown> | undefined;
  const house = cid?.['HouseNumber'];
  if (typeof house === 'string' && /^DC[0-9A-Za-z]+$/.test(house.trim())) return house.trim();
  return null;
}

export interface ParseAsrunOptions {
  /** Filename'den çıkarılan tarih — event broadcastDate'i yoksa fallback. */
  fallbackDate?: string;
}

/**
 * Asrun BXF dosyasını parse eder. Çıktı `ParsedItem[]` (Provys ile aynı
 * shape, service'in upsert pattern'i değişmeden çalışsın).
 */
export function parseAsrunBxf(content: string, opts: ParseAsrunOptions = {}): ParsedItem[] {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return [];

  const validation = XMLValidator.validate(trimmed);
  if (validation !== true) {
    throw new AsrunParseError(`Malformed BXF XML: ${validation.err?.msg ?? 'unknown'}`);
  }

  let root: unknown;
  try {
    root = xmlParser.parse(trimmed);
  } catch (err) {
    throw new AsrunParseError('XML parse failed', err);
  }

  const bxf = (root as Record<string, unknown>)['BxfMessage'] as Record<string, unknown> | undefined;
  const bxfData = bxf?.['BxfData'] as Record<string, unknown> | undefined;
  const schedule = bxfData?.['Schedule'] as Record<string, unknown> | undefined;
  if (!schedule) return [];

  const asRuns = toArray(schedule['AsRun'] as Record<string, unknown> | Record<string, unknown>[] | undefined);
  if (asRuns.length === 0) return [];

  const items: ParsedItem[] = [];
  let sequence = 0;

  for (const asRun of asRuns) {
    const basic = asRun['BasicAsRun'] as Record<string, unknown> | undefined;
    if (!basic) continue;

    const content = basic['Content'] as Record<string, unknown> | undefined;
    const detail = basic['AsRunDetail'] as Record<string, unknown> | undefined;
    if (!detail) continue;

    const start = readSmpteDateTime(detail['StartDateTime']);
    const dur = readSmpteDuration(detail['Duration']);
    const broadcastDate = start.broadcastDate ?? opts.fallbackDate ?? null;
    if (!broadcastDate) continue;

    // instant: SmpteDateTime ile çözüldüyse onu kullan; yoksa fallback +
    // wall-clock ile yeniden dene.
    let instant: Date | null = start.instant;
    if (!instant && broadcastDate && start.timecode) {
      const wall = smpteToWallClock(start.timecode);
      if (wall) {
        try {
          const dt = composeIstanbulInstant(broadcastDate, wall);
          if (!Number.isNaN(dt.getTime())) instant = dt;
        } catch {
          /* skip */
        }
      }
    }
    if (!instant) continue;

    const dcCode = pickDcCode(content);
    const title = pickTitle(content, dcCode);
    const rawType = detail['Type'];
    const rawKind = typeof rawType === 'string' && rawType.trim() ? rawType.trim() : null;
    // Asrun "Primary" = main programme content; Provys classifier "primary"
    // pattern'ini taşımıyor (oradaki eventType "Program"). Mapping ile
    // Primary → PROGRAM, Secondary → DIGER, diğer (Promo/Commercial/PSA/Live)
    // ham değerle classifier'a verilir.
    const classifierInput = rawKind && /^primary$/i.test(rawKind) ? 'Program' : rawKind;
    const category = classifyCategory(classifierInput ?? undefined);

    const startTimecode = start.timecode;
    const frameRate = start.frameRate ?? dur.frameRate ?? null;
    const fallbackEventId = `${broadcastDate}-${startTimecode ?? 'NA'}-${sequence}`;
    const eventId = pickEventId(basic, fallbackEventId);

    items.push({
      eventId,
      scheduleDate: broadcastDate,
      sequence,
      startAt: instant,
      durationMs: dur.ms,
      startTimecode,
      durationTimecode: dur.timecode,
      frameRate,
      dcCode,
      title,
      rawKind,
      category,
    });
    sequence += 1;
  }

  return items;
}
