import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { classifyCategory } from './provys.classifier.js';
import { composeIstanbulInstant } from '../../core/tz.js';
import { PROVYS_CATEGORIES, type ProvysCategory } from '@bcms/shared';

/**
 * Provys / SMPTE 2021 BXF playlist parser — saf fonksiyon.
 *
 * Gerçek BXF yapısı (Provys exporter):
 *
 *   <BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF" ...>
 *     <BxfData action="add">
 *       <Schedule type="Primary" ScheduleStart=... ScheduleEnd=...>
 *         <Channel ShortName="LT2">...</Channel>
 *         <ScheduledEvent>
 *           <EventData eventType="Primary"|"Primary-ProgramHeader"|"NonPrimary">
 *             <EventId><EventId>urn:uuid:...</EventId></EventId>
 *             <EventTitle>...</EventTitle>
 *             <PrimaryEvent>
 *               <ProgramEvent>...</ProgramEvent>
 *                 - veya -
 *               <NonProgramEvent>
 *                 <Details>
 *                   <AdType>Promo|Commercial|PSA|Live|Other</AdType>
 *                   <SpotType>Standard</SpotType>
 *                 </Details>
 *               </NonProgramEvent>
 *             </PrimaryEvent>
 *             <StartDateTime>
 *               <SmpteDateTime frameRate="25" broadcastDate="2026-02-17">
 *                 <SmpteTimeCode>HH:MM:SS:FF</SmpteTimeCode>
 *               </SmpteDateTime>
 *             </StartDateTime>
 *             <LengthOption><Duration><SmpteDuration frameRate="25">
 *               <SmpteTimeCode>HH:MM:SS:FF</SmpteTimeCode>
 *             </SmpteDuration></Duration></LengthOption>
 *           </EventData>
 *         </ScheduledEvent>
 *
 * `NonPrimary` (Logo overlay vb.) akış listesinden filtrelenir — operasyonel
 * görüntülenmemesi gereken secondary event'ler.
 *
 * Zaman/süre:
 *  - StartDateTime: `broadcastDate` + `SmpteTimeCode` Europe/Istanbul yerel
 *    kabul edilir → tz helper ile UTC instant.
 *  - SmpteDuration: HH:MM:SS:FF + frameRate üzerinden ms.
 *
 * Çıktı Zod ile validate edilir. Malformed XML → ProvysParseError.
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

// `removeNSPrefix`: default xmlns="..." prefix'ini ve pmcp:/ext: prefix'lerini
// kaldırır → element isimleri ham (Schedule, ScheduledEvent, EventData ...)
// üstüne hizalanır.
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

function parseStartDateTime(startDt: unknown): Date | null {
  if (!startDt || typeof startDt !== 'object') return null;
  const smpte = (startDt as Record<string, unknown>)['SmpteDateTime'] as Record<string, unknown> | undefined;
  if (!smpte) return null;
  const broadcastDate = String(smpte['@_broadcastDate'] ?? '').trim();
  const wall = smpteToWallClock(String(smpte['SmpteTimeCode'] ?? ''));
  if (!broadcastDate || !wall) return null;
  try {
    const dt = composeIstanbulInstant(broadcastDate, wall);
    return Number.isNaN(dt.getTime()) ? null : dt;
  } catch {
    return null;
  }
}

function parseDuration(lengthOpt: unknown): number | null {
  if (!lengthOpt || typeof lengthOpt !== 'object') return null;
  const dur = (lengthOpt as Record<string, unknown>)['Duration'] as Record<string, unknown> | undefined;
  const smpte = dur?.['SmpteDuration'] as Record<string, unknown> | undefined;
  if (!smpte) return null;
  const fr = Number(smpte['@_frameRate']);
  return smpteTimecodeToMs(String(smpte['SmpteTimeCode'] ?? ''), Number.isFinite(fr) ? fr : 25);
}

function extractEventId(evd: Record<string, unknown>): string | null {
  // <EventId><EventId>urn:uuid:...</EventId></EventId>
  const outer = evd['EventId'];
  if (!outer) return null;
  if (typeof outer === 'string') return outer.trim() || null;
  if (typeof outer === 'object') {
    const inner = (outer as Record<string, unknown>)['EventId'];
    if (typeof inner === 'string') return inner.trim() || null;
    const text = (outer as Record<string, unknown>)['#text'];
    if (typeof text === 'string') return text.trim() || null;
  }
  return null;
}

/**
 * EventData'dan ham tür string'i: classifier'ı besler.
 * Öncelik: NonProgramEvent.Details.AdType > ProgramEvent (=Program) >
 * eventType attribute (Primary-ProgramHeader → ProgramHeader).
 */
function deriveRawKind(evd: Record<string, unknown>): string | null {
  const primary = evd['PrimaryEvent'] as Record<string, unknown> | undefined;
  if (primary) {
    const npe = primary['NonProgramEvent'] as Record<string, unknown> | undefined;
    if (npe) {
      const details = npe['Details'] as Record<string, unknown> | undefined;
      const adType = details?.['AdType'];
      if (typeof adType === 'string' && adType.trim()) return adType.trim();
    }
    if (primary['ProgramEvent']) return 'Program';
  }
  const evType = evd['@_eventType'];
  if (typeof evType === 'string' && evType.trim()) {
    if (evType.includes('ProgramHeader')) return 'ProgramHeader';
    if (evType === 'Primary') return 'Primary';
    return evType.trim();
  }
  return null;
}

/** Başlık fallback'i: EventTitle boşsa ProgramName / AdType + SpotType / boş. */
function deriveTitle(evd: Record<string, unknown>): string {
  const titleRaw = evd['EventTitle'];
  if (typeof titleRaw === 'string') {
    const t = titleRaw.trim();
    if (t) return t.length > 500 ? t.slice(0, 500) : t;
  }
  const primary = evd['PrimaryEvent'] as Record<string, unknown> | undefined;
  const programName = (primary?.['ProgramEvent'] as Record<string, unknown> | undefined)?.['ProgramName'];
  if (typeof programName === 'string' && programName.trim()) {
    const s = programName.trim();
    return s.length > 500 ? s.slice(0, 500) : s;
  }
  const npe = primary?.['NonProgramEvent'] as Record<string, unknown> | undefined;
  const details = npe?.['Details'] as Record<string, unknown> | undefined;
  const adType = details?.['AdType'];
  const spotType = details?.['SpotType'];
  if (typeof adType === 'string' && adType.trim()) {
    return [adType, typeof spotType === 'string' ? spotType : '']
      .filter(Boolean)
      .join(' / ')
      .slice(0, 500);
  }
  return '';
}

/**
 * Pure parser. Throws `ProvysParseError` on malformed XML.
 *
 * @param content BXF XML içeriği (UTF-8 string)
 */
export function parseBxf(content: string): ParsedItem[] {
  if (typeof content !== 'string' || content.trim() === '') return [];

  // Defansif structural validation — XMLParser tolerant, ama tag mismatch /
  // unclosed tag gibi yapısal bozukluklarda sessizce çöpe yutmaması için
  // XMLValidator ön kontrolü.
  const xmlValidation = XMLValidator.validate(content);
  if (xmlValidation !== true) {
    throw new ProvysParseError('BXF XML yapısal olarak geçersiz', xmlValidation);
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(content);
  } catch (err) {
    throw new ProvysParseError('BXF XML parse hatası', err);
  }

  const root = parsed as Record<string, unknown>;
  const bxfMessage = (root['BxfMessage'] ?? root) as Record<string, unknown> | undefined;
  const bxfData = bxfMessage?.['BxfData'] as Record<string, unknown> | undefined;
  const schedule = bxfData?.['Schedule'] as Record<string, unknown> | undefined;
  const scheduledEvents = toArray(schedule?.['ScheduledEvent']);

  const items: ParsedItem[] = [];
  let seq = 0;

  for (const sev of scheduledEvents) {
    if (!sev || typeof sev !== 'object') continue;
    const evd = (sev as Record<string, unknown>)['EventData'] as Record<string, unknown> | undefined;
    if (!evd) continue;

    const eventType = String(evd['@_eventType'] ?? '').trim();
    // NonPrimary = logo/overlay/secondary; akış listesinde gösterme.
    if (eventType === 'NonPrimary') continue;

    const eventId = extractEventId(evd);
    const startAt = parseStartDateTime(evd['StartDateTime']);
    if (!eventId || !startAt) continue;

    const title = deriveTitle(evd);
    if (!title) continue;

    const rawKind = deriveRawKind(evd);
    const durationMs = parseDuration(evd['LengthOption']);

    items.push({
      eventId,
      sequence: seq++,
      startAt,
      durationMs,
      title,
      rawKind,
      category: classifyCategory(rawKind),
    });
  }

  const validation = ProvysParseOutputSchema.safeParse(items);
  if (!validation.success) {
    throw new ProvysParseError('Parser çıktısı şemaya uymuyor', validation.error);
  }
  return validation.data;
}
