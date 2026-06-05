/**
 * EGS bülten dışa-aktarım üreticisi — 2026-06-06.
 *
 * Bir bülteni EGS NewsWorks'ün ürettiği iki dosyaya dönüştürür:
 *   - Prompter `_out.WIN`  : cihaz çıktısı formatı. Her haber için
 *       `%%B[S<n>]{<n> <SLUG>}` + 22 karakter sarmalı BÜYÜK-harf metin + boş `%%E`.
 *       Yazımda UTF-8 + BOM, satır sonu CRLF. (Çevirici kullanmadan doğrudan `_out`.)
 *   - Vizrt `.xml`         : `<scenes><scene name="<slug>"><exports>
 *       <export name="BASLIK"/><export name="SATIR1"/>(SATIR2)</exports></scene></scenes>`.
 *       Tek satır, CRLF ile biter, UTF-8 (BOM yok). KJ/SPOT başına bir scene.
 *
 * KRİTİK: Türkçe büyük harf `toLocaleUpperCase('tr-TR')` ile yapılır (i→İ, ı→I).
 * Generic `.toUpperCase()` i→I (noktasız) üreterek prompter/altyazıyı bozar.
 */

const CRLF = '\r\n';
const WRAP_WIDTH = 22;

/** Türkçe-doğru büyük harf (prompter gövdesi + altyazı değerleri). */
export function trUpper(s: string): string {
  return s.toLocaleUpperCase('tr-TR');
}

const ASCII_FOLD: Record<string, string> = {
  ç: 'C', Ç: 'C', ğ: 'G', Ğ: 'G', ı: 'I', İ: 'I', ö: 'O', Ö: 'O',
  ş: 'S', Ş: 'S', ü: 'U', Ü: 'U', â: 'A', Â: 'A', î: 'I', Î: 'I', û: 'U', Û: 'U',
};

/** Slug/scene adı için ASCII-katlanmış büyük harf (EGS kod kuralı: SP05-DERBI ONCESI). */
export function asciiUpper(s: string): string {
  const folded = s.replace(/[çÇğĞıİöÖşŞüÜâÂîÎûÛ]/g, (c) => ASCII_FOLD[c] ?? c);
  return folded.toUpperCase();
}

/** Metni ~width karaktere sarar; her satır sonuna EGS deseni gereği bir boşluk ekler. */
export function wrapText(text: string, width = WRAP_WIDTH): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + w.length > width) {
      out.push(line + ' ');
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) out.push(line + ' ');
  return out;
}

export interface EgsLowerThird {
  title: string | null;
  line1: string | null;
  line2: string | null;
}
export interface EgsStory {
  displayName: string | null; // Görüntü Adı → slug kaynağı
  title: string;              // Haber Adı → slug yedeği
  prompterText: string | null;
  lowerThirds: EgsLowerThird[];
}
export interface EgsBulletin {
  name: string;
  bulletinCode: string | null;
  onAirMinute: number;
  stories: EgsStory[];
}

/** Story slug'ı: Görüntü Adı (yoksa Haber Adı) → ASCII büyük harf, tek boşluk. */
export function storySlug(story: EgsStory): string {
  const src = (story.displayName ?? '').trim() || story.title.trim() || 'HABER';
  return asciiUpper(src).replace(/\s+/g, ' ').slice(0, 60);
}

function hhmm(onAirMinute: number): string {
  const m = ((onAirMinute % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
}

/** Dosya taban adı: bültenKodu (yoksa ad-slug) + HHMM. Ör. SPGENE2100. */
export function bulletinBaseName(b: EgsBulletin): string {
  const code = (b.bulletinCode ?? '').trim();
  const stem = code ? asciiUpper(code).replace(/\s+/g, '') : asciiUpper(b.name).replace(/\s+/g, '').slice(0, 12);
  return `${stem || 'BULTEN'}${hhmm(b.onAirMinute)}`;
}

/**
 * Prompter `_out.WIN` gövdesi (string, BOM hariç). Her haber bir `%%B` bloğu;
 * `%%E` çıktı formatında boş satır olur. Satır sonu CRLF.
 */
export function buildPrompterOut(stories: EgsStory[]): string {
  const lines: string[] = [];
  stories.forEach((story, idx) => {
    const n = idx + 1;
    lines.push(`%%B[S${n}]{${n} ${storySlug(story)}}`);
    const text = (story.prompterText ?? '').trim();
    if (text) lines.push(...wrapText(trUpper(text)));
    lines.push(''); // %%E → çıktıda boş satır
  });
  return lines.join(CRLF) + CRLF;
}

function attrEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function exportTag(name: string, value: string): string {
  return `<export name="${attrEscape(name)}" value="${attrEscape(value)}" />`;
}

/**
 * Vizrt `.xml` gövdesi (string, BOM yok). KJ/SPOT başına bir `<scene>`.
 * BASLIK←title, SATIR1←line1, SATIR2←line2 (varsa). Değerler Türkçe büyük harf.
 */
export function buildVizrtScenes(stories: EgsStory[]): { xml: string; sceneCount: number } {
  const scenes: string[] = [];
  for (const story of stories) {
    const slug = storySlug(story);
    for (const lt of story.lowerThirds) {
      const exports = [exportTag('BASLIK', trUpper((lt.title ?? '').trim()) || '-')];
      exports.push(exportTag('SATIR1', trUpper((lt.line1 ?? '').trim())));
      if ((lt.line2 ?? '').trim()) exports.push(exportTag('SATIR2', trUpper(lt.line2!.trim())));
      scenes.push(`<scene name="${attrEscape(slug)}"><exports>${exports.join('')}</exports></scene>`);
    }
  }
  return { xml: `<scenes>${scenes.join('')}</scenes>${CRLF}`, sceneCount: scenes.length };
}

export interface EgsExportResult {
  base: string;
  prompterFilename: string;  // <base>_out.WIN
  prompterText: string;
  vizrtFilename: string;     // <base>.xml
  vizrtText: string;
  storyCount: number;
  sceneCount: number;
}

/** Bülten → iki dosya içeriği + adları (saf; yazım/SMB ayrı katman). */
export function buildBulletinExport(b: EgsBulletin): EgsExportResult {
  const base = bulletinBaseName(b);
  const prompterText = buildPrompterOut(b.stories);
  const { xml, sceneCount } = buildVizrtScenes(b.stories);
  return {
    base,
    prompterFilename: `${base}_out.WIN`,
    prompterText,
    vizrtFilename: `${base}.xml`,
    vizrtText: xml,
    storyCount: b.stories.length,
    sceneCount,
  };
}

/** `_out.WIN` baytları — UTF-8 + BOM (EF BB BF). */
export function toPrompterBuffer(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

/** `.xml` baytları — UTF-8, BOM yok. */
export function toVizrtBuffer(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}
