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
