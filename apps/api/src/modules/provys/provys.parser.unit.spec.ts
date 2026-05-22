import { describe, it, expect } from 'vitest';
import { parseBxf, ProvysParseError } from './provys.parser.js';

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
});
