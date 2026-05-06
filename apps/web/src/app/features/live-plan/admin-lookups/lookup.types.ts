/**
 * Madde 5 M5-B6 — Live-plan lookup admin UI registry/helper.
 *
 * M10 lock (2026-05-06): ApiService kullanılır; ayrı injectable
 * LookupApiService YOK. Endpoint/type stringleri component dışına bu dosyada
 * tutulur — UI'da raw endpoint string dağılmaz.
 *
 * Backend whitelist: apps/api/src/modules/live-plan/lookup.registry.ts
 */

/** Polymorphic lookup tablolarda allowed type değerleri (backend ile birebir). */
export const TECHNICAL_COMPANY_TYPES = ['OB_VAN', 'GENERATOR', 'SNG', 'CARRIER', 'FIBER'] as const;
export const EQUIPMENT_TYPES = ['JIMMY_JIB', 'STEADICAM', 'IBM'] as const;

export type TechnicalCompanyType = (typeof TECHNICAL_COMPANY_TYPES)[number];
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

/** UI gruplandırması — sol pane'de kategoriye göre listelenir. */
export type LookupGroup = 'transmission' | 'technical' | 'live-plan' | 'fiber';

export interface LookupDefinition {
  /** URL path segment (örn. transmission_satellites). */
  type:        LookupType;
  /** Sol panede gösterilen Türkçe etiket. */
  label:       string;
  /** Kategori — sol pane gruplaması. */
  group:       LookupGroup;
  /** Type-polymorphic mı? (technical_companies / live_plan_equipment_options). */
  polymorphic: boolean;
  /** Polymorphic ise allowed type değerleri. */
  allowedTypes?: readonly string[];
}

export type LookupType =
  | 'transmission_satellites'
  | 'transmission_irds'
  | 'transmission_fibers'
  | 'transmission_int_resources'
  | 'transmission_tie_options'
  | 'transmission_demod_options'
  | 'transmission_virtual_resources'
  | 'transmission_feed_types'
  | 'transmission_modulation_types'
  | 'transmission_video_codings'
  | 'transmission_audio_configs'
  | 'transmission_key_types'
  | 'transmission_polarizations'
  | 'transmission_fec_rates'
  | 'transmission_roll_offs'
  | 'transmission_iso_feed_options'
  | 'technical_companies'
  | 'live_plan_equipment_options'
  | 'live_plan_locations'
  | 'live_plan_usage_locations'
  | 'live_plan_regions'
  | 'live_plan_languages'
  | 'live_plan_off_tube_options'
  | 'fiber_audio_formats'
  | 'fiber_video_formats';

/** UI registry — sol pane sırası bu liste sırasını izler. */
export const LOOKUP_DEFINITIONS: readonly LookupDefinition[] = [
  // Transmisyon (16 tablo)
  { type: 'transmission_satellites',        label: 'Uydular',                group: 'transmission', polymorphic: false },
  { type: 'transmission_irds',              label: 'IRD',                    group: 'transmission', polymorphic: false },
  { type: 'transmission_fibers',            label: 'Fiber Hatlar',           group: 'transmission', polymorphic: false },
  { type: 'transmission_int_resources',     label: 'INT Kaynaklar',          group: 'transmission', polymorphic: false },
  { type: 'transmission_tie_options',       label: 'Tie Seçenekleri',        group: 'transmission', polymorphic: false },
  { type: 'transmission_demod_options',     label: 'Demod Seçenekleri',      group: 'transmission', polymorphic: false },
  { type: 'transmission_virtual_resources', label: 'Sanal Kaynaklar',        group: 'transmission', polymorphic: false },
  { type: 'transmission_feed_types',        label: 'Feed Tipleri',           group: 'transmission', polymorphic: false },
  { type: 'transmission_modulation_types',  label: 'Modülasyon Tipleri',     group: 'transmission', polymorphic: false },
  { type: 'transmission_video_codings',     label: 'Video Kodlama',          group: 'transmission', polymorphic: false },
  { type: 'transmission_audio_configs',     label: 'Ses Konfigürasyonu',     group: 'transmission', polymorphic: false },
  { type: 'transmission_key_types',         label: 'Anahtar (Key) Tipleri',  group: 'transmission', polymorphic: false },
  { type: 'transmission_polarizations',     label: 'Polarizasyon',           group: 'transmission', polymorphic: false },
  { type: 'transmission_fec_rates',         label: 'FEC Oranları',           group: 'transmission', polymorphic: false },
  { type: 'transmission_roll_offs',         label: 'Roll-Off',               group: 'transmission', polymorphic: false },
  { type: 'transmission_iso_feed_options',  label: 'ISO Feed Seçenekleri',   group: 'transmission', polymorphic: false },
  // Teknik (2 polymorphic)
  { type: 'technical_companies',            label: 'Teknik Firmalar',        group: 'technical',    polymorphic: true,  allowedTypes: TECHNICAL_COMPANY_TYPES },
  { type: 'live_plan_equipment_options',    label: 'Ekipman Seçenekleri',    group: 'technical',    polymorphic: true,  allowedTypes: EQUIPMENT_TYPES },
  // Live-plan (5 tablo)
  { type: 'live_plan_locations',            label: 'Lokasyonlar',            group: 'live-plan',    polymorphic: false },
  { type: 'live_plan_usage_locations',      label: 'Kullanım Lokasyonları',  group: 'live-plan',    polymorphic: false },
  { type: 'live_plan_regions',              label: 'Bölgeler',               group: 'live-plan',    polymorphic: false },
  { type: 'live_plan_languages',            label: 'Diller',                 group: 'live-plan',    polymorphic: false },
  { type: 'live_plan_off_tube_options',     label: 'Off-Tube Seçenekleri',   group: 'live-plan',    polymorphic: false },
  // Fiber format (2 tablo)
  { type: 'fiber_audio_formats',            label: 'Fiber Ses Formatları',   group: 'fiber',        polymorphic: false },
  { type: 'fiber_video_formats',            label: 'Fiber Video Formatları', group: 'fiber',        polymorphic: false },
];

export const LOOKUP_GROUP_LABELS: Record<LookupGroup, string> = {
  'transmission': 'Transmisyon',
  'technical':    'Teknik',
  'live-plan':    'Canlı Yayın',
  'fiber':        'Fiber Format',
};

export function findLookupDefinition(type: string): LookupDefinition | undefined {
  return LOOKUP_DEFINITIONS.find((d) => d.type === type);
}

/** Backend lookup row shape — apps/api/.../lookup.registry.ts LookupRow ile aynı. */
export interface LookupRow {
  id:        number;
  label:     string;
  active:    boolean;
  sortOrder: number;
  type?:     string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LookupListResponse {
  data:       LookupRow[];
  total:      number;
  page:       number;
  pageSize:   number;
  totalPages: number;
}

export interface LookupCreateBody {
  label:      string;
  active?:    boolean;
  sortOrder?: number;
  type?:      string;
}

export interface LookupUpdateBody {
  label?:     string;
  active?:    boolean;
  sortOrder?: number;
  /** L10: PATCH'te sadece `null` kabul edilir → restore. */
  deletedAt?: null;
}

/** Endpoint helper — component'lerde raw string yerine. */
export const lookupEndpoint = {
  list:   (type: LookupType) => `/live-plan/lookups/${type}`,
  detail: (type: LookupType, id: number) => `/live-plan/lookups/${type}/${id}`,
};
