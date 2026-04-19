import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

export interface BxfEvent {
  eventId:     string;
  title:       string;
  startTime:   Date;
  endTime:     Date;
  houseNumber?: string;
  contentName?: string;
  description?: string;
}

export interface BxfSchedule {
  channelShortName: string;
  channelFullName:  string;
  events: BxfEvent[];
}

const xmlParser = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: '@_',
  removeNSPrefix:      true,
  textNodeName:        '#text',
  isArray: (name) => ['ScheduledEvent', 'Schedule', 'EventId'].includes(name),
});

function smpteToDate(broadcastDate: string, smpteCode: string, frameRate = 25): Date {
  const [h = '0', m = '0', s = '0', f = '0'] = smpteCode.split(':');
  const ms = Math.round((parseInt(f, 10) / frameRate) * 1000);
  return new Date(
    `${broadcastDate}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}.${ms.toString().padStart(3, '0')}+03:00`,
  );
}

function addSmpte(base: Date, smpteCode: string, frameRate = 25): Date {
  const [h = '0', m = '0', s = '0', f = '0'] = smpteCode.split(':');
  const totalMs =
    (parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000 +
    Math.round((parseInt(f, 10) / frameRate) * 1000);
  return new Date(base.getTime() + totalMs);
}

export function parseBxf(filePath: string): BxfSchedule | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const doc = xmlParser.parse(content);
  const bxfData = doc?.BxfMessage?.BxfData;
  if (!bxfData) return null;

  const rawSchedules: any[] = Array.isArray(bxfData.Schedule)
    ? bxfData.Schedule
    : [bxfData.Schedule].filter(Boolean);

  if (!rawSchedules.length) return null;

  // Bir BXF dosyasında genelde tek Schedule olur; ilkini kullan
  const sched = rawSchedules[0];
  const channel = sched?.Channel;
  const channelShortName: string = channel?.['@_ShortName'] ?? '';
  const rawFullName = channel?.Name;
  const channelFullName: string =
    typeof rawFullName === 'object' ? rawFullName['#text'] ?? '' : rawFullName ?? '';

  const rawEvents: any[] = Array.isArray(sched?.ScheduledEvent)
    ? sched.ScheduledEvent
    : [sched?.ScheduledEvent].filter(Boolean);

  const events: BxfEvent[] = [];

  for (const se of rawEvents) {
    // Sadece "Main Programme" içerikleri al
    if (se?.ContentType !== 'Main Programme') continue;

    const ed = se?.EventData;
    if (!ed) continue;

    const eventType: string = ed?.['@_eventType'] ?? '';
    // ProgramHeader satırları yalnızca başlık; Primary olanlar gerçek içerik
    if (eventType === 'Primary-ProgramHeader') continue;
    if (!eventType.startsWith('Primary')) continue;

    const title: string = ed?.EventTitle ?? '';

    // EventId — dizi içinde ilk eleman
    const eventIdArr: any[] = Array.isArray(ed?.EventId?.EventId)
      ? ed.EventId.EventId
      : [ed?.EventId?.EventId].filter(Boolean);
    const eventId: string = eventIdArr[0] ?? '';

    const smpteDt = ed?.StartDateTime?.SmpteDateTime;
    if (!smpteDt) continue;

    const broadcastDate: string = smpteDt['@_broadcastDate'] ?? '';
    const frameRate      = parseInt(smpteDt['@_frameRate'] ?? '25', 10);
    const startCode: string = smpteDt?.SmpteTimeCode ?? '';
    if (!broadcastDate || !startCode) continue;

    const startTime = smpteToDate(broadcastDate, startCode, frameRate);

    const durCode: string =
      ed?.LengthOption?.Duration?.SmpteDuration?.SmpteTimeCode ?? '';
    const endTime = durCode
      ? addSmpte(startTime, durCode, frameRate)
      : new Date(startTime.getTime() + 60 * 60 * 1000); // fallback: +1 saat

    const content = se?.Content;
    const houseNumber: string  = content?.ContentId?.HouseNumber ?? '';
    const contentName: string  = content?.Name ?? '';
    const rawDesc: any         = content?.Description;
    const description: string  = typeof rawDesc === 'object'
      ? (rawDesc['#text'] ?? '')
      : (rawDesc ?? '');

    events.push({ eventId, title, startTime, endTime, houseNumber, contentName, description });
  }

  return { channelShortName, channelFullName, events };
}
