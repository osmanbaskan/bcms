import type { NewsMosAction, NewsMosDeviceKind } from '@bcms/shared';

/**
 * MOS / Vizrt çıkış XML üreticisi — 2026-06-05.
 *
 * EGS NewsWorks "KJ ve SPOT'lar VizRT'ye XML olarak gönderilebilsin" + MOS
 * davranışının modern karşılığı. İki katman:
 *   - Vizrt template payload  (<payload template="..."><field/></payload>)
 *   - MOS zarfı               (<mos><mosObj>...<mosPayload>payload</mosPayload>)
 * VIZRT_REST / XML_FILE → düz payload; MOS_TCP → MOS zarfı.
 * Cihaz yoksa dry-run önizleme için yine geçerli XML döner.
 */

export interface MosBuildInput {
  action: NewsMosAction;            // KJ | SPOT | CRAWL | ROLL
  deviceKind: NewsMosDeviceKind;    // MOS_TCP | VIZRT_REST | XML_FILE
  mosId?: string | null;
  ncsId?: string | null;
  templateMap?: Record<string, unknown> | null;
  storyId: number;
  storyTitle: string;
  title?: string | null;            // KJ/Spot Başlığı
  line1?: string | null;            // 1. Satır
  line2?: string | null;            // 2. Satır
  text?: string | null;             // CRAWL/ROLL gövdesi
}

/** Varsayılan Vizrt template id'leri (cihaz templateMap'i override eder). */
const DEFAULT_TEMPLATES: Record<NewsMosAction, string> = {
  KJ: '1001',
  SPOT: '1002',
  CRAWL: '2001',
  ROLL: '2002',
};

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** CDATA güvenli değer (']]>' kaçışı). */
function cdata(value: string): string {
  return `<![CDATA[${value.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function field(name: string, value: string | null | undefined): string {
  return `    <field name="${xmlEscape(name)}"><value>${cdata(value ?? '')}</value></field>`;
}

function resolveTemplate(input: MosBuildInput): string {
  const fromMap = input.templateMap?.[input.action];
  return fromMap != null ? String(fromMap) : DEFAULT_TEMPLATES[input.action];
}

/** İç Vizrt template payload'ı. */
export function buildVizrtPayload(input: MosBuildInput): string {
  const template = resolveTemplate(input);
  const fields: string[] =
    input.action === 'CRAWL' || input.action === 'ROLL'
      ? [field('text', input.text ?? input.title ?? input.storyTitle)]
      : [
          field('title', input.title),
          field('line1', input.line1),
          field('line2', input.line2),
        ];
  return [
    `<payload template="${xmlEscape(template)}" type="${input.action}">`,
    ...fields,
    `</payload>`,
  ].join('\n');
}

/** MOS zarfı (mosObj + mosExternalMetadata → mosPayload). */
function buildMosEnvelope(input: MosBuildInput, payload: string): string {
  const indentedPayload = payload.split('\n').map((l) => `        ${l}`).join('\n');
  return [
    `<mos>`,
    `  <mosID>${xmlEscape(input.mosId ?? 'BCMS')}</mosID>`,
    `  <ncsID>${xmlEscape(input.ncsId ?? 'BCMS-NEWS')}</ncsID>`,
    `  <mosObj>`,
    `    <objID>BCMS-${input.storyId}-${input.action}</objID>`,
    `    <objSlug>${xmlEscape(`${input.storyTitle} — ${input.action}`)}</objSlug>`,
    `    <mosAbstract>${xmlEscape(input.title ?? input.text ?? input.storyTitle)}</mosAbstract>`,
    `    <objGroup>BCMS</objGroup>`,
    `    <objType>VIZRT</objType>`,
    `    <objTB>0</objTB>`,
    `    <mosExternalMetadata>`,
    `      <mosScope>PLAYLIST</mosScope>`,
    `      <mosSchema>http://www.vizrt.com/mosObj</mosSchema>`,
    `      <mosPayload>`,
    indentedPayload,
    `      </mosPayload>`,
    `    </mosExternalMetadata>`,
    `  </mosObj>`,
    `</mos>`,
  ].join('\n');
}

/** Cihaz tipine göre nihai gönderilecek XML. */
export function buildMosXml(input: MosBuildInput): string {
  const payload = buildVizrtPayload(input);
  const body = input.deviceKind === 'MOS_TCP' ? buildMosEnvelope(input, payload) : payload;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`;
}
