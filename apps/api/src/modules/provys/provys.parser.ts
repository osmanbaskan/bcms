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
  /** Broadcast day `YYYY-MM-DD` (Europe/Istanbul naive). Dosya scope tarih. */
  scheduleDate: string;
  sequence: number;
  startAt: Date;
  durationMs: number | null;
  /** SMPTE timecode `HH:MM:SS:FF` ham, frame korunur. */
  startTimecode: string | null;
  /** SMPTE duration `HH:MM:SS:FF` ham. */
  durationTimecode: string | null;
  /** SmpteDateTime / SmpteDuration @frameRate (genelde 25). */
  frameRate: number | null;
  /** Content > ContentId > HouseNumber (Provys "DC..." house code). */
  dcCode: string | null;
  title: string;
  rawKind: string | null;
  category: ProvysCategory;
}

const SMPTE_TIMECODE_RE = /^\d{1,3}:\d{1,2}:\d{1,2}:\d{1,3}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ParsedItemSchema = z.object({
  eventId: z.string().min(1).max(120),
  scheduleDate: z.string().regex(ISO_DATE_RE),
  sequence: z.number().int().min(0),
  startAt: z.date(),
  durationMs: z.number().int().nonnegative().nullable(),
  startTimecode: z.string().max(20).regex(SMPTE_TIMECODE_RE).nullable(),
  durationTimecode: z.string().max(20).regex(SMPTE_TIMECODE_RE).nullable(),
  frameRate: z.number().int().positive().nullable(),
  dcCode: z.string().max(40).regex(/^DC[0-9A-Za-z]+$/).nullable(),
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

interface StartDateTimeFields {
  instant: Date | null;
  timecode: string | null;   // ham SmpteTimeCode (HH:MM:SS:FF)
  frameRate: number | null;
}

function parseStartDateTime(startDt: unknown): StartDateTimeFields {
  if (!startDt || typeof startDt !== 'object') return { instant: null, timecode: null, frameRate: null };
  const smpte = (startDt as Record<string, unknown>)['SmpteDateTime'] as Record<string, unknown> | undefined;
  if (!smpte) return { instant: null, timecode: null, frameRate: null };
  const broadcastDate = String(smpte['@_broadcastDate'] ?? '').trim();
  const rawTimecode = String(smpte['SmpteTimeCode'] ?? '').trim();
  const timecode = SMPTE_TIMECODE_RE.test(rawTimecode) ? rawTimecode : null;
  const wall = smpteToWallClock(rawTimecode);
  const frFromAttr = Number(smpte['@_frameRate']);
  const frameRate = Number.isFinite(frFromAttr) && frFromAttr > 0 ? frFromAttr : null;
  if (!broadcastDate || !wall) {
    return { instant: null, timecode, frameRate };
  }
  try {
    const dt = composeIstanbulInstant(broadcastDate, wall);
    return {
      instant: Number.isNaN(dt.getTime()) ? null : dt,
      timecode,
      frameRate,
    };
  } catch {
    return { instant: null, timecode, frameRate };
  }
}

interface DurationFields {
  ms: number | null;
  timecode: string | null;
  frameRate: number | null;
}

function parseDuration(lengthOpt: unknown): DurationFields {
  if (!lengthOpt || typeof lengthOpt !== 'object') return { ms: null, timecode: null, frameRate: null };
  const dur = (lengthOpt as Record<string, unknown>)['Duration'] as Record<string, unknown> | undefined;
  const smpte = dur?.['SmpteDuration'] as Record<string, unknown> | undefined;
  if (!smpte) return { ms: null, timecode: null, frameRate: null };
  const rawTimecode = String(smpte['SmpteTimeCode'] ?? '').trim();
  const timecode = SMPTE_TIMECODE_RE.test(rawTimecode) ? rawTimecode : null;
  const frAttr = Number(smpte['@_frameRate']);
  const frameRate = Number.isFinite(frAttr) && frAttr > 0 ? frAttr : null;
  const ms = smpteTimecodeToMs(rawTimecode, frameRate ?? undefined);
  return { ms, timecode, frameRate };
}

/**
 * ScheduledEvent > Content > ContentId > HouseNumber → Provys "DC..." house
 * code. Sadece "DC" ile başlayan değerler döner; aksi durumda null (kontrollü).
 *
 * Fallback path: Content > ContentMetaData > ContentId > HouseNumber.
 */
function extractDcCode(scheduledEvent: Record<string, unknown>): string | null {
  const content = scheduledEvent['Content'] as Record<string, unknown> | undefined;
  if (!content) return null;
  const direct = (content['ContentId'] as Record<string, unknown> | undefined)?.['HouseNumber'];
  const fromMeta = ((content['ContentMetaData'] as Record<string, unknown> | undefined)?.['ContentId'] as Record<string, unknown> | undefined)?.['HouseNumber'];
  const candidates = [direct, fromMeta];
  for (const c of candidates) {
    if (typeof c === 'string') {
      const value = c.trim();
      if (/^DC[0-9A-Za-z]+$/.test(value)) return value;
    } else if (c != null && typeof c === 'object') {
      const text = (c as Record<string, unknown>)['#text'];
      if (typeof text === 'string') {
        const value = text.trim();
        if (/^DC[0-9A-Za-z]+$/.test(value)) return value;
      }
    }
  }
  return null;
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

/**
 * Description element'i tek obje veya array olabilir; `type` attribute'una
 * göre eşleşen ilk dolu text'i döner.
 */
function findDescriptionText(content: Record<string, unknown> | undefined, type: string): string | null {
  if (!content) return null;
  const raw = content['Description'];
  const candidates = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const cr = c as Record<string, unknown>;
    if (cr['@_type'] !== type) continue;
    const text = cr['#text'];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return null;
}

/** İlk dolu string'i (trim'li) seçer, 500 char'a kısar. */
function pickFirstString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string') {
      const s = c.trim();
      if (s) return s.length > 500 ? s.slice(0, 500) : s;
    }
  }
  return null;
}

/**
 * Başlık kaynağı (en zenginden generic'e). Provys 6+ farklı alanda metin
 * taşıyor; UI'da operatöre en faydalı olan zengin açıklayıcı VersionName /
 * EpisodeName öncelikli, generic EventTitle / ProgramName fallback.
 *
 * Sıra:
 *   1. Content > Description[@type="VersionName"]   — örn. "... 34. Hafta Trabzonspor - Gençlerbirliği Maçı Bant - HD"
 *   2. Content > ContentDetail > ProgramContent > Series > EpisodeName
 *   3. EventData > EventTitle                       — generic ad
 *   4. Content > Name                               — kısa içerik adı
 *   5. PrimaryEvent > ProgramEvent > ProgramName    — program adı
 *   6. NonProgramEvent > Details > AdType (+ SpotType) — promo/reklam etiketi
 */
function deriveTitle(
  scheduledEvent: Record<string, unknown>,
  evd: Record<string, unknown>,
): string {
  const content = scheduledEvent['Content'] as Record<string, unknown> | undefined;

  // 1. VersionName (en zengin)
  const versionName = findDescriptionText(content, 'VersionName');
  if (versionName) return versionName.slice(0, 500);

  // 2. Series > EpisodeName
  const series = ((content?.['ContentDetail'] as Record<string, unknown> | undefined)
    ?.['ProgramContent'] as Record<string, unknown> | undefined)
    ?.['Series'] as Record<string, unknown> | undefined;
  const episodeName = pickFirstString(series?.['EpisodeName']);
  if (episodeName) return episodeName;

  // 3. EventTitle (generic)
  const eventTitle = pickFirstString(evd['EventTitle']);
  if (eventTitle) return eventTitle;

  // 4. Content > Name
  const contentName = pickFirstString(content?.['Name']);
  if (contentName) return contentName;

  // 5. ProgramEvent > ProgramName
  const primary = evd['PrimaryEvent'] as Record<string, unknown> | undefined;
  const programName = pickFirstString((primary?.['ProgramEvent'] as Record<string, unknown> | undefined)?.['ProgramName']);
  if (programName) return programName;

  // 6. AdType (+ SpotType) — promo/reklam fallback
  const details = (primary?.['NonProgramEvent'] as Record<string, unknown> | undefined)?.['Details'] as Record<string, unknown> | undefined;
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

  // Yayın günü: dosya scope. Öncelik Schedule @ScheduleStart YYYY-MM-DD
  // prefix'i (örn. "2026-02-17T23:45:00:04" → "2026-02-17"); yoksa ilk
  // event'in SmpteDateTime @broadcastDate'i fallback.
  const scheduleStart = String(schedule?.['@_ScheduleStart'] ?? '').trim();
  let scheduleDate = scheduleStart.slice(0, 10);
  if (!ISO_DATE_RE.test(scheduleDate)) {
    for (const sev of scheduledEvents) {
      const evd = (sev as Record<string, unknown> | undefined)?.['EventData'] as Record<string, unknown> | undefined;
      const smpte = (evd?.['StartDateTime'] as Record<string, unknown> | undefined)?.['SmpteDateTime'] as Record<string, unknown> | undefined;
      const bd = String(smpte?.['@_broadcastDate'] ?? '').trim();
      if (ISO_DATE_RE.test(bd)) { scheduleDate = bd; break; }
    }
  }
  if (!ISO_DATE_RE.test(scheduleDate)) return [];  // tarih yoksa parse anlamsız

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
    const startFields = parseStartDateTime(evd['StartDateTime']);
    if (!eventId || !startFields.instant) continue;

    const title = deriveTitle(sev as Record<string, unknown>, evd);
    if (!title) continue;

    const rawKind = deriveRawKind(evd);
    const durationFields = parseDuration(evd['LengthOption']);
    const dcCode = extractDcCode(sev as Record<string, unknown>);
    const frameRate = startFields.frameRate ?? durationFields.frameRate ?? null;

    items.push({
      eventId,
      scheduleDate,
      sequence: seq++,
      startAt: startFields.instant,
      durationMs: durationFields.ms,
      startTimecode: startFields.timecode,
      durationTimecode: durationFields.timecode,
      frameRate,
      dcCode,
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
