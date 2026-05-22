import { describe, it, expect } from 'vitest';
import { parseBxf, ProvysParseError } from './provys.parser.js';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<BxfMessage>
  <BxfData>
    <ScheduleElements>
      <ScheduleElement>
        <EventData EventId="EVT-1" StartDateTime="2026-05-22T18:00:00Z" Duration="PT00H00M30S">
          <EventType>COMMERCIAL</EventType>
          <Title>Reklam Spotu A</Title>
        </EventData>
      </ScheduleElement>
      <ScheduleElement>
        <EventData EventId="EVT-2" StartDateTime="2026-05-22T18:00:30Z" Duration="PT01H30M00S">
          <EventType>LIVE</EventType>
          <Title>Canlı Maç</Title>
        </EventData>
      </ScheduleElement>
      <ScheduleElement>
        <EventData EventId="EVT-3" StartDateTime="2026-05-22T19:30:30Z" Duration="00:00:45">
          <EventType>PSA</EventType>
          <Title>Kamu Spotu — Sağlık</Title>
        </EventData>
      </ScheduleElement>
    </ScheduleElements>
  </BxfData>
</BxfMessage>`;

describe('provys.parser › parseBxf', () => {
  it('parses well-formed BXF and assigns sequence + categories', () => {
    const items = parseBxf(SAMPLE);
    expect(items).toHaveLength(3);

    expect(items[0]).toMatchObject({
      eventId: 'EVT-1',
      sequence: 0,
      title: 'Reklam Spotu A',
      rawKind: 'COMMERCIAL',
      category: 'REKLAM',
      durationMs: 30_000,
    });
    expect(items[0].startAt.toISOString()).toBe('2026-05-22T18:00:00.000Z');

    expect(items[1]).toMatchObject({
      eventId: 'EVT-2',
      sequence: 1,
      category: 'CANLI',
      durationMs: 5_400_000,
    });

    expect(items[2]).toMatchObject({
      eventId: 'EVT-3',
      sequence: 2,
      category: 'KAMU_SPOTU',
      durationMs: 45_000,
    });
  });

  it('returns [] for empty content', () => {
    expect(parseBxf('')).toEqual([]);
    expect(parseBxf('   ')).toEqual([]);
  });

  it('returns [] when ScheduleElements is missing', () => {
    const empty = `<?xml version="1.0"?><BxfMessage><BxfData></BxfData></BxfMessage>`;
    expect(parseBxf(empty)).toEqual([]);
  });

  it('skips elements missing required fields (eventId / startAt / title)', () => {
    const xml = `<?xml version="1.0"?>
<BxfMessage><BxfData><ScheduleElements>
  <ScheduleElement>
    <EventData EventId="" StartDateTime="2026-05-22T18:00:00Z"><Title>NoId</Title></EventData>
  </ScheduleElement>
  <ScheduleElement>
    <EventData EventId="OK-1" StartDateTime="" ><Title>NoStart</Title></EventData>
  </ScheduleElement>
  <ScheduleElement>
    <EventData EventId="OK-2" StartDateTime="2026-05-22T18:00:00Z"><Title></Title></EventData>
  </ScheduleElement>
  <ScheduleElement>
    <EventData EventId="GOOD" StartDateTime="2026-05-22T18:00:00Z"><Title>OK</Title><EventType>PROGRAM</EventType></EventData>
  </ScheduleElement>
</ScheduleElements></BxfData></BxfMessage>`;
    const items = parseBxf(xml);
    expect(items.map((i) => i.eventId)).toEqual(['GOOD']);
  });

  it('classifies unknown EventType as DIGER', () => {
    const xml = `<?xml version="1.0"?>
<BxfMessage><BxfData><ScheduleElements>
  <ScheduleElement><EventData EventId="X1" StartDateTime="2026-05-22T18:00:00Z"><Title>X</Title><EventType>UNKNOWN_KIND</EventType></EventData></ScheduleElement>
</ScheduleElements></BxfData></BxfMessage>`;
    const items = parseBxf(xml);
    expect(items).toHaveLength(1);
    expect(items[0].category).toBe('DIGER');
    expect(items[0].rawKind).toBe('UNKNOWN_KIND');
  });

  it('throws ProvysParseError on malformed XML', () => {
    const broken = '<BxfMessage><BxfData><ScheduleElements><<<';
    expect(() => parseBxf(broken)).toThrow(ProvysParseError);
  });

  it('handles missing duration gracefully (null)', () => {
    const xml = `<?xml version="1.0"?>
<BxfMessage><BxfData><ScheduleElements>
  <ScheduleElement><EventData EventId="N1" StartDateTime="2026-05-22T18:00:00Z"><Title>NoDur</Title><EventType>PROGRAM</EventType></EventData></ScheduleElement>
</ScheduleElements></BxfData></BxfMessage>`;
    const items = parseBxf(xml);
    expect(items[0].durationMs).toBeNull();
  });
});
