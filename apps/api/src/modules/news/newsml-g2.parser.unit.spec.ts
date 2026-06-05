import { describe, it, expect } from 'vitest';
import { parseNewsMlG2 } from './newsml-g2.parser.js';

/** Gerçek AA /abone/document/{id}/newsml29 yapısına birebir fixture. */
const AA_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<newsMessage>
  <itemSet>
    <newsItem guid="aa:text:20260605:41586353" version="1" xml:lang="tr">
      <itemMeta>
        <itemClass qcode="ninat:text"/>
        <provider literal="Anadolu Ajansı"/>
        <versionCreated>2026-06-05T12:00:41Z</versionCreated>
        <priority>5</priority>
      </itemMeta>
      <contentMeta>
        <headline>Düzce "Hava Sporları" yarışmalarına ev sahipliği yapıyor</headline>
        <subject qcode="AAcat:SPO"><name xml:lang="en">Sport</name><name xml:lang="tr">Spor</name></subject>
        <subject qcode="AApackage:1"><name xml:lang="tr">Genel</name></subject>
      </contentMeta>
      <contentSet>
        <inlineXML>
          <nitf xmlns="http://iptc.org/std/NITF/2006-10-18/">
            <body>
              <body.head>
                <headline><hl1>Düzce yarışmaları</hl1></headline>
                <byline><byttl>Ömer Ürer</byttl></byline>
              </body.head>
              <body.content>&lt;p&gt;DÜZCE (AA) - &amp;quot;Hava Sporları&amp;quot; yarışmaları Düzce&amp;#39;de yapılıyor.&lt;/p&gt;&lt;p&gt;İkinci paragraf burada.&lt;/p&gt;</body.content>
            </body>
          </nitf>
        </inlineXML>
      </contentSet>
    </newsItem>
  </itemSet>
</newsMessage>`;

const FLASH_SAMPLE = `<newsMessage><itemSet>
  <newsItem guid="aa:text:20260605:999" xml:lang="tr">
    <itemMeta><versionCreated>2026-06-05T15:00:00Z</versionCreated></itemMeta>
    <contentMeta>
      <headline>SON DAKİKA: Önemli gelişme yaşandı</headline>
      <subject qcode="AAcat:GUN"><name xml:lang="tr">Genel</name></subject>
    </contentMeta>
  </newsItem>
</itemSet></newsMessage>`;

describe('parseNewsMlG2', () => {
  it('AA NewsML-G2 metnini tüm alanlarıyla ayrıştırır', () => {
    const [item] = parseNewsMlG2(AA_SAMPLE);
    expect(item).toBeDefined();
    expect(item.externalId).toBe('aa:text:20260605:41586353');
    expect(item.headline).toBe('Düzce "Hava Sporları" yarışmalarına ev sahipliği yapıyor');
    expect(item.category).toBe('Spor'); // AAcat:SPO → tr ad
    expect(item.byline).toBe('Ömer Ürer');
    expect(item.priority).toBe('NORMAL');
    expect(item.receivedAt.toISOString()).toBe('2026-06-05T12:00:41.000Z');
  });

  it('body.content içindeki escaped <p> + HTML entity\'leri düz metne çevirir', () => {
    const [item] = parseNewsMlG2(AA_SAMPLE);
    expect(item.body).toContain('DÜZCE (AA) - "Hava Sporları" yarışmaları Düzce\'de yapılıyor.');
    expect(item.body).toContain('İkinci paragraf burada.');
    expect(item.body).not.toContain('<p>');     // tag kalmadı
    expect(item.body).not.toContain('&quot;');  // entity çözüldü
    expect(item.body).toMatch(/\n\n/);          // paragraf ayrımı korundu
  });

  it('"SON DAKİKA" başlığını FLASH olarak işaretler', () => {
    const [item] = parseNewsMlG2(FLASH_SAMPLE);
    expect(item.priority).toBe('FLASH');
    expect(item.category).toBe('Genel');
    expect(item.body).toBeNull(); // nitf yok
  });

  it('guid olmayan item\'ı atlar', () => {
    const xml = '<newsMessage><itemSet><newsItem version="1"><contentMeta><headline>x</headline></contentMeta></newsItem></itemSet></newsMessage>';
    expect(parseNewsMlG2(xml)).toHaveLength(0);
  });

  it('boş / bozuk girdide boş dizi döner', () => {
    expect(parseNewsMlG2('')).toHaveLength(0);
    expect(parseNewsMlG2('<newsMessage></newsMessage>')).toHaveLength(0);
  });
});
