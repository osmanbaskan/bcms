import { describe, it, expect } from 'vitest';
import {
  trUpper,
  asciiUpper,
  wrapText,
  storySlug,
  bulletinBaseName,
  buildPrompterOut,
  buildVizrtScenes,
  buildBulletinExport,
  toPrompterBuffer,
  toVizrtBuffer,
  type EgsStory,
} from './egs-export.js';

const story = (over: Partial<EgsStory>): EgsStory => ({
  displayName: null,
  title: 'Haber',
  prompterText: null,
  lowerThirds: [],
  ...over,
});

describe('trUpper (Türkçe büyük harf)', () => {
  it('i→İ ve ı→I doğru', () => {
    expect(trUpper('istanbul')).toBe('İSTANBUL');
    expect(trUpper('ısparta')).toBe('ISPARTA');
    expect(trUpper('İsmet Taşdemir')).toBe('İSMET TAŞDEMİR');
  });
  it('generic toUpperCase ile farklı (regresyon koruması)', () => {
    expect(trUpper('istanbul')).not.toBe('istanbul'.toUpperCase()); // ISTANBUL (yanlış)
  });
});

describe('asciiUpper (slug)', () => {
  it('Türkçe karakterleri ASCII katlar', () => {
    expect(asciiUpper('Derbi Öncesi')).toBe('DERBI ONCESI');
    expect(asciiUpper('İsmet Taşdemir')).toBe('ISMET TASDEMIR');
    expect(asciiUpper('Çaykur Şırnak Güneş')).toBe('CAYKUR SIRNAK GUNES');
  });
});

describe('wrapText', () => {
  it('~22 karaktere sarar, her satır boşlukla biter', () => {
    const lines = wrapText('SÜPER LİG DE BU HAFTA SONU OYNANACAK DEV DERBİ');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(l.endsWith(' ')).toBe(true);
      expect(l.trimEnd().length).toBeLessThanOrEqual(22);
    }
  });
  it('boş metin → boş dizi', () => {
    expect(wrapText('')).toEqual([]);
  });
});

describe('storySlug / bulletinBaseName', () => {
  it('Görüntü Adı önce, yoksa başlık', () => {
    expect(storySlug(story({ displayName: 'SP05-Derbi Öncesi' }))).toBe('SP05-DERBI ONCESI');
    expect(storySlug(story({ displayName: null, title: 'Galatasaray Transfer' }))).toBe('GALATASARAY TRANSFER');
  });
  it('taban ad = kod + HHMM', () => {
    expect(bulletinBaseName({ name: 'Spor', bulletinCode: 'SPGENE', onAirMinute: 21 * 60, stories: [] })).toBe('SPGENE2100');
    expect(bulletinBaseName({ name: 'Ana Haber', bulletinCode: null, onAirMinute: 20 * 60 + 30, stories: [] })).toMatch(/2030$/);
  });
});

describe('buildPrompterOut (_out.WIN)', () => {
  const text = buildPrompterOut([
    story({ displayName: 'SP05-DERBI', prompterText: 'İstanbul’da büyük heyecan var.' }),
    story({ displayName: 'GRAFIK-PUAN', prompterText: null }),
  ]);
  it('her haber için %%B bloğu', () => {
    expect((text.match(/%%B/g) ?? []).length).toBe(2);
    expect(text).toContain('%%B[S1]{1 SP05-DERBI}');
    expect(text).toContain('%%B[S2]{2 GRAFIK-PUAN}');
  });
  it('%%E yerine boş satır (çıktı formatı)', () => {
    expect(text).not.toContain('%%E');
  });
  it('gövde Türkçe büyük harf (İ noktalı)', () => {
    expect(text).toContain('İSTANBUL');
  });
  it('CRLF satır sonu', () => {
    expect(text.includes('\r\n')).toBe(true);
  });
});

describe('buildVizrtScenes (.xml)', () => {
  const stories = [
    story({ displayName: 'SP05-DERBI', lowerThirds: [{ title: null, line1: 'derbi öncesi', line2: null }] }),
    story({ displayName: 'MONTELLA', lowerThirds: [
      { title: 'Vincenzo Montella', line1: 'A Milli Takım', line2: 'ülke gururlu' },
    ] }),
    story({ displayName: 'GRAFIK', lowerThirds: [] }), // KJ yok → scene yok
  ];
  const { xml, sceneCount } = buildVizrtScenes(stories);
  it('KJ başına bir scene (grafik hariç)', () => {
    expect(sceneCount).toBe(2);
    expect((xml.match(/<scene /g) ?? []).length).toBe(2);
  });
  it('scenes kök + exports/export yapısı', () => {
    expect(xml.startsWith('<scenes>')).toBe(true);
    expect(xml).toContain('<scene name="SP05-DERBI"><exports>');
    expect(xml).toContain('<export name="SATIR1" value="DERBİ ÖNCESİ" />');
  });
  it('boş başlık → "-", line2 varsa SATIR2', () => {
    expect(xml).toContain('<export name="BASLIK" value="-" />');
    expect(xml).toContain('<export name="SATIR2" value="ÜLKE GURURLU" />');
  });
  it('öznitelik kaçışı (& < > ")', () => {
    const { xml: esc } = buildVizrtScenes([
      story({ displayName: 'X', lowerThirds: [{ title: 'A & B <C>', line1: '"alıntı"', line2: null }] }),
    ]);
    expect(esc).toContain('A &amp; B &lt;C&gt;');
    expect(esc).toContain('&quot;ALINTI&quot;');
  });
});

describe('buildBulletinExport + buffer baytları', () => {
  const res = buildBulletinExport({
    name: 'Spor Ana Haber',
    bulletinCode: 'SPGENE',
    onAirMinute: 21 * 60,
    stories: [story({ displayName: 'SP05-DERBI', prompterText: 'test', lowerThirds: [{ title: null, line1: 'alt', line2: null }] })],
  });
  it('dosya adları doğru', () => {
    expect(res.prompterFilename).toBe('SPGENE2100_out.WIN');
    expect(res.vizrtFilename).toBe('SPGENE2100.xml');
    expect(res.sceneCount).toBe(1);
    expect(res.storyCount).toBe(1);
  });
  it('_out.WIN BOM ile başlar (EF BB BF)', () => {
    const buf = toPrompterBuffer(res.prompterText);
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });
  it('.xml BOM olmadan (< ile başlar)', () => {
    const buf = toVizrtBuffer(res.vizrtText);
    expect(buf[0]).toBe('<'.charCodeAt(0));
  });
});
