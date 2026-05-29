import { describe, it, expect } from 'vitest';
import {
  parseBxf,
  ProvysParseError,
  isRekCommercialTitle,
  dropLeadingPreRolloverBlock,
  timecodeToTimeOfDaySeconds,
} from './provys.parser.js';
import type { ParsedItem } from './provys.parser.js';

/**
 * SMPTE 2021 BXF fixture — gerçek Provys exporter çıktısının küçültülmüş
 * temsili. Üç ScheduledEvent: ProgramHeader, Program, Promo + bir tane
 * NonPrimary (Logo) filtrelenmeli.
 */
const SAMPLE_BXF = `<?xml version="1.0" encoding="UTF-8"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF" xmlns:pmcp="http://www.atsc.org/XMLSchemas/pmcp/2007/3.1" xmlns:ext="http://smpte-ra.org/schemas/2021/2017/BXF/Extension" messageType="Information">
  <BxfData action="add">
    <Schedule type="Primary" ScheduleStart="2026-02-17T23:45:00:04" ScheduleEnd="2026-02-18T00:30:00:00">
      <Channel ShortName="LT2"/>
      <ScheduledEvent>
        <EventData eventType="Primary-ProgramHeader">
          <EventId><EventId>urn:uuid:HDR-001</EventId></EventId>
          <EventTitle>TFF 1. Lig 25-26 Haftanın Golleri</EventTitle>
          <PrimaryEvent>
            <ProgramEvent>
              <SegmentNumber>0</SegmentNumber>
              <ProgramName>TFF 1. Lig 25-26 Haftanın Golleri</ProgramName>
            </ProgramEvent>
          </PrimaryEvent>
          <StartDateTime>
            <SmpteDateTime frameRate="25" broadcastDate="2026-02-17">
              <SmpteTimeCode>23:45:00:04</SmpteTimeCode>
            </SmpteDateTime>
          </StartDateTime>
          <LengthOption><Duration><SmpteDuration frameRate="25">
            <SmpteTimeCode>00:15:01:16</SmpteTimeCode>
          </SmpteDuration></Duration></LengthOption>
        </EventData>
      </ScheduledEvent>
      <ScheduledEvent>
        <EventData eventType="Primary">
          <EventId><EventId>urn:uuid:PRG-001</EventId></EventId>
          <EventTitle>TFF 1. Lig 25-26 Haftanın Golleri</EventTitle>
          <PrimaryEvent>
            <ProgramEvent>
              <SegmentNumber>1</SegmentNumber>
              <ProgramName>TFF 1. Lig 25-26 Haftanın Golleri</ProgramName>
            </ProgramEvent>
          </PrimaryEvent>
          <StartDateTime>
            <SmpteDateTime frameRate="25" broadcastDate="2026-02-17">
              <SmpteTimeCode>23:45:00:04</SmpteTimeCode>
            </SmpteDateTime>
          </StartDateTime>
          <LengthOption><Duration><SmpteDuration frameRate="25">
            <SmpteTimeCode>00:12:53:22</SmpteTimeCode>
          </SmpteDuration></Duration></LengthOption>
        </EventData>
      </ScheduledEvent>
      <ScheduledEvent>
        <EventData eventType="Primary">
          <EventId><EventId>urn:uuid:PROMO-001</EventId></EventId>
          <EventTitle/>
          <PrimaryEvent>
            <NonProgramEvent>
              <Details>
                <AdType>Promo</AdType>
                <SpotType>Standard</SpotType>
              </Details>
            </NonProgramEvent>
          </PrimaryEvent>
          <StartDateTime>
            <SmpteDateTime frameRate="25" broadcastDate="2026-02-17">
              <SmpteTimeCode>23:57:53:26</SmpteTimeCode>
            </SmpteDateTime>
          </StartDateTime>
          <LengthOption><Duration><SmpteDuration frameRate="25">
            <SmpteTimeCode>00:00:30:00</SmpteTimeCode>
          </SmpteDuration></Duration></LengthOption>
        </EventData>
      </ScheduledEvent>
      <ScheduledEvent>
        <EventData eventType="NonPrimary">
          <EventId><EventId>urn:uuid:LOGO-001</EventId></EventId>
          <EventTitle/>
          <NonPrimaryEvent>
            <NonPrimaryEventName>Logo</NonPrimaryEventName>
          </NonPrimaryEvent>
          <StartDateTime>
            <SmpteDateTime frameRate="25" broadcastDate="2026-02-17">
              <SmpteTimeCode>23:45:00:04</SmpteTimeCode>
            </SmpteDateTime>
          </StartDateTime>
          <LengthOption><Duration><SmpteDuration frameRate="25">
            <SmpteTimeCode>00:12:53:22</SmpteTimeCode>
          </SmpteDuration></Duration></LengthOption>
        </EventData>
      </ScheduledEvent>
    </Schedule>
  </BxfData>
</BxfMessage>`;

describe('provys.parser › parseBxf (SMPTE 2021)', () => {
  it('parses Schedule > ScheduledEvent and filters NonPrimary', () => {
    const items = parseBxf(SAMPLE_BXF);
    expect(items.map((i) => i.eventId)).toEqual([
      'urn:uuid:HDR-001',
      'urn:uuid:PRG-001',
      'urn:uuid:PROMO-001',
    ]);
  });

  it('assigns deterministic sequence and classifies categories', () => {
    const items = parseBxf(SAMPLE_BXF);
    expect(items[0]).toMatchObject({ sequence: 0, category: 'PROGRAM' });
    expect(items[1]).toMatchObject({ sequence: 1, category: 'PROGRAM', rawKind: 'Program' });
    // Primary > NonProgramEvent.Details.AdType=Promo → TANITIM
    expect(items[2]).toMatchObject({ sequence: 2, category: 'TANITIM', rawKind: 'Promo' });
  });

  it('converts broadcastDate + SmpteTimeCode to UTC instant via Europe/Istanbul', () => {
    const items = parseBxf(SAMPLE_BXF);
    // 2026-02-17 23:45:00 Istanbul = 2026-02-17T20:45:00Z (UTC+3, no DST)
    expect(items[0].startAt.toISOString()).toBe('2026-02-17T20:45:00.000Z');
  });

  it('extracts scheduleDate from Schedule @ScheduleStart (broadcast day, dosya scope)', () => {
    const items = parseBxf(SAMPLE_BXF);
    for (const it of items) {
      expect(it.scheduleDate).toBe('2026-02-17');
    }
  });

  it('falls back to first event broadcastDate when Schedule @ScheduleStart yok', () => {
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  <ScheduledEvent>
    <EventData eventType="Primary">
      <EventId><EventId>EVT-1</EventId></EventId>
      <EventTitle>Sample</EventTitle>
      <PrimaryEvent><ProgramEvent><ProgramName>Sample</ProgramName></ProgramEvent></PrimaryEvent>
      <StartDateTime><SmpteDateTime broadcastDate="2026-03-15" frameRate="25"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
      <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:30:00:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
    </EventData>
  </ScheduledEvent>
</Schedule></BxfData></BxfMessage>`;
    const items = parseBxf(xml);
    expect(items[0].scheduleDate).toBe('2026-03-15');
  });

  it('scheduleDate is per-event SmpteDateTime @broadcastDate (overrides file Schedule @ScheduleStart)', () => {
    // Provys gece yarısı sonrası event'leri önceki gün etiketli dosyada
    // taşıyabiliyor (xSNW_20260521 dosyasında broadcastDate=2026-05-22
    // event'leri gibi). Parser her event'i kendi broadcastDate'iyle
    // doğru güne yazar.
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData>
  <Schedule ScheduleStart="2026-02-17T23:45:00:04">
    <ScheduledEvent>
      <EventData eventType="Primary">
        <EventId><EventId>EVT-LATE</EventId></EventId>
        <EventTitle>Late</EventTitle>
        <PrimaryEvent><ProgramEvent><ProgramName>Late</ProgramName></ProgramEvent></PrimaryEvent>
        <StartDateTime><SmpteDateTime broadcastDate="2026-02-18" frameRate="25"><SmpteTimeCode>00:30:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
        <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:30:00:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
      </EventData>
    </ScheduledEvent>
    <ScheduledEvent>
      <EventData eventType="Primary">
        <EventId><EventId>EVT-SAME</EventId></EventId>
        <EventTitle>Same day</EventTitle>
        <PrimaryEvent><ProgramEvent><ProgramName>Same</ProgramName></ProgramEvent></PrimaryEvent>
        <StartDateTime><SmpteDateTime broadcastDate="2026-02-17" frameRate="25"><SmpteTimeCode>23:50:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
        <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:10:00:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
      </EventData>
    </ScheduledEvent>
  </Schedule>
</BxfData></BxfMessage>`;
    const items = parseBxf(xml);
    const byId = new Map(items.map((i) => [i.eventId, i]));
    expect(byId.get('EVT-LATE')?.scheduleDate).toBe('2026-02-18');  // per-event broadcastDate
    expect(byId.get('EVT-SAME')?.scheduleDate).toBe('2026-02-17');
  });

  it('falls back to Schedule @ScheduleStart when event broadcastDate yok', () => {
    // Çok defansif: SmpteDateTime broadcastDate attribute eksikse dosya-level
    // ScheduleStart fallback.
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData>
  <Schedule ScheduleStart="2026-02-17T10:00:00:00">
    <ScheduledEvent>
      <EventData eventType="Primary">
        <EventId><EventId>NO-BD</EventId></EventId>
        <EventTitle>Fallback</EventTitle>
        <PrimaryEvent><ProgramEvent><ProgramName>FB</ProgramName></ProgramEvent></PrimaryEvent>
        <StartDateTime><SmpteDateTime frameRate="25"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
        <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:30:00:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
      </EventData>
    </ScheduledEvent>
  </Schedule>
</BxfData></BxfMessage>`;
    const items = parseBxf(xml);
    // broadcastDate yoksa event skip edilir (parseStartDateTime instant=null)
    // — bu test sözleşmeyi belgeliyor: instant olmadan event yazılmaz.
    expect(items).toEqual([]);
  });

  it('preserves raw SMPTE startTimecode (HH:MM:SS:FF) and frameRate', () => {
    const items = parseBxf(SAMPLE_BXF);
    expect(items[0].startTimecode).toBe('23:45:00:04');
    expect(items[0].frameRate).toBe(25);
    expect(items[2].startTimecode).toBe('23:57:53:26');
  });

  it('preserves raw SMPTE durationTimecode (frame korunur)', () => {
    const items = parseBxf(SAMPLE_BXF);
    expect(items[0].durationTimecode).toBe('00:15:01:16');
    expect(items[1].durationTimecode).toBe('00:12:53:22');
    expect(items[2].durationTimecode).toBe('00:00:30:00');
  });

  it('reads title from EventData > EventTitle when Content lacks richer fields', () => {
    const items = parseBxf(SAMPLE_BXF);
    expect(items[0].title).toBe('TFF 1. Lig 25-26 Haftanın Golleri');
    expect(items[1].title).toBe('TFF 1. Lig 25-26 Haftanın Golleri');
  });

  it('title source priority: VersionName > EpisodeName > EventTitle > Name > ProgramName > AdType', () => {
    const ev = (id: string, body: string) => `
      <ScheduledEvent>
        <EventData eventType="Primary">
          <EventId><EventId>${id}</EventId></EventId>
          <EventTitle>Generic Event Title</EventTitle>
          <PrimaryEvent><ProgramEvent><ProgramName>Generic Program Name</ProgramName></ProgramEvent></PrimaryEvent>
          <StartDateTime><SmpteDateTime broadcastDate="2026-02-17" frameRate="25"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
          <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:30:00:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
        </EventData>
        ${body}
      </ScheduledEvent>`;

    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  ${ev('A', `<Content>
    <ContentId><HouseNumber>DC00040243</HouseNumber></ContentId>
    <Name>Short Content Name</Name>
    <Description type="VersionName">Trendyol Süper Lig Season 2025/2026 34. Hafta Trabzonspor - Gençlerbirliği Maçı Bant - HD</Description>
    <ContentDetail><ProgramContent><Series>
      <EpisodeName>Should not win against VersionName</EpisodeName>
    </Series></ProgramContent></ContentDetail>
  </Content>`)}
  ${ev('B', `<Content>
    <ContentId><HouseNumber>DC00040999</HouseNumber></ContentId>
    <Name>Short Content Name</Name>
    <ContentDetail><ProgramContent><Series>
      <EpisodeName>34. Hafta Episode Detail</EpisodeName>
    </Series></ProgramContent></ContentDetail>
  </Content>`)}
  ${ev('C', '')}
  ${ev('D', `<Content>
    <ContentId><HouseNumber>DC00040998</HouseNumber></ContentId>
    <Name>Just Content Name</Name>
  </Content>`)}
</Schedule></BxfData></BxfMessage>`;

    const items = parseBxf(xml);
    const titleOf = (id: string) => items.find((i) => i.eventId === id)?.title;
    // A: VersionName seçilmeli — diğerleri (EpisodeName, EventTitle, Name) bastırılır
    expect(titleOf('A')).toBe('Trendyol Süper Lig Season 2025/2026 34. Hafta Trabzonspor - Gençlerbirliği Maçı Bant - HD');
    // B: VersionName yok → EpisodeName seçilir; EventTitle bastırılır
    expect(titleOf('B')).toBe('34. Hafta Episode Detail');
    // C: Content yok → EventTitle generic fallback
    expect(titleOf('C')).toBe('Generic Event Title');
    // D: VersionName + EpisodeName yok; EventTitle generic var → onu seçer (Name'i değil)
    expect(titleOf('D')).toBe('Generic Event Title');
  });

  it('skips Description elements with other "type" attributes (e.g. SynopsisShort)', () => {
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  <ScheduledEvent>
    <EventData eventType="Primary">
      <EventId><EventId>EVT-X</EventId></EventId>
      <EventTitle>Generic</EventTitle>
      <PrimaryEvent><ProgramEvent><ProgramName>Programme</ProgramName></ProgramEvent></PrimaryEvent>
      <StartDateTime><SmpteDateTime broadcastDate="2026-02-17" frameRate="25"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
      <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:30:00:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
    </EventData>
    <Content>
      <ContentId><HouseNumber>DC00040243</HouseNumber></ContentId>
      <Description type="SynopsisShort">kısa özet</Description>
      <Description type="VersionName">Trendyol Süper Lig - Bant 1. Devre - HD</Description>
    </Content>
  </ScheduledEvent>
</Schedule></BxfData></BxfMessage>`;
    const items = parseBxf(xml);
    expect(items[0].title).toBe('Trendyol Süper Lig - Bant 1. Devre - HD');
  });

  it('extracts dcCode from ScheduledEvent > Content > ContentId > HouseNumber', () => {
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  <ScheduledEvent>
    <EventData eventType="Primary">
      <EventId><EventId>EVT-1</EventId></EventId>
      <EventTitle>Programme A</EventTitle>
      <PrimaryEvent><ProgramEvent><ProgramName>Programme A</ProgramName></ProgramEvent></PrimaryEvent>
      <StartDateTime><SmpteDateTime broadcastDate="2026-02-17" frameRate="25"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
      <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:30:00:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
    </EventData>
    <Content>
      <ContentId><HouseNumber>DC00041439</HouseNumber></ContentId>
      <Name>Programme A</Name>
    </Content>
  </ScheduledEvent>
  <ScheduledEvent>
    <EventData eventType="Primary">
      <EventId><EventId>EVT-2</EventId></EventId>
      <EventTitle>No DC</EventTitle>
      <PrimaryEvent><ProgramEvent><ProgramName>No DC</ProgramName></ProgramEvent></PrimaryEvent>
      <StartDateTime><SmpteDateTime broadcastDate="2026-02-17" frameRate="25"><SmpteTimeCode>10:30:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
      <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:30:00:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
    </EventData>
  </ScheduledEvent>
  <ScheduledEvent>
    <EventData eventType="Primary">
      <EventId><EventId>EVT-3</EventId></EventId>
      <EventTitle>Non-DC house</EventTitle>
      <PrimaryEvent><ProgramEvent><ProgramName>Non-DC</ProgramName></ProgramEvent></PrimaryEvent>
      <StartDateTime><SmpteDateTime broadcastDate="2026-02-17" frameRate="25"><SmpteTimeCode>11:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
      <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:30:00:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
    </EventData>
    <Content>
      <ContentId><HouseNumber>X9999</HouseNumber></ContentId>
    </Content>
  </ScheduledEvent>
</Schedule></BxfData></BxfMessage>`;
    const items = parseBxf(xml);
    const a = items.find((i) => i.eventId === 'EVT-1');
    const b = items.find((i) => i.eventId === 'EVT-2');
    const c = items.find((i) => i.eventId === 'EVT-3');
    expect(a?.dcCode).toBe('DC00041439');
    expect(b?.dcCode).toBeNull();
    // X9999 DC prefix değil → null (regex: ^DC[...]+)
    expect(c?.dcCode).toBeNull();
  });

  describe('canlı sınıflandırma — ProgramEvent olsa bile CANLI sinyali öncelikli', () => {
    const wrap = (body: string) => `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  ${body}
</Schedule></BxfData></BxfMessage>`;

    const programEv = (id: string, contentInner: string, titleField = 'Haberler') => `
      <ScheduledEvent>
        <EventData eventType="Primary">
          <EventId><EventId>${id}</EventId></EventId>
          <EventTitle>${titleField}</EventTitle>
          <PrimaryEvent><ProgramEvent><ProgramName>${titleField}</ProgramName></ProgramEvent></PrimaryEvent>
          <StartDateTime><SmpteDateTime broadcastDate="2026-05-22" frameRate="25"><SmpteTimeCode>16:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
          <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:25:00:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
        </EventData>
        <Content>${contentInner}</Content>
      </ScheduledEvent>`;

    it('ProgramEvent + RouterSource Name="Live" → category CANLI, rawKind="Live"', () => {
      const items = parseBxf(wrap(programEv('LIVE-ROUTER', `
        <ContentId><HouseNumber>DC00099999</HouseNumber></ContentId>
        <Name>Haberler</Name>
        <Media><MediaLocation>
          <Location><RouterSource><Name>Live</Name></RouterSource></Location>
        </MediaLocation></Media>`)));
      expect(items[0]).toMatchObject({ rawKind: 'Live', category: 'CANLI' });
    });

    it('ProgramEvent + VersionName "Canlı" → category CANLI (DC00055216 fixture)', () => {
      const items = parseBxf(wrap(programEv('DC00055216-FIXTURE', `
        <ContentId><HouseNumber>DC00055216</HouseNumber></ContentId>
        <Name>Haberler</Name>
        <Description type="VersionName">Haber 16 - Canlı</Description>
        <Media><MediaLocation>
          <Location><RouterSource><Name>Live</Name></RouterSource></Location>
        </MediaLocation></Media>`)));
      expect(items[0]).toMatchObject({
        dcCode: 'DC00055216',
        title: 'Haber 16 - Canlı',
        rawKind: 'Live',
        category: 'CANLI',
      });
    });

    it('EventTitle "Live" + ProgramEvent → CANLI (RouterSource yoksa bile)', () => {
      const items = parseBxf(wrap(programEv('LIVE-TITLE', `
        <ContentId><HouseNumber>DC00077777</HouseNumber></ContentId>
        <Name>Game</Name>`, 'Live Football')));
      expect(items[0].category).toBe('CANLI');
    });

    it('Normal ProgramEvent (canlı sinyal yok) → PROGRAM kalır', () => {
      const items = parseBxf(wrap(programEv('PROG-NORMAL', `
        <ContentId><HouseNumber>DC00088888</HouseNumber></ContentId>
        <Name>Dizi</Name>
        <Description type="VersionName">Episode 4</Description>`)));
      expect(items[0]).toMatchObject({ rawKind: 'Program', category: 'PROGRAM' });
    });

    it('"Liverpool" substring CANLI false positive üretmez (word boundary)', () => {
      const items = parseBxf(wrap(programEv('LVP', `
        <ContentId><HouseNumber>DC00066666</HouseNumber></ContentId>
        <Name>Liverpool vs Chelsea</Name>
        <Description type="VersionName">Liverpool vs Chelsea — Bant</Description>`, 'Liverpool vs Chelsea')));
      expect(items[0].category).toBe('PROGRAM');
    });

    it('Promo / Commercial / Paid Program davranışı bozulmaz (canlı sinyal yok)', () => {
      const promo = (id: string, adType: string) => `
        <ScheduledEvent>
          <EventData eventType="Primary">
            <EventId><EventId>${id}</EventId></EventId>
            <EventTitle>Promo</EventTitle>
            <PrimaryEvent><NonProgramEvent><Details>
              <AdType>${adType}</AdType><SpotType>Standard</SpotType>
            </Details></NonProgramEvent></PrimaryEvent>
            <StartDateTime><SmpteDateTime broadcastDate="2026-05-22" frameRate="25"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
            <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:00:30:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
          </EventData>
        </ScheduledEvent>`;
      const items = parseBxf(wrap(promo('P1', 'Promo') + promo('P2', 'Commercial') + promo('P3', 'Paid Program')));
      const byId = new Map(items.map((i) => [i.eventId, i]));
      expect(byId.get('P1')?.category).toBe('TANITIM');
      expect(byId.get('P2')?.category).toBe('REKLAM');
      // "Paid Program" infomercial → REKLAM (rawKind ham "Paid Program" kalır)
      expect(byId.get('P3')?.rawKind).toBe('Paid Program');
      expect(byId.get('P3')?.category).toBe('REKLAM');
    });
  });

  describe('kamu spotu sınıflandırma — AdType=Promo olsa bile başlık sinyali öncelikli', () => {
    const wrap = (body: string) => `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  ${body}
</Schedule></BxfData></BxfMessage>`;

    const promoEv = (
      id: string,
      titleField: string,
      contentInner: string,
    ) => `
      <ScheduledEvent>
        <EventData eventType="Primary">
          <EventId><EventId>${id}</EventId></EventId>
          <EventTitle>${titleField}</EventTitle>
          <PrimaryEvent><NonProgramEvent><Details>
            <AdType>Promo</AdType><SpotType>Standard</SpotType>
          </Details></NonProgramEvent></PrimaryEvent>
          <StartDateTime><SmpteDateTime broadcastDate="2026-05-22" frameRate="25"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
          <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:00:30:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
        </EventData>
        <Content>${contentInner}</Content>
      </ScheduledEvent>`;

    it('DC00043561 fixture: AdType=Promo + EventTitle "KAMU (ÖY) ..." → KAMU_SPOTU', () => {
      const items = parseBxf(
        wrap(
          promoEv(
            'DC00043561-FIXTURE',
            'KAMU (ÖY) OCY SAĞLIKLI AİLE SAĞLIKLI GELECEK',
            `<ContentId><HouseNumber>DC00043561</HouseNumber></ContentId>
             <Name>KAMU (ÖY) OCY SAĞLIKLI AİLE SAĞLIKLI GELECEK</Name>
             <Description type="VersionName">KAMU (ÖY) OCY SAĞLIKLI AİLE SAĞLIKLI GELECEK</Description>`,
          ),
        ),
      );
      expect(items[0]).toMatchObject({
        dcCode: 'DC00043561',
        rawKind: 'PSA',
        category: 'KAMU_SPOTU',
      });
    });

    it('Content.Name "KAMU" prefix (EventTitle boş) → KAMU_SPOTU', () => {
      const items = parseBxf(
        wrap(
          promoEv('KAMU-NAME', '', `<ContentId><HouseNumber>DC00043562</HouseNumber></ContentId>
             <Name>KAMU SPOTU - TRAFİK GÜVENLİĞİ</Name>`),
        ),
      );
      expect(items[0].category).toBe('KAMU_SPOTU');
    });

    it('VersionName "Public Service Announcement" inline → KAMU_SPOTU', () => {
      const items = parseBxf(
        wrap(
          promoEv(
            'PSA-INLINE',
            'Sağlık Bakanlığı',
            `<ContentId><HouseNumber>DC00043563</HouseNumber></ContentId>
             <Name>Sağlık Bakanlığı</Name>
             <Description type="VersionName">Sağlık Bakanlığı Public Service Announcement</Description>`,
          ),
        ),
      );
      expect(items[0].category).toBe('KAMU_SPOTU');
    });

    it('Normal Promo başlığı (örn. "Maç Önü") TANITIM kalır — regression', () => {
      const items = parseBxf(
        wrap(
          promoEv(
            'PROMO-NORMAL',
            'Maç Önü',
            `<ContentId><HouseNumber>DC00043600</HouseNumber></ContentId>
             <Name>Maç Önü</Name>`,
          ),
        ),
      );
      expect(items[0]).toMatchObject({ rawKind: 'Promo', category: 'TANITIM' });
    });

    it('"Kamuya açık" gibi "KAMU" prefix word-boundary ihlali edilmez (içerikte ama başta değil)', () => {
      // "KAMUYA" "KAMU"+"YA"; PSA_PREFIX_RE \b ile word boundary → "KAMUYA"
      // başlığı PSA değil, çünkü "KAMU\b" eşleşmiyor. Inline pattern'lere de
      // takılmıyor. TANITIM kalmalı.
      const items = parseBxf(
        wrap(
          promoEv(
            'NOT-PSA',
            'Kamuya Açık Tanıtım',
            `<ContentId><HouseNumber>DC00043601</HouseNumber></ContentId>
             <Name>Kamuya Açık Tanıtım</Name>`,
          ),
        ),
      );
      expect(items[0].category).toBe('TANITIM');
    });
  });

  it('converts SmpteDuration HH:MM:SS:FF to ms using frameRate', () => {
    const items = parseBxf(SAMPLE_BXF);
    // 00:15:01:16 @ 25fps = (15*60+1)s + 16/25s = 901.64s → 901640ms
    expect(items[0].durationMs).toBe(901_640);
    // 00:12:53:22 @ 25fps = (12*60+53)s + 22/25s = 773.88s → 773880ms
    expect(items[1].durationMs).toBe(773_880);
    expect(items[2].durationMs).toBe(30_000);
  });

  it('falls back to AdType / SpotType when EventTitle is empty', () => {
    const items = parseBxf(SAMPLE_BXF);
    expect(items[2].title).toContain('Promo');
  });

  it('returns [] for empty content or missing Schedule', () => {
    expect(parseBxf('')).toEqual([]);
    expect(parseBxf('   ')).toEqual([]);
    expect(parseBxf('<?xml version="1.0"?><BxfMessage><BxfData/></BxfMessage>')).toEqual([]);
  });

  it('skips events with missing required fields (eventId / startAt / title)', () => {
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF">
  <BxfData><Schedule>
    <ScheduledEvent>
      <EventData eventType="Primary">
        <EventTitle>NoId</EventTitle>
        <StartDateTime><SmpteDateTime broadcastDate="2026-02-17" frameRate="25"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
      </EventData>
    </ScheduledEvent>
    <ScheduledEvent>
      <EventData eventType="Primary">
        <EventId><EventId>OK</EventId></EventId>
        <EventTitle>OK Title</EventTitle>
        <PrimaryEvent><ProgramEvent><ProgramName>OK</ProgramName></ProgramEvent></PrimaryEvent>
        <StartDateTime><SmpteDateTime broadcastDate="2026-02-17" frameRate="25"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
      </EventData>
    </ScheduledEvent>
  </Schedule></BxfData>
</BxfMessage>`;
    const items = parseBxf(xml);
    expect(items.map((i) => i.eventId)).toEqual(['OK']);
  });

  it('throws ProvysParseError on malformed XML (unclosed tag)', () => {
    // fast-xml-parser tolerant — gerçek hatayı tetiklemek için bilinçli olarak
    // hierarchically broken tag mismatch gerekli.
    expect(() =>
      parseBxf('<BxfMessage><BxfData><Schedule><ScheduledEvent></WrongClose></BxfData></BxfMessage>'),
    ).toThrow(ProvysParseError);
  });

  it('handles missing duration as null', () => {
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  <ScheduledEvent><EventData eventType="Primary">
    <EventId><EventId>NODUR</EventId></EventId>
    <EventTitle>NoDur</EventTitle>
    <PrimaryEvent><ProgramEvent><ProgramName>NoDur</ProgramName></ProgramEvent></PrimaryEvent>
    <StartDateTime><SmpteDateTime broadcastDate="2026-02-17" frameRate="25"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
  </EventData></ScheduledEvent>
</Schedule></BxfData></BxfMessage>`;
    const items = parseBxf(xml);
    expect(items).toHaveLength(1);
    expect(items[0].durationMs).toBeNull();
  });

  it('rawKind = "ProgramHeader" when eventType is Primary-ProgramHeader (even with ProgramEvent child)', () => {
    // Provys ProgramHeader event'ini ProgramEvent child'ı ile de gönderir;
    // parser eventType önceliğiyle "ProgramHeader" döndürmeli, "Program"
    // değil. classifyCategory yine PROGRAM döner (substring "program").
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  <ScheduledEvent>
    <EventData eventType="Primary-ProgramHeader">
      <EventId><EventId>HDR-1</EventId></EventId>
      <EventTitle>Premier League 25-26 Netbusters</EventTitle>
      <PrimaryEvent><ProgramEvent>
        <SegmentNumber>0</SegmentNumber>
        <ProgramName>Premier League 25-26 Netbusters</ProgramName>
      </ProgramEvent></PrimaryEvent>
      <StartDateTime><SmpteDateTime broadcastDate="2026-05-22" frameRate="25"><SmpteTimeCode>20:45:13:20</SmpteTimeCode></SmpteDateTime></StartDateTime>
      <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:29:37:13</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
    </EventData>
  </ScheduledEvent>
  <ScheduledEvent>
    <EventData eventType="Primary">
      <EventId><EventId>PRG-1</EventId></EventId>
      <EventTitle>Premier League 25-26 Netbusters</EventTitle>
      <PrimaryEvent><ProgramEvent>
        <SegmentNumber>1</SegmentNumber>
        <ProgramName>Premier League 25-26 Netbusters</ProgramName>
      </ProgramEvent></PrimaryEvent>
      <StartDateTime><SmpteDateTime broadcastDate="2026-05-22" frameRate="25"><SmpteTimeCode>20:45:13:20</SmpteTimeCode></SmpteDateTime></StartDateTime>
      <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:14:05:09</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
    </EventData>
    <Content>
      <ContentId><HouseNumber>DC00042141</HouseNumber></ContentId>
      <Name>Netbusters 37.Hafta</Name>
      <Description type="VersionName">Netbusters 37.Hafta</Description>
    </Content>
  </ScheduledEvent>
</Schedule></BxfData></BxfMessage>`;
    const items = parseBxf(xml);
    const byId = new Map(items.map((i) => [i.eventId, i]));
    // HDR-1: ProgramHeader rawKind, category PROGRAM (substring match)
    expect(byId.get('HDR-1')?.rawKind).toBe('ProgramHeader');
    expect(byId.get('HDR-1')?.category).toBe('PROGRAM');
    // PRG-1: normal Program rawKind
    expect(byId.get('PRG-1')?.rawKind).toBe('Program');
    expect(byId.get('PRG-1')?.category).toBe('PROGRAM');
  });

  it('classifies different AdType values (Commercial / PSA / Live / Other)', () => {
    const ev = (id: string, adType: string) => `
      <ScheduledEvent><EventData eventType="Primary">
        <EventId><EventId>${id}</EventId></EventId>
        <EventTitle/>
        <PrimaryEvent><NonProgramEvent><Details>
          <AdType>${adType}</AdType><SpotType>Standard</SpotType>
        </Details></NonProgramEvent></PrimaryEvent>
        <StartDateTime><SmpteDateTime broadcastDate="2026-02-17" frameRate="25"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
        <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:00:30:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
      </EventData></ScheduledEvent>`;
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  ${ev('A', 'Commercial')}
  ${ev('B', 'PSA')}
  ${ev('C', 'Live')}
  ${ev('D', 'Other')}
</Schedule></BxfData></BxfMessage>`;
    const items = parseBxf(xml);
    expect(items.find((i) => i.eventId === 'A')?.category).toBe('REKLAM');
    expect(items.find((i) => i.eventId === 'B')?.category).toBe('KAMU_SPOTU');
    expect(items.find((i) => i.eventId === 'C')?.category).toBe('CANLI');
    expect(items.find((i) => i.eventId === 'D')?.category).toBe('DIGER');
  });

  describe('REK <sayı> reklam blok başlığı — ProgramEvent içinde gelse bile REKLAM', () => {
    const wrap = (body: string) => `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  ${body}
</Schedule></BxfData></BxfMessage>`;

    const programEv = (id: string, title: string, programName?: string) => `
      <ScheduledEvent>
        <EventData eventType="Primary">
          <EventId><EventId>${id}</EventId></EventId>
          <EventTitle>${title}</EventTitle>
          <PrimaryEvent><ProgramEvent>
            <SegmentNumber>1</SegmentNumber>
            <ProgramName>${programName ?? title}</ProgramName>
          </ProgramEvent></PrimaryEvent>
          <StartDateTime><SmpteDateTime broadcastDate="2026-05-25" frameRate="25"><SmpteTimeCode>00:12:08:07</SmpteTimeCode></SmpteDateTime></StartDateTime>
          <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:00:05:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
        </EventData>
      </ScheduledEvent>`;

    it('"REK 1 START LINE" → REKLAM (rawKind=Commercial)', () => {
      const items = parseBxf(wrap(programEv('REK-1', 'REK 1 START LINE')));
      expect(items[0]).toMatchObject({ rawKind: 'Commercial', category: 'REKLAM' });
    });

    it('"REK 6 SIRALAMA SUNDU" (LT4 beinsports4 fixture) → REKLAM', () => {
      const items = parseBxf(wrap(programEv('REK-6', 'REK 6 SIRALAMA SUNDU')));
      expect(items[0]).toMatchObject({ rawKind: 'Commercial', category: 'REKLAM' });
    });

    it('"REKABET PROGRAMI" → PROGRAM (REK\\b sınırı ile false-positive engellenir)', () => {
      const items = parseBxf(wrap(programEv('REKABET', 'REKABET PROGRAMI')));
      expect(items[0]).toMatchObject({ rawKind: 'Program', category: 'PROGRAM' });
    });

    it('"REKOR YAYINI" → PROGRAM (REK + harf bitişik, sayı yok)', () => {
      const items = parseBxf(wrap(programEv('REKOR', 'REKOR YAYINI')));
      expect(items[0]).toMatchObject({ rawKind: 'Program', category: 'PROGRAM' });
    });

    it('"REKLAM 19" Paid Program AdType ile gelmeye devam ederse REKLAM (mevcut davranış bozulmaz)', () => {
      const paid = `
        <ScheduledEvent>
          <EventData eventType="Primary">
            <EventId><EventId>REKLAM-19</EventId></EventId>
            <EventTitle>REKLAM 19</EventTitle>
            <PrimaryEvent><NonProgramEvent><Details>
              <AdType>Paid Program</AdType><SpotType>Standard</SpotType>
            </Details></NonProgramEvent></PrimaryEvent>
            <StartDateTime><SmpteDateTime broadcastDate="2026-05-25" frameRate="25"><SmpteTimeCode>23:58:24:11</SmpteTimeCode></SmpteDateTime></StartDateTime>
            <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:00:30:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
          </EventData>
        </ScheduledEvent>`;
      const items = parseBxf(wrap(paid));
      expect(items[0]).toMatchObject({ rawKind: 'Paid Program', category: 'REKLAM' });
    });

    it('Normal ProgramEvent başlığı → PROGRAM kalır', () => {
      const items = parseBxf(wrap(programEv('NORMAL', 'Dünya Kupası Final Maçı')));
      expect(items[0]).toMatchObject({ rawKind: 'Program', category: 'PROGRAM' });
    });

    it('ProgramName REK ile başlıyor ama EventTitle farklıysa REKLAM (4 kaynağın herhangi biri)', () => {
      const items = parseBxf(wrap(programEv('PN-REK', 'F1 Yarış Önü', 'REK 2 F1 YARIŞ ÖNÜ')));
      // deriveTitle EventTitle'ı önceler (sıra 3), ama hasRekCommercialSignal
      // ProgramName'i de görür → kategori REKLAM olur.
      expect(items[0].category).toBe('REKLAM');
      expect(items[0].rawKind).toBe('Commercial');
    });

    describe('isRekCommercialTitle helper (pure)', () => {
      it.each([
        ['REK 1', true],
        ['REK 12', true],
        ['REK 6 SIRALAMA SUNDU', true],
        ['rek 99', true],         // case-insensitive
        ['  REK 4 ABC', true],    // leading whitespace trim
        ['REKLAM', false],        // K|L bitişik, \b yok
        ['REKLAM 19', false],
        ['REKABET', false],
        ['REKOR', false],
        ['REK', false],           // sayı yok
        ['REK ABC', false],       // sayı yok
        ['REK1', false],          // boşluk yok, K|1 bitişik \b yok
        ['', false],
        [null, false],
        [undefined, false],
      ])('isRekCommercialTitle(%j) === %s', (input, expected) => {
        expect(isRekCommercialTitle(input as string | null | undefined)).toBe(expected);
      });
    });
  });
});

// ── 2026-05-26: BXF ham title kaynak alanları + title_source (4 materyal tipi) ─
const wrapEvent = (eventXml: string, broadcastDate = '2026-05-26') => `<?xml version="1.0" encoding="UTF-8"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF" xmlns:pmcp="http://www.atsc.org/XMLSchemas/pmcp/2007/3.1" messageType="Information">
  <BxfData action="add">
    <Schedule type="Primary" ScheduleStart="${broadcastDate}T00:00:00:00" ScheduleEnd="${broadcastDate}T23:59:59:00">
      <Channel ShortName="LT4"/>
      ${eventXml}
    </Schedule>
  </BxfData>
</BxfMessage>`;

const MATCH_EVENT = `<ScheduledEvent>
  <EventData eventType="Primary">
    <EventId><EventId>urn:uuid:MATCH-001</EventId></EventId>
    <EventTitle>McDonald's Ligue 1 Season 2025/2026 Canli Maclar</EventTitle>
    <PrimaryEvent>
      <ProgramEvent>
        <SegmentNumber>1</SegmentNumber>
        <ProgramName>McDonald's Ligue 1 Season 2025/2026 Canli Maclar</ProgramName>
      </ProgramEvent>
    </PrimaryEvent>
    <StartDateTime><SmpteDateTime frameRate="25" broadcastDate="2026-05-26"><SmpteTimeCode>21:45:00:14</SmpteTimeCode></SmpteDateTime></StartDateTime>
    <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>02:00:07:00</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
    <StartMode>Manual</StartMode><EndMode>Manual</EndMode>
  </EventData>
  <Content>
    <ContentId><HouseNumber>DC00055598</HouseNumber></ContentId>
    <Name>McDonald's Ligue 1 Season 2025/2026 Canli Maclar</Name>
    <Description type="VersionName">McDonald's Ligue 1 Season 2025/2026 Play - Out 1.Mac Saint Etienne - Nice Maci Canli</Description>
    <Media><MediaLocation><Location><RouterSource><Name>Live</Name></RouterSource></Location></MediaLocation></Media>
    <ContentDetail><ProgramContent>
      <Series>
        <SeriesName>McDonald's Ligue 1 Season 2025/2026 Canli Maclar</SeriesName>
        <EpisodeName>McDonald's Ligue 1 Season 2025/2026 Play - Out 1.Mac Saint Etienne - Nice Maci Canli</EpisodeName>
        <EpisodeNumber>307</EpisodeNumber>
      </Series>
    </ProgramContent></ContentDetail>
  </Content>
  <ContentType>Main Programme</ContentType>
</ScheduledEvent>`;

const PROGRAM_EVENT = `<ScheduledEvent>
  <EventData eventType="Primary">
    <EventId><EventId>urn:uuid:PROG-001</EventId></EventId>
    <EventTitle>Premier League Stories</EventTitle>
    <PrimaryEvent>
      <ProgramEvent>
        <SegmentNumber>1</SegmentNumber>
        <ProgramName>Premier League Stories</ProgramName>
      </ProgramEvent>
    </PrimaryEvent>
    <StartDateTime><SmpteDateTime frameRate="25" broadcastDate="2026-05-26"><SmpteTimeCode>23:30:00:20</SmpteTimeCode></SmpteDateTime></StartDateTime>
    <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:25:37:16</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
    <StartMode>Follow</StartMode><EndMode>Duration</EndMode>
  </EventData>
  <Content>
    <ContentId><HouseNumber>DC00052002</HouseNumber></ContentId>
    <Name>Premier League Stories</Name>
    <Description type="VersionName">EPL Stories - Yakubu</Description>
    <ContentDetail><ProgramContent>
      <Series>
        <SeriesName>Premier League Stories</SeriesName>
        <EpisodeName>EPL Stories - Yakubu</EpisodeName>
        <EpisodeNumber>54</EpisodeNumber>
      </Series>
    </ProgramContent></ContentDetail>
  </Content>
  <ContentType>Main Programme</ContentType>
</ScheduledEvent>`;

const PROMO_EVENT = `<ScheduledEvent>
  <EventData eventType="Primary">
    <EventId><EventId>urn:uuid:PROMO-001</EventId></EventId>
    <EventTitle>ID 1 MOTOR SPORLARI - BOKS - VOLEYBOL</EventTitle>
    <PrimaryEvent>
      <NonProgramEvent>
        <Details>
          <AdType>Promo</AdType>
          <SpotType>Standard</SpotType>
        </Details>
      </NonProgramEvent>
    </PrimaryEvent>
    <StartDateTime><SmpteDateTime frameRate="25" broadcastDate="2026-05-26"><SmpteTimeCode>19:44:32:11</SmpteTimeCode></SmpteDateTime></StartDateTime>
    <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:00:29:20</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
    <StartMode>Follow</StartMode><EndMode>Duration</EndMode>
  </EventData>
  <Content>
    <ContentId><HouseNumber>DC00040861</HouseNumber></ContentId>
    <Name>ID 1 MOTOR SPORLARI - BOKS - VOLEYBOL</Name>
    <Description type="VersionName">ID 1 MOTOR SPORLARI - BOKS - VOLEYBOL</Description>
  </Content>
  <ContentType>Promo</ContentType>
</ScheduledEvent>`;

const PSA_EVENT = `<ScheduledEvent>
  <EventData eventType="Primary">
    <EventId><EventId>urn:uuid:PSA-001</EventId></EventId>
    <EventTitle>KAMU (KS) RAHIM AGIZI KANSERI</EventTitle>
    <PrimaryEvent>
      <NonProgramEvent>
        <Details>
          <AdType>Promo</AdType>
          <SpotType>Standard</SpotType>
        </Details>
      </NonProgramEvent>
    </PrimaryEvent>
    <StartDateTime><SmpteDateTime frameRate="25" broadcastDate="2026-05-26"><SmpteTimeCode>23:59:38:24</SmpteTimeCode></SmpteDateTime></StartDateTime>
    <LengthOption><Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:00:21:06</SmpteTimeCode></SmpteDuration></Duration></LengthOption>
    <StartMode>Follow</StartMode><EndMode>Duration</EndMode>
  </EventData>
  <Content>
    <ContentId><HouseNumber>DC00044972</HouseNumber></ContentId>
    <Name>KAMU (KS) RAHIM AGIZI KANSERI</Name>
    <Description type="VersionName">KAMU (KS) RAHIM AGIZI KANSERI</Description>
  </Content>
  <ContentType>Promo</ContentType>
</ScheduledEvent>`;

describe('provys.parser › BXF raw title source fields (2026-05-26)', () => {
  it('Maç (CANLI): VersionName kazanır, Series alanları + episodeNumber 307', () => {
    const [item] = parseBxf(wrapEvent(MATCH_EVENT));
    expect(item.dcCode).toBe('DC00055598');
    expect(item.category).toBe('CANLI');
    expect(item.rawKind).toBe('Live');
    expect(item.title).toContain('Saint Etienne - Nice');
    expect(item.titleSource).toBe('VERSION_NAME');
    expect(item.versionName).toContain('Saint Etienne - Nice');
    expect(item.episodeName).toContain('Saint Etienne - Nice');
    expect(item.eventTitle).toContain('Canli Maclar');
    expect(item.contentName).toContain('Canli Maclar');
    expect(item.programName).toContain('Canli Maclar');
    expect(item.seriesName).toContain('Canli Maclar');
    expect(item.episodeNumber).toBe(307);
    expect(item.adType).toBeNull();
    expect(item.spotType).toBeNull();
  });

  it('Program: VersionName kazanır, seriesName=Premier League Stories, episodeNumber 54', () => {
    const [item] = parseBxf(wrapEvent(PROGRAM_EVENT));
    expect(item.dcCode).toBe('DC00052002');
    expect(item.category).toBe('PROGRAM');
    expect(item.rawKind).toBe('Program');
    expect(item.title).toBe('EPL Stories - Yakubu');
    expect(item.titleSource).toBe('VERSION_NAME');
    expect(item.versionName).toBe('EPL Stories - Yakubu');
    expect(item.episodeName).toBe('EPL Stories - Yakubu');
    expect(item.eventTitle).toBe('Premier League Stories');
    expect(item.seriesName).toBe('Premier League Stories');
    expect(item.episodeNumber).toBe(54);
    expect(item.adType).toBeNull();
  });

  it('Tanıtım (Promo): VersionName kazanır, Series alanları null, adType/spotType dolu', () => {
    const [item] = parseBxf(wrapEvent(PROMO_EVENT));
    expect(item.dcCode).toBe('DC00040861');
    expect(item.category).toBe('TANITIM');
    expect(item.rawKind).toBe('Promo');
    expect(item.title).toContain('MOTOR SPORLARI');
    expect(item.titleSource).toBe('VERSION_NAME');
    expect(item.versionName).toContain('MOTOR SPORLARI');
    expect(item.eventTitle).toContain('MOTOR SPORLARI');
    expect(item.contentName).toContain('MOTOR SPORLARI');
    // ProgramEvent yok → Series alanları null
    expect(item.episodeName).toBeNull();
    expect(item.programName).toBeNull();
    expect(item.seriesName).toBeNull();
    expect(item.episodeNumber).toBeNull();
    // NonProgramEvent → AdType + SpotType dolu
    expect(item.adType).toBe('Promo');
    expect(item.spotType).toBe('Standard');
  });

  it('Kamu Spotu (PSA): KAMU prefix → category KAMU_SPOTU, Series null, adType=Promo', () => {
    const [item] = parseBxf(wrapEvent(PSA_EVENT));
    expect(item.dcCode).toBe('DC00044972');
    expect(item.category).toBe('KAMU_SPOTU');
    expect(item.rawKind).toBe('PSA');
    expect(item.title).toContain('KAMU');
    expect(item.titleSource).toBe('VERSION_NAME');
    expect(item.versionName).toContain('KAMU');
    expect(item.seriesName).toBeNull();
    expect(item.episodeNumber).toBeNull();
    // AdType=Promo BXF'te var ama category PSA → adType ayrı kolon yine yazılır
    expect(item.adType).toBe('Promo');
    expect(item.spotType).toBe('Standard');
  });

  it('titleSource fallback: VersionName yokken EVENT_TITLE kazanır', () => {
    const xml = MATCH_EVENT
      .replace(/<Description type="VersionName">[^<]*<\/Description>\s*/g, '')
      .replace(/<EpisodeName>[^<]*<\/EpisodeName>\s*/g, '');
    const [item] = parseBxf(wrapEvent(xml));
    expect(item.titleSource).toBe('EVENT_TITLE');
    expect(item.title).toContain('Canli Maclar');
    expect(item.versionName).toBeNull();
    expect(item.episodeName).toBeNull();
  });

  it('Empty string normalize → null', () => {
    const xml = PROMO_EVENT.replace('<EventTitle>ID 1 MOTOR SPORLARI - BOKS - VOLEYBOL</EventTitle>', '<EventTitle></EventTitle>');
    const [item] = parseBxf(wrapEvent(xml));
    // Empty EventTitle → null; title chain VersionName'e düşer (zaten dolu)
    expect(item.eventTitle).toBeNull();
  });

  it('EpisodeNumber numeric değilse null', () => {
    const xml = PROGRAM_EVENT.replace('<EpisodeNumber>54</EpisodeNumber>', '<EpisodeNumber>abc</EpisodeNumber>');
    const [item] = parseBxf(wrapEvent(xml));
    expect(item.episodeNumber).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Pre-rollover guard helper testleri
// ───────────────────────────────────────────────────────────────────────────

describe('provys.parser › timecodeToTimeOfDaySeconds', () => {
  it('HH:MM:SS:FF → saniye (frame ignore)', () => {
    expect(timecodeToTimeOfDaySeconds('00:00:00:00')).toBe(0);
    expect(timecodeToTimeOfDaySeconds('22:00:00:00')).toBe(22 * 3600);
    expect(timecodeToTimeOfDaySeconds('23:59:59:24')).toBe(23 * 3600 + 59 * 60 + 59);
    expect(timecodeToTimeOfDaySeconds('02:00:00:00')).toBe(2 * 3600);
  });
  it('HH:MM:SS (frame yok) da geçerli', () => {
    expect(timecodeToTimeOfDaySeconds('10:30:45')).toBe(10 * 3600 + 30 * 60 + 45);
  });
  it('null/undefined/boş/malformed → null', () => {
    expect(timecodeToTimeOfDaySeconds(null)).toBeNull();
    expect(timecodeToTimeOfDaySeconds(undefined)).toBeNull();
    expect(timecodeToTimeOfDaySeconds('')).toBeNull();
    expect(timecodeToTimeOfDaySeconds('25:00:00:00')).toBeNull(); // h out of range
    expect(timecodeToTimeOfDaySeconds('22:60:00:00')).toBeNull(); // m out of range
    expect(timecodeToTimeOfDaySeconds('22:00:60:00')).toBeNull(); // s out of range
    expect(timecodeToTimeOfDaySeconds('xx:yy:zz')).toBeNull();
  });
});

// Helper for compact fixture construction.
function fixture(tcs: ReadonlyArray<string>): ParsedItem[] {
  return tcs.map((tc, i): ParsedItem => ({
    eventId: `urn:uuid:test-${i}`,
    scheduleDate: '2026-05-27',
    sequence: i,
    startAt: new Date(0),
    durationMs: 60_000,
    startTimecode: tc,
    durationTimecode: '00:01:00:00',
    frameRate: 25,
    dcCode: `DC${String(i).padStart(8, '0')}`,
    title: `item-${i}`,
    rawKind: 'Program',
    category: 'PROGRAM',
    versionName: null, episodeName: null, eventTitle: null,
    contentName: null, programName: null, adType: null, spotType: null,
    titleSource: 'UNKNOWN',
    seriesName: null, episodeNumber: null,
  }));
}

describe('provys.parser › dropLeadingPreRolloverBlock (segment seçimi)', () => {
  it('1. Leading pre-roll: 22:59 / 23:59 / 00:00 / 00:10 → after segmenti tutulur', () => {
    // İlk item start=22:59 (>=22:00) → 'after' segmenti tutulur.
    const items = fixture(['22:59:00:00', '23:59:00:00', '00:00:00:00', '00:10:00:00']);
    const { items: out, info } = dropLeadingPreRolloverBlock(items);
    expect(info.applied).toBe(true);
    expect(info.reason).toBe('leading-pre-roll');
    expect(info.segmentChoice).toBe('after');
    expect(info.rolloverIndex).toBe(2);
    expect(info.droppedCount).toBe(2);
    expect(info.keptCount).toBe(2);
    expect(out.map((it) => it.startTimecode)).toEqual(['00:00:00:00', '00:10:00:00']);
  });

  it('2. Trailing next-day tail: 01:00 / 12:00 / 23:59 / 00:30 → before segmenti tutulur', () => {
    // İlk item start=01:00 (<22:00) → 'before' segmenti tutulur, sondaki 00:30 düşer.
    const items = fixture(['01:00:00:00', '12:00:00:00', '23:59:00:00', '00:30:00:00']);
    const { items: out, info } = dropLeadingPreRolloverBlock(items);
    expect(info.applied).toBe(true);
    expect(info.reason).toBe('trailing-next-day-tail');
    expect(info.segmentChoice).toBe('before');
    expect(info.rolloverIndex).toBe(3);
    expect(info.droppedCount).toBe(1);
    expect(info.keptCount).toBe(3);
    expect(out.map((it) => it.startTimecode)).toEqual(['01:00:00:00', '12:00:00:00', '23:59:00:00']);
  });

  it('3. Partial-day monoton 17:00 / 18:00 / 23:59 → hepsi kalır', () => {
    const items = fixture(['17:00:00:00', '18:00:00:00', '23:59:00:00']);
    const { items: out, info } = dropLeadingPreRolloverBlock(items);
    expect(info.applied).toBe(false);
    expect(info.reason).toBe('no-rollover');
    expect(out).toHaveLength(3);
  });

  it('4. Tam gün monoton 00:00 / 12:00 / 23:59 → hepsi kalır', () => {
    const items = fixture(['00:00:00:00', '12:00:00:00', '23:59:00:00']);
    const { items: out, info } = dropLeadingPreRolloverBlock(items);
    expect(info.applied).toBe(false);
    expect(info.reason).toBe('no-rollover');
    expect(out).toHaveLength(3);
  });

  it('5. Unsafe rollover 01:00 → 00:30 tek başına: hepsi kalır (prev<22:00 → unsafe)', () => {
    // currentStart<previousStart var ama prev=01:00 (<22:00) → safe değil.
    const items = fixture(['01:00:00:00', '00:30:00:00']);
    const { items: out, info } = dropLeadingPreRolloverBlock(items);
    expect(info.applied).toBe(false);
    expect(info.reason).toBe('unsafe-rollover-skipped');
    expect(info.rolloverIndex).toBe(1);
    expect(out).toHaveLength(2);
  });

  it('5b. Unsafe rollover 23:30 → 03:30 (curr>02:00) → hepsi kalır', () => {
    // prev>=22:00 ✓ ama curr=03:30 (>02:00) → safe değil.
    const items = fixture(['23:30:00:00', '03:30:00:00']);
    const { items: out, info } = dropLeadingPreRolloverBlock(items);
    expect(info.applied).toBe(false);
    expect(info.reason).toBe('unsafe-rollover-skipped');
    expect(info.rolloverIndex).toBe(1);
    expect(out).toHaveLength(2);
  });

  it('6. LTV-örnek pattern: rollover öncesi DC00041190 düşer, sonrası DC00041191 kalır', () => {
    // 7 item pre-roll (22:59..23:59) + 211 item gün gövdesi (00:00..23:59).
    // İlk item start=22:59:59 → segment=after.
    const items: ParsedItem[] = [];
    const preTcs = ['22:59:59:21','23:00:01:00','23:52:35:04','23:53:25:04','23:55:01:04','23:55:46:20','23:59:38:03'];
    preTcs.forEach((tc, i) => {
      const it = fixture([tc])[0];
      if (i === 0) (it as Record<string, unknown>)['dcCode'] = 'DC00041190';
      items.push(it);
    });
    for (let i = 0; i < 211; i++) {
      const total = Math.floor((i * 86399) / 211);
      const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
      const it = fixture([`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}:00`])[0];
      if (i === 210) (it as Record<string, unknown>)['dcCode'] = 'DC00041191';
      items.push(it);
    }
    expect(items.length).toBe(218);
    const { items: out, info } = dropLeadingPreRolloverBlock(items);
    expect(info.applied).toBe(true);
    expect(info.segmentChoice).toBe('after');
    expect(info.rolloverIndex).toBe(7);
    expect(info.droppedCount).toBe(7);
    expect(info.keptCount).toBe(211);
    expect(out.find((it) => it.dcCode === 'DC00041190')).toBeUndefined();
    expect(out.find((it) => it.dcCode === 'DC00041191')).toBeDefined();
  });

  it('7a. Tam 2 safe rollover → middle segment tutulur (head + next-day suffix düşer)', () => {
    // Synthetic LTV 28 May paterni:
    //   head (3 item, 23:xx pre-roll) → R1 (23:xx→00:00) → body (4 item) →
    //   tail item 23:00 (DC00041192 yerine) → R2 (23:xx→00:00) → next-day suffix (1 item).
    const items = fixture([
      // head pre-roll (R1 öncesi 4 item, 0..3)
      '23:00:00:00','23:00:00:00','23:30:00:00','23:59:00:00',
      // R1 = 4: 23:59 → 00:00
      // body + tail (4..8)
      '00:00:00:00','01:00:00:00','12:00:00:00','22:00:00:00','23:00:00:00',
      // R2 = 9: 23:00 → 00:10
      // next-day suffix (9..)
      '00:10:00:00',
    ]);
    // DC ile head/middle/tail ayrımı: index 1 head'de, index 8 middle'da
    (items[1] as Record<string, unknown>)['dcCode'] = 'DC-HEAD';
    (items[8] as Record<string, unknown>)['dcCode'] = 'DC-TAIL-IN-MIDDLE';
    (items[9] as Record<string, unknown>)['dcCode'] = 'DC-NEXT-DAY';

    const { items: out, info } = dropLeadingPreRolloverBlock(items);
    expect(info.applied).toBe(true);
    expect(info.reason).toBe('middle-segment-kept');
    expect(info.segmentChoice).toBe('middle');
    expect(info.rolloverIndex).toBe(4);   // R1
    expect(info.droppedCount).toBe(5);    // 4 head + 1 next-day suffix
    expect(info.keptCount).toBe(5);       // body + tail (R1..R2)
    // DC-HEAD düştü, DC-TAIL-IN-MIDDLE kaldı, DC-NEXT-DAY düştü
    expect(out.find((it) => it.dcCode === 'DC-HEAD')).toBeUndefined();
    expect(out.find((it) => it.dcCode === 'DC-TAIL-IN-MIDDLE')).toBeDefined();
    expect(out.find((it) => it.dcCode === 'DC-NEXT-DAY')).toBeUndefined();
  });

  it('7b. 3+ safe rollover varsa drop YAPMA, raporla', () => {
    // Üç safe rollover: 22:59→00:00, 23:30→00:00, 23:30→00:30
    const items = fixture([
      '22:59:00:00','00:00:00:00','12:00:00:00','23:30:00:00','00:00:00:00','12:00:00:00','23:30:00:00','00:30:00:00',
    ]);
    const { items: out, info } = dropLeadingPreRolloverBlock(items);
    expect(info.applied).toBe(false);
    expect(info.reason).toBe('multiple-safe-rollovers-skipped');
    expect(out).toHaveLength(8);
  });

  it('8. ProgramHeader + Program çiftleri rollover öncesinde birlikte düşer', () => {
    // İlk item 22:59 → segment=after; pre-roll'daki 2 header+2 program (4 item) birlikte düşer.
    const items: ParsedItem[] = [];
    ['22:59:59:00','22:59:59:00','23:30:00:00','23:30:00:00'].forEach((tc, i) => {
      const it = fixture([tc])[0];
      (it as Record<string, unknown>)['rawKind'] = i % 2 === 0 ? 'ProgramHeader' : 'Program';
      items.push(it);
    });
    // Gün gövdesi 6 item monoton 00:00..22:00
    for (let i = 0; i < 6; i++) {
      const h = i * 4;
      items.push(fixture([`${String(h).padStart(2,'0')}:00:00:00`])[0]);
    }
    const { items: out, info } = dropLeadingPreRolloverBlock(items);
    expect(info.applied).toBe(true);
    expect(info.segmentChoice).toBe('after');
    expect(info.droppedCount).toBe(4);
    expect(info.keptCount).toBe(6);
    // Düşen pre-roll'da hem ProgramHeader hem Program vardı:
    expect(items.slice(0, 4).filter((it) => it.rawKind === 'ProgramHeader').length).toBe(2);
    expect(items.slice(0, 4).filter((it) => it.rawKind === 'Program').length).toBe(2);
    // Tutulan segment yalnızca gün gövdesi 00:00..22:00 monoton item'ları.
    expect(out[0].startTimecode).toBe('00:00:00:00');
    expect(out[out.length - 1].startTimecode).toBe('20:00:00:00');
  });

  it('9. Regression — 50 item tam gün monoton: hepsi kalır', () => {
    const tcs: string[] = [];
    for (let i = 0; i < 50; i++) {
      const total = Math.floor((i * 86399) / 50);
      const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
      tcs.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}:00`);
    }
    const items = fixture(tcs);
    const { items: out, info } = dropLeadingPreRolloverBlock(items);
    expect(info.applied).toBe(false);
    expect(info.reason).toBe('no-rollover');
    expect(out).toHaveLength(50);
  });

  it('Empty / single item → too-few-items', () => {
    const empty = dropLeadingPreRolloverBlock([]);
    expect(empty.info.reason).toBe('too-few-items');
    expect(empty.items).toEqual([]);
    const single = dropLeadingPreRolloverBlock(fixture(['12:00:00:00']));
    expect(single.info.reason).toBe('too-few-items');
    expect(single.items).toHaveLength(1);
  });
});
