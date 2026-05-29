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

/** `title` derived display alan — fallback chain'in hangi kaynaktan
 *  geldiğini gösterir. UI/reporting için ayrı saklanır. */
export type ProvysTitleSource =
  | 'VERSION_NAME'
  | 'EPISODE_NAME'
  | 'EVENT_TITLE'
  | 'CONTENT_NAME'
  | 'PROGRAM_NAME'
  | 'AD_TYPE_SPOT_TYPE'
  | 'UNKNOWN';

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
  // 2026-05-26: Ham BXF title kaynakları — `title` derived display alan
  // olarak kalır; bu alanlar UI üst başlık / alt başlık / metadata ayrımı
  // yapabilmek için ayrı tutulur. Empty string → null normalize edilir.
  versionName: string | null;
  episodeName: string | null;
  eventTitle: string | null;
  contentName: string | null;
  programName: string | null;
  adType: string | null;
  spotType: string | null;
  titleSource: ProvysTitleSource;
  seriesName: string | null;
  episodeNumber: number | null;
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
  versionName: z.string().max(500).nullable(),
  episodeName: z.string().max(500).nullable(),
  eventTitle: z.string().max(500).nullable(),
  contentName: z.string().max(500).nullable(),
  programName: z.string().max(500).nullable(),
  adType: z.string().max(100).nullable(),
  spotType: z.string().max(100).nullable(),
  titleSource: z.enum(['VERSION_NAME','EPISODE_NAME','EVENT_TITLE','CONTENT_NAME','PROGRAM_NAME','AD_TYPE_SPOT_TYPE','UNKNOWN']),
  seriesName: z.string().max(300).nullable(),
  episodeNumber: z.number().int().min(0).max(32767).nullable(),
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
  /** Event'in kendi yayın günü `YYYY-MM-DD` — scheduleDate kanonik. */
  broadcastDate: string | null;
}

function parseStartDateTime(startDt: unknown): StartDateTimeFields {
  if (!startDt || typeof startDt !== 'object') return { instant: null, timecode: null, frameRate: null, broadcastDate: null };
  const smpte = (startDt as Record<string, unknown>)['SmpteDateTime'] as Record<string, unknown> | undefined;
  if (!smpte) return { instant: null, timecode: null, frameRate: null, broadcastDate: null };
  const rawBroadcastDate = String(smpte['@_broadcastDate'] ?? '').trim();
  const broadcastDate = ISO_DATE_RE.test(rawBroadcastDate) ? rawBroadcastDate : null;
  const rawTimecode = String(smpte['SmpteTimeCode'] ?? '').trim();
  const timecode = SMPTE_TIMECODE_RE.test(rawTimecode) ? rawTimecode : null;
  const wall = smpteToWallClock(rawTimecode);
  const frFromAttr = Number(smpte['@_frameRate']);
  const frameRate = Number.isFinite(frFromAttr) && frFromAttr > 0 ? frFromAttr : null;
  if (!broadcastDate || !wall) {
    return { instant: null, timecode, frameRate, broadcastDate };
  }
  try {
    const dt = composeIstanbulInstant(broadcastDate, wall);
    return {
      instant: Number.isNaN(dt.getTime()) ? null : dt,
      timecode,
      frameRate,
      broadcastDate,
    };
  } catch {
    return { instant: null, timecode, frameRate, broadcastDate };
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
 * Türkçe + İngilizce canlı işaretleri için word-boundary'li regex.
 * `Liverpool` veya `Olive` gibi substring false positive'leri engeller.
 */
const LIVE_TEXT_RE = /\b(live|canlı|canli)\b/i;

/**
 * Canlı yayın sinyali tespiti. Birden çok BXF field'ı incelenir:
 *   - `Content > Media > MediaLocation > Location > RouterSource > Name`
 *     → "Live" (case-insensitive). Provys'in en güçlü canlı işareti
 *     (dosya playout değil, router üstünden anlık feed).
 *   - `Content > Description[@type="VersionName"]` → "Canlı" / "Live"
 *     metin sinyali. UI'da operatöre görünen ad bu alanı taşıyor.
 *   - `EventData > EventTitle` veya `Content > Name` → text "Canlı"/"Live".
 *
 * `StartMode/EndMode = "Manual"` tek başına yetmez (canlı olmayan operatör
 * trigger'lı event'ler de Manual olabilir); ancak RouterSource veya text
 * sinyaliyle birlikte güçlü canlı kabul edilir.
 */
function hasLiveSignal(
  scheduledEvent: Record<string, unknown>,
  evd: Record<string, unknown>,
): boolean {
  const content = scheduledEvent['Content'] as Record<string, unknown> | undefined;

  // 1) RouterSource > Name — Provys canonical canlı işareti
  const routerName = ((((content?.['Media'] as Record<string, unknown> | undefined)
    ?.['MediaLocation'] as Record<string, unknown> | undefined)
    ?.['Location'] as Record<string, unknown> | undefined)
    ?.['RouterSource'] as Record<string, unknown> | undefined)
    ?.['Name'];
  if (typeof routerName === 'string' && LIVE_TEXT_RE.test(routerName)) {
    return true;
  }

  // 2) VersionName / EventTitle / Content.Name içinde 'canlı' / 'live'
  const versionName = findDescriptionText(content, 'VersionName');
  if (versionName && LIVE_TEXT_RE.test(versionName)) return true;

  const eventTitle = evd['EventTitle'];
  if (typeof eventTitle === 'string' && LIVE_TEXT_RE.test(eventTitle)) return true;

  const contentName = content?.['Name'];
  if (typeof contentName === 'string' && LIVE_TEXT_RE.test(contentName)) return true;

  // 3) StartMode + EndMode "Manual" tek başına yetmez — yukarıdaki sinyallerden
  //    biri zaten true olmadan canlı kabul edilmez. (False positive azaltma.)
  return false;
}

/**
 * Kamu spotu / PSA sinyali için güçlü pattern'ler. AdType'tan bağımsız —
 * Provys "KAMU" prefix'iyle kamu spotunu Promo olarak işaretliyor; başlık
 * metni doğru kategoriye düşürmek için override.
 *
 * Eşleşme:
 *   - Başlangıçta `KAMU\b` (word boundary) — örn. "KAMU (ÖY) ..."
 *   - Metin içinde `kamu spotu`, `\bPSA\b`, `public service`
 *
 * Aranan field'lar: EventTitle, Content.Name, Content.Description@VersionName.
 */
const PSA_PREFIX_RE = /^\s*KAMU\b/i;
const PSA_INLINE_RE = /\bkamu spotu\b|\bPSA\b|\bpublic service\b/i;

function hasPublicServiceSignal(
  scheduledEvent: Record<string, unknown>,
  evd: Record<string, unknown>,
): boolean {
  const content = scheduledEvent['Content'] as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    evd['EventTitle'],
    content?.['Name'],
    findDescriptionText(content, 'VersionName'),
  ];
  for (const c of candidates) {
    if (typeof c !== 'string' || !c.trim()) continue;
    if (PSA_PREFIX_RE.test(c) || PSA_INLINE_RE.test(c)) return true;
  }
  return false;
}

/**
 * "REK N ..." reklam blok kısa kodu Provys exporter'ında kimi zaman
 * ProgramEvent içinde gönderiliyor (Main Programme metadata, AdType yok)
 * → classifier 'Program' görüp PROGRAM kategorisi atıyor. Operasyonel
 * gerçek bunlar reklam kuşağı içeriği; başlık prefix'i sıkı pattern'le
 * yakalanır.
 *
 * Pattern güvenlik:
 *   - `^REK\b\s*\d+` → "REK 6", "REK 12 ..." eşleşir.
 *   - `\b` kelime sınırı sayesinde "REKLAM" eşleşmez (K|L bitişik harf).
 *   - "REKABET", "REKOR" da `\b` ile elenir.
 *   - Sayı zorunlu → "REKABET 1" gibi yanlış pozitifler için ek koruma.
 * Yalnız title kaynaklı alanlara bakar (EventTitle, Content.Name,
 * VersionName); dc_code gibi metadata alanlarına dokunmaz.
 */
const REK_COMMERCIAL_TITLE_RE = /^REK\b\s*\d+/i;

export function isRekCommercialTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return REK_COMMERCIAL_TITLE_RE.test(title.trim());
}

function hasRekCommercialSignal(
  scheduledEvent: Record<string, unknown>,
  evd: Record<string, unknown>,
): boolean {
  const content = scheduledEvent['Content'] as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    evd['EventTitle'],
    content?.['Name'],
    findDescriptionText(content, 'VersionName'),
    ((evd['PrimaryEvent'] as Record<string, unknown> | undefined)
      ?.['ProgramEvent'] as Record<string, unknown> | undefined)?.['ProgramName'],
  ];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    if (isRekCommercialTitle(c)) return true;
  }
  return false;
}

/**
 * EventData'dan ham tür string'i: classifier'ı besler.
 *
 * Öncelik:
 *   1. CANLI sinyali (RouterSource.Name veya VersionName/Title 'Canlı/Live')
 *      → `Live` (classifier 'Live' → CANLI kategorisi).
 *   2. PSA / Kamu Spotu sinyali (EventTitle/Content.Name/VersionName "KAMU "
 *      prefix veya inline) → `PSA` (classifier → KAMU_SPOTU). Provys AdType
 *      "Promo" işaretlese bile başlık metni kamu spotunu öncelikli yapar.
 *   3. eventType Primary-ProgramHeader → `ProgramHeader`.
 *   4. NonProgramEvent.Details.AdType (Promo / Paid Program / Commercial / …)
 *   5. ProgramEvent → `Program`.
 *   6. eventType fallback.
 */
function deriveRawKind(
  scheduledEvent: Record<string, unknown>,
  evd: Record<string, unknown>,
): string | null {
  // (1) Canlı sinyali — ProgramEvent olsa bile öncelikli
  if (hasLiveSignal(scheduledEvent, evd)) return 'Live';

  // (2) Kamu spotu sinyali — AdType=Promo olsa bile başlık "KAMU" ile
  // başlıyorsa veya "PSA"/"kamu spotu"/"public service" geçiyorsa KAMU_SPOTU.
  if (hasPublicServiceSignal(scheduledEvent, evd)) return 'PSA';

  // (2b) "REK <sayı>" reklam blok kısa kodu — Provys exporter bazen reklam
  // satırını ProgramEvent içinde gönderiyor (AdType yok). Title sinyali ile
  // REKLAM'a düzeltilir; rawKind 'Commercial' → classifyCategory REKLAM.
  // Live/PSA sinyallerinden sonra; çünkü "REK 1 CANLI..." gibi karma başlık
  // varsa CANLI/PSA önceliği korunur (yayın akışında nadir ama mantıklı).
  if (hasRekCommercialSignal(scheduledEvent, evd)) return 'Commercial';

  // (3) Primary-ProgramHeader → blok manşeti. ProgramEvent child'ı olsa
  // bile "Program" değil "ProgramHeader" döner. Aynı timecode'da gerçek
  // Content satırı (Primary, SegmentNumber≥1) ayrıca parse edilir; UI
  // default ProgramHeader satırlarını gizleyebilir, opt-in toggle ile
  // gösterilir. classifyCategory yine 'PROGRAM' döner (rawKind substring
  // "program" eşleşmesi).
  const evType = evd['@_eventType'];
  if (typeof evType === 'string' && evType.includes('ProgramHeader')) {
    return 'ProgramHeader';
  }

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
  if (typeof evType === 'string' && evType.trim()) {
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
 *
 * 2026-05-26: Hangi kaynaktan seçildiği `source` field'ında işaretli
 * (ParsedItem.titleSource → DB title_source kolonu). Ham kaynaklar da
 * `raw` objesinde ayrı döner; caller hem display title hem ham field'ları
 * tek pass'ta alır.
 */
function deriveTitle(
  scheduledEvent: Record<string, unknown>,
  evd: Record<string, unknown>,
): {
  text: string;
  source: ProvysTitleSource;
  raw: {
    versionName: string | null;
    episodeName: string | null;
    eventTitle: string | null;
    contentName: string | null;
    programName: string | null;
    adType: string | null;
    spotType: string | null;
  };
} {
  const content = scheduledEvent['Content'] as Record<string, unknown> | undefined;
  const primary = evd['PrimaryEvent'] as Record<string, unknown> | undefined;
  const npeDetails = (primary?.['NonProgramEvent'] as Record<string, unknown> | undefined)?.['Details'] as Record<string, unknown> | undefined;
  const series = ((content?.['ContentDetail'] as Record<string, unknown> | undefined)
    ?.['ProgramContent'] as Record<string, unknown> | undefined)
    ?.['Series'] as Record<string, unknown> | undefined;

  // Ham kaynakları topla — empty → null, max 500.
  const versionName = findDescriptionText(content, 'VersionName');
  const episodeName = pickFirstString(series?.['EpisodeName']);
  const eventTitle = pickFirstString(evd['EventTitle']);
  const contentName = pickFirstString(content?.['Name']);
  const programName = pickFirstString((primary?.['ProgramEvent'] as Record<string, unknown> | undefined)?.['ProgramName']);
  const adTypeRaw = pickFirstString(npeDetails?.['AdType']);
  const spotTypeRaw = pickFirstString(npeDetails?.['SpotType']);
  // adType ayrı kolon için 100 char limit
  const adType = adTypeRaw ? adTypeRaw.slice(0, 100) : null;
  const spotType = spotTypeRaw ? spotTypeRaw.slice(0, 100) : null;

  const raw = {
    versionName: versionName ?? null,
    episodeName: episodeName ?? null,
    eventTitle: eventTitle ?? null,
    contentName: contentName ?? null,
    programName: programName ?? null,
    adType,
    spotType,
  };

  // Fallback chain — ilk dolu kazanır.
  if (versionName) return { text: versionName.slice(0, 500), source: 'VERSION_NAME', raw };
  if (episodeName) return { text: episodeName, source: 'EPISODE_NAME', raw };
  if (eventTitle) return { text: eventTitle, source: 'EVENT_TITLE', raw };
  if (contentName) return { text: contentName, source: 'CONTENT_NAME', raw };
  if (programName) return { text: programName, source: 'PROGRAM_NAME', raw };
  if (adType) {
    return {
      text: [adType, spotType ?? ''].filter(Boolean).join(' / ').slice(0, 500),
      source: 'AD_TYPE_SPOT_TYPE',
      raw,
    };
  }
  return { text: '', source: 'UNKNOWN', raw };
}

/** Series/SeriesName + Series/EpisodeNumber çıkar. Sadece ProgramEvent
 *  (ContentDetail/ProgramContent altında) dolu; NonProgramEvent'te null. */
function extractSeriesFields(
  scheduledEvent: Record<string, unknown>,
): { seriesName: string | null; episodeNumber: number | null } {
  const content = scheduledEvent['Content'] as Record<string, unknown> | undefined;
  const series = ((content?.['ContentDetail'] as Record<string, unknown> | undefined)
    ?.['ProgramContent'] as Record<string, unknown> | undefined)
    ?.['Series'] as Record<string, unknown> | undefined;
  if (!series) return { seriesName: null, episodeNumber: null };

  const seriesNameRaw = pickFirstString(series['SeriesName']);
  const seriesName = seriesNameRaw ? seriesNameRaw.slice(0, 300) : null;

  // EpisodeNumber: ya direkt string ya `{#text}`. Numeric değilse veya
  // smallint sınırını (32767) aşıyorsa null.
  const epRaw = series['EpisodeNumber'];
  let episodeNumber: number | null = null;
  let epStr: string | null = null;
  if (typeof epRaw === 'string') epStr = epRaw.trim();
  else if (epRaw && typeof epRaw === 'object') {
    const text = (epRaw as Record<string, unknown>)['#text'];
    if (typeof text === 'string') epStr = text.trim();
  }
  if (epStr && /^\d+$/.test(epStr)) {
    const n = Number(epStr);
    if (Number.isFinite(n) && n >= 0 && n <= 32767) episodeNumber = n;
  }
  return { seriesName, episodeNumber };
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

  // Yayın günü kanonik kaynağı: **her event'in kendi** SmpteDateTime
  // @broadcastDate'i. Provys gece yarısı civarı event'leri önceki gün
  // etiketli dosyalarda taşıyabiliyor (örn. xSNW_20260521 dosyasında
  // broadcastDate=2026-05-22 event'leri); per-event broadcastDate doğru
  // güne yazılmayı garanti eder. Dosya-level Schedule @ScheduleStart sadece
  // event broadcastDate yoksa fallback.
  const scheduleStart = String(schedule?.['@_ScheduleStart'] ?? '').trim();
  const fileLevelFallback = ISO_DATE_RE.test(scheduleStart.slice(0, 10)) ? scheduleStart.slice(0, 10) : null;

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

    const scheduleDate = startFields.broadcastDate ?? fileLevelFallback;
    if (!scheduleDate) continue;  // ne event ne dosya tarihi varsa skip

    const titleResult = deriveTitle(sev as Record<string, unknown>, evd);
    if (!titleResult.text) continue;

    const rawKind = deriveRawKind(sev as Record<string, unknown>, evd);
    const durationFields = parseDuration(evd['LengthOption']);
    const dcCode = extractDcCode(sev as Record<string, unknown>);
    const frameRate = startFields.frameRate ?? durationFields.frameRate ?? null;
    const seriesFields = extractSeriesFields(sev as Record<string, unknown>);

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
      title: titleResult.text,
      rawKind,
      category: classifyCategory(rawKind),
      // Ham title kaynakları + derived source
      versionName: titleResult.raw.versionName,
      episodeName: titleResult.raw.episodeName,
      eventTitle: titleResult.raw.eventTitle,
      contentName: titleResult.raw.contentName,
      programName: titleResult.raw.programName,
      adType: titleResult.raw.adType,
      spotType: titleResult.raw.spotType,
      titleSource: titleResult.source,
      seriesName: seriesFields.seriesName,
      episodeNumber: seriesFields.episodeNumber,
    });
  }

  const validation = ProvysParseOutputSchema.safeParse(items);
  if (!validation.success) {
    throw new ProvysParseError('Parser çıktısı şemaya uymuyor', validation.error);
  }

  // 2026-05-27: Dosya başı "pre-rollover" bloğu filtresi.
  // Bazı Provys exporter çıktıları (gözlemlenen: LTV) XML order'a hedef gün
  // gövdesinden önce gün-sonu → gün-başı taşan kısa bir pre-roll bloğu
  // koyuyor. Güvenli guard'lar altında bu blok kırpılır (bkz. helper jsdoc).
  // Hiçbir guard sağlanmazsa items aynen döner — `currentStart < previousStart`
  // tek başına asla kırpma sebebi değildir.
  const { items: filtered } = dropLeadingPreRolloverBlock(validation.data);
  return filtered;
}

// ── Pre-rollover guard helper ────────────────────────────────────────────────

const TIMECODE_TIME_RE = /^(\d{2}):(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * "HH:MM:SS[:FF]" → time-of-day saniye (0..86399). Frame bileşeni guard
 * eşikleri (saatlik) için anlamsız olduğundan ihmal edilir. Malformed input
 * veya alan dışı saatlerde `null`. Pure.
 */
export function timecodeToTimeOfDaySeconds(tc: string | null | undefined): number | null {
  if (!tc) return null;
  const m = tc.match(TIMECODE_TIME_RE);
  if (!m) return null;
  const h = Number(m[1]);
  const mn = Number(m[2]);
  const s = Number(m[3]);
  if (!Number.isFinite(h) || !Number.isFinite(mn) || !Number.isFinite(s)) return null;
  if (h < 0 || h > 23 || mn < 0 || mn > 59 || s < 0 || s > 59) return null;
  return h * 3600 + mn * 60 + s;
}

const PRE_ROLL_PREV_END_THRESHOLD_S = 22 * 3600;  // 22:00:00
const PRE_ROLL_CURR_START_THRESHOLD_S = 2 * 3600; // 02:00:00

export interface PreRollFilterInfo {
  /** Drop uygulandı mı (true → items dizisi kırpıldı). */
  applied: boolean;
  droppedCount: number;
  keptCount: number;
  /** Drop uygulandıysa hangi segment tutuldu: 'after' = pre-roll baş düştü,
   *  'before' = next-day tail son düştü. Drop yapılmadıysa null. */
  segmentChoice: 'before' | 'after' | 'middle' | null;
  /** Seçilen safe rollover'ın XML order index'i (yalnız tek safe rollover
   *  varsa doldurulur). Aksi halde null. */
  rolloverIndex: number | null;
  previousTimecode: string | null;
  currentTimecode: string | null;
  reason:
    | 'leading-pre-roll'                  // applied=true, segment=after; pre-roll baş düştü
    | 'trailing-next-day-tail'            // applied=true, segment=before; next-day tail düştü
    | 'middle-segment-kept'               // applied=true, segment=middle; head ve next-day tail düştü
    | 'no-rollover'                       // hiç currentStart<previousStart yok
    | 'unsafe-rollover-skipped'           // rollover var ama 22:00 / 02:00 guard'larını geçmedi
    | 'multiple-safe-rollovers-skipped'   // 3+ safe rollover var; karmaşık, drop yok
    | 'empty-result-skipped'              // segment seçimi boş liste üretecekti
    | 'first-item-unparseable'            // ilk item startTimecode parse edilemedi
    | 'too-few-items';                    // 0 veya 1 item
}

/**
 * Pure: XML order'da gelen items dizisinden "doğru gün segmenti"ni seçer.
 *
 * Bazı Provys exporter çıktıları XML order'a hedef gün gövdesinden önce
 * bir gün-sonu pre-roll bloğu (örn. 22:59→23:59→00:00→…) veya sonra bir
 * next-day tail bloğu (örn. 01:00→…→23:59→00:30) ekliyor. Bu helper safe
 * rollover noktası tespit edip hedef gün segmentini tutar, diğerini düşürür.
 *
 * Algoritma:
 *  1. XML order'da `currentStart < previousStart` olan tüm "rollover"
 *     noktalarını topla.
 *  2. Her rollover için **safe** mı kontrol et:
 *       previousStart >= 22:00:00  AND  currentStart <= 02:00:00
 *  3. Sadece **tek** safe rollover varsa segment seçimi uygulanır:
 *       - İlk item start >= 22:00 → 'after' segmenti tutulur
 *         (örn. 22:59→23:59→00:00→23:59 → kalan 00:00→23:59)
 *       - İlk item start <  22:00 → 'before' segmenti tutulur
 *         (örn. 01:00→…→23:59→00:30 → kalan 01:00→23:59)
 *  4. Birden fazla safe rollover varsa → drop YAPMA (karmaşık, raporla).
 *  5. Hiç safe rollover yoksa veya yalnız unsafe rollover varsa → liste aynen.
 *  6. Segment seçimi boş liste üretecekse → drop YAPMA.
 *
 * **Critical safety**: tek başına `currentStart < previousStart` drop sebebi
 * DEĞİL. 17:00→23:59 monoton partial-day, 00:00→23:59 tam gün, 05:00→23:59
 * geç başlangıç, 01:00→00:30 unsafe senaryosunda hiçbir item düşmez.
 */
export function dropLeadingPreRolloverBlock(
  items: readonly ParsedItem[],
): { items: ParsedItem[]; info: PreRollFilterInfo } {
  const passthrough = (reason: PreRollFilterInfo['reason'], extra: Partial<PreRollFilterInfo> = {}): { items: ParsedItem[]; info: PreRollFilterInfo } => ({
    items: [...items],
    info: {
      applied: false, droppedCount: 0, keptCount: items.length,
      segmentChoice: null, rolloverIndex: null,
      previousTimecode: null, currentTimecode: null,
      reason, ...extra,
    },
  });

  if (items.length < 2) return passthrough('too-few-items');

  // 1) Tüm safe rollover'ları topla. Parse edilemeyen timecode'lar
  //    karşılaştırmayı sessizce atlatır.
  type Roll = { idx: number; prevTc: string | null; currTc: string | null; prevSec: number; currSec: number };
  const safeRollovers: Roll[] = [];
  let anyRolloverSeen: Roll | null = null;
  for (let i = 1; i < items.length; i++) {
    const prevSec = timecodeToTimeOfDaySeconds(items[i - 1].startTimecode);
    const currSec = timecodeToTimeOfDaySeconds(items[i].startTimecode);
    if (prevSec == null || currSec == null) continue;
    if (currSec >= prevSec) continue;
    const roll: Roll = {
      idx: i,
      prevTc: items[i - 1].startTimecode,
      currTc: items[i].startTimecode,
      prevSec, currSec,
    };
    if (anyRolloverSeen == null) anyRolloverSeen = roll;
    if (prevSec >= PRE_ROLL_PREV_END_THRESHOLD_S && currSec <= PRE_ROLL_CURR_START_THRESHOLD_S) {
      safeRollovers.push(roll);
    }
  }

  // 2) Hiç rollover yok.
  if (anyRolloverSeen == null) return passthrough('no-rollover');

  // 3) Rollover var ama hiçbiri safe değil.
  if (safeRollovers.length === 0) {
    return passthrough('unsafe-rollover-skipped', {
      rolloverIndex: anyRolloverSeen.idx,
      previousTimecode: anyRolloverSeen.prevTc,
      currentTimecode: anyRolloverSeen.currTc,
    });
  }

  // 4) Tam 2 safe rollover → "head + body+tail + next-day suffix" paterni.
  //    Provys exporter bazı LTV dosyalarında dosyanın başında pre-roll head
  //    (gün-sonu artıkları, AYRI Provys planning kaydı, bizim akışa girmemeli)
  //    + ortada body+tail (asıl gün içeriği, 23:00 civarı gerçek programlar
  //    dahil) + sonda next-day suffix (00:00 civarı tek-iki promo) gönderir.
  //    Doğru çıktı: middle segment (R1..R2) — head düşer, next-day suffix
  //    düşer; orta segment (gün gövdesi + akşam tail) korunur.
  //
  //    Örnek: LTV 2026-05-28 dosyasında DC00041191 (head'deki yanlış 5. hafta
  //    pre-roll) düşer; DC00041192 (orta segmentteki gerçek 6. hafta tail)
  //    korunur; sondaki 00:00:07 next-day promo düşer.
  if (safeRollovers.length === 2) {
    const [r1, r2] = safeRollovers;
    const kept = items.slice(r1.idx, r2.idx);
    const droppedCount = items.length - kept.length;
    if (kept.length === 0 || droppedCount === 0) {
      return passthrough('empty-result-skipped', {
        rolloverIndex: r1.idx,
        previousTimecode: r1.prevTc,
        currentTimecode: r1.currTc,
      });
    }
    return {
      items: [...kept],
      info: {
        applied: true,
        droppedCount,
        keptCount: kept.length,
        segmentChoice: 'middle',
        rolloverIndex: r1.idx,
        previousTimecode: r1.prevTc,
        currentTimecode: r1.currTc,
        reason: 'middle-segment-kept',
      },
    };
  }

  // 5) 3+ safe rollover → karmaşık senaryo, otomatik düzeltme yok.
  if (safeRollovers.length > 2) {
    return passthrough('multiple-safe-rollovers-skipped', {
      rolloverIndex: safeRollovers[0].idx,
      previousTimecode: safeRollovers[0].prevTc,
      currentTimecode: safeRollovers[0].currTc,
    });
  }

  // 5) Tek safe rollover → segment seçimi.
  const roll = safeRollovers[0];
  const firstSec = timecodeToTimeOfDaySeconds(items[0].startTimecode);
  if (firstSec == null) {
    return passthrough('first-item-unparseable', {
      rolloverIndex: roll.idx,
      previousTimecode: roll.prevTc,
      currentTimecode: roll.currTc,
    });
  }

  // İlk item gün sonu penceresinde (>= 22:00) → dosya pre-roll ile başlamış,
  // hedef gün rollover SONRASI segment. Aksi halde dosya normal/erken gün
  // ile başlamış, hedef gün rollover ÖNCESİ segment.
  const keepAfter = firstSec >= PRE_ROLL_PREV_END_THRESHOLD_S;
  const kept = keepAfter ? items.slice(roll.idx) : items.slice(0, roll.idx);
  const droppedCount = items.length - kept.length;

  if (kept.length === 0 || droppedCount === 0) {
    return passthrough('empty-result-skipped', {
      rolloverIndex: roll.idx,
      previousTimecode: roll.prevTc,
      currentTimecode: roll.currTc,
    });
  }

  return {
    items: [...kept],
    info: {
      applied: true,
      droppedCount,
      keptCount: kept.length,
      segmentChoice: keepAfter ? 'after' : 'before',
      rolloverIndex: roll.idx,
      previousTimecode: roll.prevTc,
      currentTimecode: roll.currTc,
      reason: keepAfter ? 'leading-pre-roll' : 'trailing-next-day-tail',
    },
  };
}
