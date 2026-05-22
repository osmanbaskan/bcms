import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { classifyCategory } from './provys.classifier.js';
import { PROVYS_CATEGORIES, type ProvysCategory } from '@bcms/shared';

/**
 * Provys / SMPTE-2021 BXF playlist parser — saf fonksiyon.
 *
 * BXF dosyası kaba yapı:
 *   <BxfMessage>
 *     <BxfData>
 *       <ScheduleElements>
 *         <ScheduleElement>
 *           <EventData EventId="..." StartDateTime="..." Duration="PT...S">
 *             <EventType>COMMERCIAL</EventType>
 *             <Title>Reklam Spotu</Title>
 *           </EventData>
 *         </ScheduleElement>
 *         ...
 *
 * Sözleşme defansif:
 *   - Eksik alan → ParsedItem'da `null` veya boş.
 *   - Malformed XML → ParserError fırlatır.
 *   - Boş playlist → boş array (hata değil).
 *   - Çıktı Zod ile validate edilir (ProvysParseOutputSchema).
 */

export class ProvysParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ProvysParseError';
  }
}

export interface ParsedItem {
  eventId: string;
  sequence: number;
  startAt: Date;
  durationMs: number | null;
  title: string;
  rawKind: string | null;
  category: ProvysCategory;
}

const ParsedItemSchema = z.object({
  eventId: z.string().min(1).max(120),
  sequence: z.number().int().min(0),
  startAt: z.date(),
  durationMs: z.number().int().nonnegative().nullable(),
  title: z.string().min(1).max(500),
  rawKind: z.string().max(100).nullable(),
  category: z.enum(PROVYS_CATEGORIES),
});

export const ProvysParseOutputSchema = z.array(ParsedItemSchema);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  trimValues: true,
});

/** ISO-8601 duration `PT...S` veya `HH:MM:SS` → ms. Null-safe. */
function parseDurationToMs(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // ISO-8601: PT1H30M15.5S
  const iso = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso) {
    const h = Number(iso[1] ?? 0);
    const m = Number(iso[2] ?? 0);
    const sec = Number(iso[3] ?? 0);
    const ms = Math.round((h * 3600 + m * 60 + sec) * 1000);
    return Number.isFinite(ms) ? ms : null;
  }

  // HH:MM:SS[.ff]
  const hms = s.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (hms) {
    const h = Number(hms[1]);
    const m = Number(hms[2]);
    const sec = Number(hms[3]);
    if (m >= 60 || sec >= 60) return null;
    const ms = Math.round((h * 3600 + m * 60 + sec) * 1000);
    return Number.isFinite(ms) ? ms : null;
  }

  // Plain seconds
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
  return null;
}

function parseStartAt(raw: unknown): Date | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Pure parser. Throws `ProvysParseError` on malformed XML.
 * Eksik/geçersiz kalemler atlanır (debug ile loglanır — caller log enjekte edebilir).
 *
 * @param content BXF XML içeriği (UTF-8 string)
 */
export function parseBxf(content: string): ParsedItem[] {
  if (typeof content !== 'string' || content.trim() === '') {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(content);
  } catch (err) {
    throw new ProvysParseError('BXF XML parse hatası', err);
  }

  const items: ParsedItem[] = [];
  const root = parsed as Record<string, unknown>;
  // Tolerant root walk: <BxfMessage> > <BxfData> > <ScheduleElements> > <ScheduleElement>[]
  const bxfMessage = (root?.['BxfMessage'] ?? root) as Record<string, unknown> | undefined;
  const bxfData = bxfMessage?.['BxfData'] as Record<string, unknown> | undefined;
  const scheduleElements = bxfData?.['ScheduleElements'] as Record<string, unknown> | undefined;
  const elements = toArray(scheduleElements?.['ScheduleElement']);

  let seq = 0;
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const eventData = (el as Record<string, unknown>)['EventData'] as Record<string, unknown> | undefined;
    if (!eventData) continue;

    const eventId = String(
      eventData['@_EventId'] ?? eventData['EventId'] ?? '',
    ).trim();
    const startAt = parseStartAt(eventData['@_StartDateTime'] ?? eventData['StartDateTime']);
    const title = String(eventData['Title'] ?? eventData['@_Title'] ?? '').trim();
    const rawKindValue = eventData['EventType'] ?? eventData['ContentClass'] ?? eventData['@_EventType'];
    const rawKind = rawKindValue == null ? null : String(rawKindValue).trim() || null;
    const durationMs = parseDurationToMs(eventData['@_Duration'] ?? eventData['Duration']);

    if (!eventId || !startAt || !title) {
      // Eksik zorunlu alan → atla.
      continue;
    }

    items.push({
      eventId,
      sequence: seq++,
      startAt,
      durationMs,
      title: title.length > 500 ? title.slice(0, 500) : title,
      rawKind,
      category: classifyCategory(rawKind),
    });
  }

  // Output validate — bozuk veri DB'ye sızmasın.
  const validation = ProvysParseOutputSchema.safeParse(items);
  if (!validation.success) {
    throw new ProvysParseError('Parser çıktısı şemaya uymuyor', validation.error);
  }
  return validation.data;
}
