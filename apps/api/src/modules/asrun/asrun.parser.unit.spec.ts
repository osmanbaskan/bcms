import { describe, it, expect } from 'vitest';
import { parseAsrunBxf, AsrunParseError } from './asrun.parser.js';

const SINGLE = `<?xml version="1.0" encoding="utf-8"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF" xmlns:ext="http://smpte-ra.org/schemas/2021/2017/BXF/Extension" ext:usage="AsRun">
  <BxfData action="add">
    <Schedule type="Primary">
      <Channel ShortName="LT2"/>
      <AsRun>
        <BasicAsRun>
          <AsRunEventId><EventId>urn:uuid:4e6c9955-3084-ec32-e063-91041cac0ea8</EventId></AsRunEventId>
          <Content>
            <ContentId><HouseNumber>DC00040952</HouseNumber></ContentId>
            <Name>DC00040952 - MAC KAPAK TRENDYOL 1LIG 25-26</Name>
            <Description>MAC KAPAK TRENDYOL 1LIG 25-26</Description>
          </Content>
          <AsRunDetail>
            <Status>Aired Without Discrepancy</Status>
            <Type>Primary</Type>
            <StartDateTime>
              <SmpteDateTime frameRate="25" broadcastDate="2026-04-02">
                <SmpteTimeCode>00:00:00:00</SmpteTimeCode>
              </SmpteDateTime>
            </StartDateTime>
            <Duration>
              <SmpteDuration frameRate="25">
                <SmpteTimeCode>00:00:20:01</SmpteTimeCode>
              </SmpteDuration>
            </Duration>
          </AsRunDetail>
        </BasicAsRun>
      </AsRun>
    </Schedule>
  </BxfData>
</BxfMessage>`;

describe('asrun.parser › parseAsrunBxf', () => {
  it('parses a single BasicAsRun event with all fields', () => {
    const items = parseAsrunBxf(SINGLE);
    expect(items).toHaveLength(1);
    const it = items[0];
    expect(it.eventId).toBe('urn:uuid:4e6c9955-3084-ec32-e063-91041cac0ea8');
    expect(it.dcCode).toBe('DC00040952');
    expect(it.title).toBe('DC00040952 - MAC KAPAK TRENDYOL 1LIG 25-26');
    expect(it.rawKind).toBe('Primary');
    expect(it.category).toBe('PROGRAM');
    expect(it.scheduleDate).toBe('2026-04-02');
    expect(it.sequence).toBe(0);
    expect(it.startTimecode).toBe('00:00:00:00');
    expect(it.durationTimecode).toBe('00:00:20:01');
    expect(it.frameRate).toBe(25);
    // 20 seconds + 1 frame @25fps = 20000 + 40 = 20040
    expect(it.durationMs).toBe(20_040);
    // 2026-04-02T00:00 Istanbul = 2026-04-01T21:00Z
    expect(it.startAt.toISOString()).toBe('2026-04-01T21:00:00.000Z');
  });

  it('parses multiple AsRun elements and assigns sequential sequence', () => {
    const ev = (uuid: string, dc: string, tc: string) => `
      <AsRun><BasicAsRun>
        <AsRunEventId><EventId>${uuid}</EventId></AsRunEventId>
        <Content><ContentId><HouseNumber>${dc}</HouseNumber></ContentId><Name>${dc} title</Name></Content>
        <AsRunDetail>
          <Type>Primary</Type>
          <StartDateTime><SmpteDateTime frameRate="25" broadcastDate="2026-04-02"><SmpteTimeCode>${tc}</SmpteTimeCode></SmpteDateTime></StartDateTime>
          <Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:00:30:00</SmpteTimeCode></SmpteDuration></Duration>
        </AsRunDetail>
      </BasicAsRun></AsRun>`;
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  ${ev('urn:uuid:E1', 'DC00000001', '00:00:00:00')}
  ${ev('urn:uuid:E2', 'DC00000002', '01:00:00:00')}
  ${ev('urn:uuid:E3', 'DC00000003', '02:00:00:00')}
</Schedule></BxfData></BxfMessage>`;
    const items = parseAsrunBxf(xml);
    expect(items.map((i) => i.eventId)).toEqual(['urn:uuid:E1', 'urn:uuid:E2', 'urn:uuid:E3']);
    expect(items.map((i) => i.sequence)).toEqual([0, 1, 2]);
  });

  it('falls back to deterministic eventId when missing', () => {
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  <AsRun><BasicAsRun>
    <Content><ContentId><HouseNumber>DC0001</HouseNumber></ContentId><Name>X</Name></Content>
    <AsRunDetail>
      <Type>Primary</Type>
      <StartDateTime><SmpteDateTime frameRate="25" broadcastDate="2026-04-02"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
      <Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:00:30:00</SmpteTimeCode></SmpteDuration></Duration>
    </AsRunDetail>
  </BasicAsRun></AsRun>
</Schedule></BxfData></BxfMessage>`;
    const items = parseAsrunBxf(xml);
    expect(items).toHaveLength(1);
    expect(items[0].eventId).toBe('2026-04-02-10:00:00:00-0');
  });

  it('title fallback: Name → Description → dcCode → Untitled', () => {
    const ev = (contentInner: string) => `
      <AsRun><BasicAsRun>
        <AsRunEventId><EventId>urn:uuid:E</EventId></AsRunEventId>
        <Content>${contentInner}</Content>
        <AsRunDetail>
          <Type>Primary</Type>
          <StartDateTime><SmpteDateTime frameRate="25" broadcastDate="2026-04-02"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
          <Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:00:30:00</SmpteTimeCode></SmpteDuration></Duration>
        </AsRunDetail>
      </BasicAsRun></AsRun>`;
    const wrap = (body: string) => `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>${body}</Schedule></BxfData></BxfMessage>`;

    // Description only (no Name)
    expect(parseAsrunBxf(wrap(ev('<ContentId><HouseNumber>DC0001</HouseNumber></ContentId><Description>Just desc</Description>')))[0].title).toBe('Just desc');
    // DC only (no Name/Desc)
    expect(parseAsrunBxf(wrap(ev('<ContentId><HouseNumber>DC0002</HouseNumber></ContentId>')))[0].title).toBe('DC0002');
    // No content at all → Untitled
    expect(parseAsrunBxf(wrap(ev('')))[0].title).toBe('Untitled');
  });

  it('skips event when broadcastDate missing and no fallbackDate', () => {
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  <AsRun><BasicAsRun>
    <AsRunEventId><EventId>urn:uuid:NOBD</EventId></AsRunEventId>
    <Content><Name>X</Name></Content>
    <AsRunDetail>
      <Type>Primary</Type>
      <StartDateTime><SmpteDateTime frameRate="25"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
      <Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:00:30:00</SmpteTimeCode></SmpteDuration></Duration>
    </AsRunDetail>
  </BasicAsRun></AsRun>
</Schedule></BxfData></BxfMessage>`;
    expect(parseAsrunBxf(xml)).toEqual([]);
  });

  it('uses fallbackDate when broadcastDate missing', () => {
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  <AsRun><BasicAsRun>
    <AsRunEventId><EventId>urn:uuid:FBK</EventId></AsRunEventId>
    <Content><Name>X</Name></Content>
    <AsRunDetail>
      <Type>Primary</Type>
      <StartDateTime><SmpteDateTime frameRate="25"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
      <Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:00:30:00</SmpteTimeCode></SmpteDuration></Duration>
    </AsRunDetail>
  </BasicAsRun></AsRun>
</Schedule></BxfData></BxfMessage>`;
    const items = parseAsrunBxf(xml, { fallbackDate: '2026-04-02' });
    expect(items).toHaveLength(1);
    expect(items[0].scheduleDate).toBe('2026-04-02');
  });

  it('classifies AsRunDetail.Type via classifier', () => {
    const ev = (type: string) => `
      <AsRun><BasicAsRun>
        <AsRunEventId><EventId>urn:uuid:T-${type}</EventId></AsRunEventId>
        <Content><Name>X</Name></Content>
        <AsRunDetail>
          <Type>${type}</Type>
          <StartDateTime><SmpteDateTime frameRate="25" broadcastDate="2026-04-02"><SmpteTimeCode>10:00:00:00</SmpteTimeCode></SmpteDateTime></StartDateTime>
          <Duration><SmpteDuration frameRate="25"><SmpteTimeCode>00:00:30:00</SmpteTimeCode></SmpteDuration></Duration>
        </AsRunDetail>
      </BasicAsRun></AsRun>`;
    const xml = `<?xml version="1.0"?>
<BxfMessage xmlns="http://smpte-ra.org/schemas/2021/2017/BXF"><BxfData><Schedule>
  ${ev('Primary')}
  ${ev('Commercial')}
  ${ev('Promo')}
  ${ev('PSA')}
  ${ev('Live')}
  ${ev('UnknownType')}
</Schedule></BxfData></BxfMessage>`;
    const items = parseAsrunBxf(xml);
    expect(items.map((i) => i.category)).toEqual([
      'PROGRAM',     // Primary → "primary" matches none directly but contains "primar"... actually classifier won't match → DIGER
      'REKLAM',
      'TANITIM',
      'KAMU_SPOTU',
      'CANLI',
      'DIGER',
    ]);
  });

  it('returns [] for empty input or missing Schedule', () => {
    expect(parseAsrunBxf('')).toEqual([]);
    expect(parseAsrunBxf('   ')).toEqual([]);
    expect(parseAsrunBxf('<?xml version="1.0"?><BxfMessage><BxfData/></BxfMessage>')).toEqual([]);
  });

  it('throws AsrunParseError on malformed XML', () => {
    expect(() => parseAsrunBxf('<BxfMessage><BxfData><Schedule><AsRun></BadClose></BxfData></BxfMessage>')).toThrow(AsrunParseError);
  });
});
