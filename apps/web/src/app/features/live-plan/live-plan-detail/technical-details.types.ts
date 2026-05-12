/**
 * Madde 5 M5-B10b — Live-plan Teknik Detay 73 alan UI tipi + field config.
 *
 * Backend referans:
 *   - apps/api/src/modules/live-plan/technical-details.schema.ts
 *   - apps/api/src/modules/live-plan/technical-details.lookup-validation.ts
 *   - REQUIREMENTS-LIVE-PLAN-TECHNICAL-FIELDS-V1.md §5.1-§5.6
 *
 * Y3-Y4 lock: 73 alan + 1:1 entry. Schema'da YOK; canonical JSON YOK.
 * Polymorphic FK'ler: technical_companies (OB_VAN/GENERATOR/SNG/CARRIER/FIBER),
 * live_plan_equipment_options (JIMMY_JIB/STEADICAM/IBM).
 */

import type { LookupType } from '../admin-lookups/lookup.types';

// ── DTO shapes ────────────────────────────────────────────────────────────

/** GET /api/v1/live-plan/:entryId/technical-details response (1:1; null mümkün). */
export interface TechnicalDetailsRow {
  id:              number;
  livePlanEntryId: number;
  version:         number;
  createdAt:       string;
  updatedAt:       string;
  deletedAt:       string | null;

  // §5.1 Yayın/OB (14)
  broadcastLocationId:   number | null;
  obVanCompanyId:        number | null;
  generatorCompanyId:    number | null;
  jimmyJibId:            number | null;
  steadicamId:           number | null;
  sngCompanyId:          number | null;
  carrierCompanyId:      number | null;
  ibmId:                 number | null;
  usageLocationId:       number | null;
  fixedPhone1:           string | null;
  secondObVanId:         number | null;
  regionId:              number | null;
  cameraCount:           number | null;
  fixedPhone2:           string | null;

  // §5.2 Ortak (10)
  plannedStartTime:      string | null;
  plannedEndTime:        string | null;
  hdvgResourceId:        number | null;
  int1ResourceId:        number | null;
  int2ResourceId:        number | null;
  offTubeId:             number | null;
  languageId:            number | null;
  /** Yabancı Dil — 2026-05-11 canonical kolon (live_plan_languages FK). */
  secondLanguageId:      number | null;
  demodId:               number | null;
  tieId:                 number | null;
  virtualResourceId:     number | null;

  // §5.3 IRD/Fiber (5)
  ird1Id:                number | null;
  ird2Id:                number | null;
  ird3Id:                number | null;
  fiber1Id:              number | null;
  fiber2Id:              number | null;

  // §5.4 Ana Feed (21)
  feedTypeId:            number | null;
  satelliteId:           number | null;
  txp:                   string | null;
  satChannel:            string | null;
  uplinkFrequency:       string | null;
  uplinkPolarizationId:  number | null;
  downlinkFrequency:     string | null;
  downlinkPolarizationId: number | null;
  modulationTypeId:      number | null;
  rollOffId:             number | null;
  videoCodingId:         number | null;
  audioConfigId:         number | null;
  preMatchKey:           string | null;
  matchKey:              string | null;
  postMatchKey:          string | null;
  isoFeedId:             number | null;
  keyTypeId:             number | null;
  symbolRate:            string | null;
  fecRateId:             number | null;
  bandwidth:             string | null;
  uplinkFixedPhone:      string | null;

  // §5.5 Yedek Feed (19)
  backupFeedTypeId:           number | null;
  backupSatelliteId:          number | null;
  backupTxp:                  string | null;
  backupSatChannel:           string | null;
  backupUplinkFrequency:      string | null;
  backupUplinkPolarizationId: number | null;
  backupDownlinkFrequency:    string | null;
  backupDownlinkPolarizationId: number | null;
  backupModulationTypeId:     number | null;
  backupRollOffId:            number | null;
  backupVideoCodingId:        number | null;
  backupAudioConfigId:        number | null;
  backupPreMatchKey:          string | null;
  backupMatchKey:             string | null;
  backupPostMatchKey:         string | null;
  backupKeyTypeId:            number | null;
  backupSymbolRate:           string | null;
  backupFecRateId:            number | null;
  backupBandwidth:            string | null;

  // §5.6 Fiber (4)
  fiberCompanyId:        number | null;
  fiberAudioFormatId:    number | null;
  fiberVideoFormatId:    number | null;
  fiberBandwidth:        string | null;
}

/**
 * POST body — tüm alanlar opsiyonel; 1:1 child boş başlayabilir.
 * Operatör sonradan PATCH ile doldurur.
 */
export type CreateTechnicalDetailsBody = Partial<TechnicalDetailsBaseFields>;

/**
 * PATCH body — U7: undefined=no-change, null=clear column.
 * En az 1 alan zorunlu (backend refine).
 */
export type UpdateTechnicalDetailsBody = {
  [K in keyof TechnicalDetailsBaseFields]?: TechnicalDetailsBaseFields[K] | null;
};

/**
 * 73 mutable alan (id/version/timestamps hariç) — DTO shape source-of-truth.
 */
export type TechnicalDetailsBaseFields = Omit<
  TechnicalDetailsRow,
  'id' | 'livePlanEntryId' | 'version' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export type TechnicalDetailsFieldKey = keyof TechnicalDetailsBaseFields;

// ── Field definitions ─────────────────────────────────────────────────────

/** Scalar input türleri (REQUIREMENTS doc tip kolonu birebir). */
export type ScalarKind = 'string' | 'int' | 'datetime';

export interface ScalarFieldDef {
  key:        TechnicalDetailsFieldKey;
  label:      string;
  kind:       ScalarKind;
  /** String alanlar için max length (REQUIREMENTS doc Zod schema'dan). */
  maxLength?: number;
  /** Int alanlar için min/max. */
  min?:       number;
  max?:       number;
}

export interface FkFieldDef {
  key:        TechnicalDetailsFieldKey;
  label:      string;
  kind:       'fk';
  lookupType: LookupType;
  /** Polymorphic tablo için filter (örn. 'OB_VAN'); undefined → polymorphic değil. */
  polymorphicType?: string;
}

export type FieldDef = ScalarFieldDef | FkFieldDef;

export interface FieldGroupDef {
  /** mat-expansion-panel id; URL hash veya state için. */
  id:     string;
  title:  string;
  hint?:  string;
  fields: FieldDef[];
}

/**
 * Teknik form mantıksal grupları — REQUIREMENTS-LIVE-PLAN-TECHNICAL-FIELDS-V1.md
 * §5.1-§5.6 sırasını takip eder; 2026-05-13 itibarıyla §5.2 "Ortak" ve §5.3
 * "IRD / Fiber" Düzenle dialog'a taşındığı için 4 grup kaldı.
 */
export const FIELD_GROUPS: readonly FieldGroupDef[] = [
  {
    id: 'yayin-ob',
    title: 'Yayın / OB',
    hint: '14 alan — operasyonel lokasyon ve teknik firma bilgileri.',
    fields: [
      { key: 'broadcastLocationId', label: 'Yayın Yeri',     kind: 'fk', lookupType: 'live_plan_locations' },
      { key: 'obVanCompanyId',      label: 'Obvan Firma',    kind: 'fk', lookupType: 'technical_companies', polymorphicType: 'OB_VAN' },
      { key: 'generatorCompanyId',  label: 'Jeneratör Firma', kind: 'fk', lookupType: 'technical_companies', polymorphicType: 'GENERATOR' },
      { key: 'jimmyJibId',          label: 'Jimmy Jib',      kind: 'fk', lookupType: 'live_plan_equipment_options', polymorphicType: 'JIMMY_JIB' },
      { key: 'steadicamId',         label: 'Stedicam',       kind: 'fk', lookupType: 'live_plan_equipment_options', polymorphicType: 'STEADICAM' },
      { key: 'sngCompanyId',        label: 'SNG Firma',      kind: 'fk', lookupType: 'technical_companies', polymorphicType: 'SNG' },
      { key: 'carrierCompanyId',    label: 'Taşıyıcı Firma', kind: 'fk', lookupType: 'technical_companies', polymorphicType: 'CARRIER' },
      { key: 'ibmId',               label: 'IBM',            kind: 'fk', lookupType: 'live_plan_equipment_options', polymorphicType: 'IBM' },
      { key: 'usageLocationId',     label: 'Kullanım Yeri',  kind: 'fk', lookupType: 'live_plan_usage_locations' },
      { key: 'fixedPhone1',         label: 'Sabit Tel 1',    kind: 'string', maxLength: 80 },
      { key: 'secondObVanId',       label: '2. Obvan',       kind: 'fk', lookupType: 'technical_companies', polymorphicType: 'OB_VAN' },
      { key: 'regionId',            label: 'Bölge',          kind: 'fk', lookupType: 'live_plan_regions' },
      { key: 'cameraCount',         label: 'Kamera Adedi',   kind: 'int', min: 0, max: 99 },
      { key: 'fixedPhone2',         label: 'Sabit Tel 2',    kind: 'string', maxLength: 80 },
    ],
  },
  // 2026-05-13: §5.2 "Ortak" (11 alan) + §5.3 "IRD / Fiber" (5 alan) tamamen
  // kaldırıldı; §5.4'ten `modulationTypeId` + `videoCodingId` çıkarıldı.
  // Toplam 18 alanın UI sahipliği Düzenle dialog'una (Yayın Adı / Karşılaşma /
  // Kanal / Transmisyon Zamanı + 16 lookup-select grid) verildi — canonical
  // edit yeri. DB kolonları korunur. ALL_FIELDS = FIELD_GROUPS.flatMap
  // olduğu için bu 18 key Teknik form state/diff/PATCH payload'una asla
  // girmez; mevcut değerler Düzenle PATCH'lemediği sürece dokunulmaz.
  {
    id: 'ana-feed',
    title: 'Ana Feed / Transmisyon',
    hint: '19 alan — ana feed uydu/uplink/downlink (Mod Tipi + Video Coding Düzenle\'de).',
    fields: [
      { key: 'feedTypeId',             label: 'Feed Type',           kind: 'fk', lookupType: 'transmission_feed_types' },
      { key: 'satelliteId',            label: 'Uydu Adı',            kind: 'fk', lookupType: 'transmission_satellites' },
      { key: 'txp',                    label: 'TXP',                 kind: 'string', maxLength: 120 },
      { key: 'satChannel',             label: 'Sat Chl',             kind: 'string', maxLength: 120 },
      { key: 'uplinkFrequency',        label: 'Uplink Frekansı',     kind: 'string', maxLength: 120 },
      { key: 'uplinkPolarizationId',   label: 'Up. Polarizasyon',    kind: 'fk', lookupType: 'transmission_polarizations' },
      { key: 'downlinkFrequency',      label: 'Downlink Frekansı',   kind: 'string', maxLength: 120 },
      { key: 'downlinkPolarizationId', label: 'Dwn. Polarizasyon',   kind: 'fk', lookupType: 'transmission_polarizations' },
      { key: 'rollOffId',              label: 'Roll Off',            kind: 'fk', lookupType: 'transmission_roll_offs' },
      { key: 'audioConfigId',          label: 'Audio Config',        kind: 'fk', lookupType: 'transmission_audio_configs' },
      { key: 'preMatchKey',            label: 'Maç Önü Key',         kind: 'string', maxLength: 200 },
      { key: 'matchKey',               label: 'Maç Key',             kind: 'string', maxLength: 200 },
      { key: 'postMatchKey',           label: 'Maç Sonu Key',        kind: 'string', maxLength: 200 },
      { key: 'isoFeedId',              label: 'Iso Feed',            kind: 'fk', lookupType: 'transmission_iso_feed_options' },
      { key: 'keyTypeId',              label: 'Key Tipi',            kind: 'fk', lookupType: 'transmission_key_types' },
      { key: 'symbolRate',             label: 'Symbol Rate',         kind: 'string', maxLength: 80 },
      { key: 'fecRateId',              label: 'Fec Rate',            kind: 'fk', lookupType: 'transmission_fec_rates' },
      { key: 'bandwidth',              label: 'Bant Genişliği',      kind: 'string', maxLength: 80 },
      { key: 'uplinkFixedPhone',       label: 'Sabit Tel 3 (Uplink)', kind: 'string', maxLength: 80 },
    ],
  },
  {
    id: 'yedek-feed',
    title: 'Yedek Feed',
    hint: '19 alan — Ana Feed mirror (iso_feed / uplink_fixed_phone yok).',
    fields: [
      { key: 'backupFeedTypeId',             label: 'Feed Type Yedek',          kind: 'fk', lookupType: 'transmission_feed_types' },
      { key: 'backupSatelliteId',            label: 'Uydu Adı Yedek',           kind: 'fk', lookupType: 'transmission_satellites' },
      { key: 'backupTxp',                    label: 'TXP Yedek',                kind: 'string', maxLength: 120 },
      { key: 'backupSatChannel',             label: 'Sat Chl Yedek',            kind: 'string', maxLength: 120 },
      { key: 'backupUplinkFrequency',        label: 'Uplink Frekansı Yedek',    kind: 'string', maxLength: 120 },
      { key: 'backupUplinkPolarizationId',   label: 'Up. Polarizasyon Yedek',   kind: 'fk', lookupType: 'transmission_polarizations' },
      { key: 'backupDownlinkFrequency',      label: 'Downlink Frekansı Yedek',  kind: 'string', maxLength: 120 },
      { key: 'backupDownlinkPolarizationId', label: 'Dwn. Polarizasyon Yedek',  kind: 'fk', lookupType: 'transmission_polarizations' },
      { key: 'backupModulationTypeId',       label: 'Mod Tipi Yedek',           kind: 'fk', lookupType: 'transmission_modulation_types' },
      { key: 'backupRollOffId',              label: 'Roll Off Yedek',           kind: 'fk', lookupType: 'transmission_roll_offs' },
      { key: 'backupVideoCodingId',          label: 'Video Coding Yedek',       kind: 'fk', lookupType: 'transmission_video_codings' },
      { key: 'backupAudioConfigId',          label: 'Audio Config Yedek',       kind: 'fk', lookupType: 'transmission_audio_configs' },
      { key: 'backupPreMatchKey',            label: 'Maç Önü Key Yedek',        kind: 'string', maxLength: 200 },
      { key: 'backupMatchKey',               label: 'Maç Key Yedek',            kind: 'string', maxLength: 200 },
      { key: 'backupPostMatchKey',           label: 'Maç Sonu Key Yedek',       kind: 'string', maxLength: 200 },
      { key: 'backupKeyTypeId',              label: 'Key Tipi Yedek',           kind: 'fk', lookupType: 'transmission_key_types' },
      { key: 'backupSymbolRate',             label: 'Symbol Rate Yedek',        kind: 'string', maxLength: 80 },
      { key: 'backupFecRateId',              label: 'Fec Rate Yedek',           kind: 'fk', lookupType: 'transmission_fec_rates' },
      { key: 'backupBandwidth',              label: 'Bant Genişliği Yedek',     kind: 'string', maxLength: 80 },
    ],
  },
  {
    id: 'fiber-format',
    title: 'Fiber',
    hint: '4 alan — fiber firma + ses/video format + bant genişliği.',
    fields: [
      { key: 'fiberCompanyId',     label: 'Fiber Firma',         kind: 'fk', lookupType: 'technical_companies', polymorphicType: 'FIBER' },
      { key: 'fiberAudioFormatId', label: 'Fiber Audio Format',  kind: 'fk', lookupType: 'fiber_audio_formats' },
      { key: 'fiberVideoFormatId', label: 'Fiber Video Format',  kind: 'fk', lookupType: 'fiber_video_formats' },
      { key: 'fiberBandwidth',     label: 'Fiber Bant Genişliği', kind: 'string', maxLength: 80 },
    ],
  },
];

/**
 * Teknik form'da render edilen 56 alanın düz listesi (sıra: §5.1 → §5.4 → §5.5 → §5.6).
 *
 * 2026-05-13: 18 alan Düzenle dialog canonical edit yeri olduğu için
 * FIELD_GROUPS'tan çıkarıldı (§5.2 Ortak 11 + §5.3 IRD/Fiber 5 + §5.4'ten
 * mod/coding 2). TechnicalDetailsRow / TechnicalDetailsBaseFields /
 * TechnicalDetailsFieldKey tip seviyesinde 73 keyin tamamı korunur — API
 * contract değişmedi. ALL_FIELDS yalnız UI render + state/diff iteration
 * scope'unu temsil eder; Düzenle alanları PATCH payload'una buradan girmez,
 * Düzenle kendi `buildTechDiff` üzerinden yazar.
 */
export const ALL_FIELDS: readonly FieldDef[] = FIELD_GROUPS.flatMap((g) => g.fields);
