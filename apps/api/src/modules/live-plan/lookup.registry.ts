import type { PrismaClient } from '@prisma/client';

/**
 * Madde 5 M5-B5 (decision §3.4 + L1-L12 lock 2026-05-06):
 * Live-plan lookup tabloları registry — generic CRUD service için
 * type → Prisma model + polymorphic config eşlemesi.
 *
 * 25 lookup tipi:
 *   - 23 düz (polymorphic değil)
 *   - 2 type-polymorphic: technical_companies, live_plan_equipment_options
 *
 * Kullanım: route'tan `:type` parametresi alınır; whitelist'te yoksa 404.
 * Whitelist'te varsa LOOKUP_REGISTRY[type].prismaKey ile delegate seçilir.
 */

/** Polymorphic tablolarda allowed type values. */
export const TECHNICAL_COMPANY_TYPES = ['OB_VAN', 'GENERATOR', 'SNG', 'CARRIER', 'FIBER'] as const;
export const EQUIPMENT_TYPES = ['JIMMY_JIB', 'STEADICAM', 'IBM'] as const;

export type TechnicalCompanyType = (typeof TECHNICAL_COMPANY_TYPES)[number];
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

/** Prisma client delegate isimleri (camelCase model adları). */
type LookupPrismaKey =
  | 'transmissionSatellite'
  | 'transmissionIrd'
  | 'transmissionFiber'
  | 'transmissionIntResource'
  | 'transmissionTieOption'
  | 'transmissionDemodOption'
  | 'transmissionVirtualResource'
  | 'transmissionFeedType'
  | 'transmissionModulationType'
  | 'transmissionVideoCoding'
  | 'transmissionAudioConfig'
  | 'transmissionKeyType'
  | 'transmissionPolarization'
  | 'transmissionFecRate'
  | 'transmissionRollOff'
  | 'transmissionIsoFeedOption'
  | 'technicalCompany'
  | 'livePlanEquipmentOption'
  | 'livePlanLocation'
  | 'livePlanUsageLocation'
  | 'livePlanRegion'
  | 'livePlanLanguage'
  | 'livePlanOffTubeOption'
  | 'fiberAudioFormat'
  | 'fiberVideoFormat';

export interface LookupConfig {
  /** Prisma client delegate adı (örn. `prisma.transmissionIrd`). */
  prismaKey: LookupPrismaKey;
  /** Type-polymorphic mı (technical_companies / live_plan_equipment_options). */
  polymorphic: boolean;
  /** Polymorphic ise allowed type değerleri. */
  allowedTypes?: readonly string[];
}

/**
 * Whitelist registry — route'ta `:type` URL segment'i bu key'lerden biri olmak
 * zorunda; aksi halde 404. Bu yapı SQL injection / model ismi spoofing'e karşı
 * güvenlik anchor'ı.
 */
export const LOOKUP_REGISTRY = {
  transmission_satellites:        { prismaKey: 'transmissionSatellite',       polymorphic: false },
  transmission_irds:              { prismaKey: 'transmissionIrd',             polymorphic: false },
  transmission_fibers:            { prismaKey: 'transmissionFiber',           polymorphic: false },
  transmission_int_resources:     { prismaKey: 'transmissionIntResource',     polymorphic: false },
  transmission_tie_options:       { prismaKey: 'transmissionTieOption',       polymorphic: false },
  transmission_demod_options:     { prismaKey: 'transmissionDemodOption',     polymorphic: false },
  transmission_virtual_resources: { prismaKey: 'transmissionVirtualResource', polymorphic: false },
  transmission_feed_types:        { prismaKey: 'transmissionFeedType',        polymorphic: false },
  transmission_modulation_types:  { prismaKey: 'transmissionModulationType',  polymorphic: false },
  transmission_video_codings:     { prismaKey: 'transmissionVideoCoding',     polymorphic: false },
  transmission_audio_configs:     { prismaKey: 'transmissionAudioConfig',     polymorphic: false },
  transmission_key_types:         { prismaKey: 'transmissionKeyType',         polymorphic: false },
  transmission_polarizations:     { prismaKey: 'transmissionPolarization',    polymorphic: false },
  transmission_fec_rates:         { prismaKey: 'transmissionFecRate',         polymorphic: false },
  transmission_roll_offs:         { prismaKey: 'transmissionRollOff',         polymorphic: false },
  transmission_iso_feed_options:  { prismaKey: 'transmissionIsoFeedOption',   polymorphic: false },
  technical_companies: {
    prismaKey:    'technicalCompany',
    polymorphic:  true,
    allowedTypes: TECHNICAL_COMPANY_TYPES,
  },
  live_plan_equipment_options: {
    prismaKey:    'livePlanEquipmentOption',
    polymorphic:  true,
    allowedTypes: EQUIPMENT_TYPES,
  },
  live_plan_locations:        { prismaKey: 'livePlanLocation',       polymorphic: false },
  live_plan_usage_locations:  { prismaKey: 'livePlanUsageLocation',  polymorphic: false },
  live_plan_regions:          { prismaKey: 'livePlanRegion',         polymorphic: false },
  live_plan_languages:        { prismaKey: 'livePlanLanguage',       polymorphic: false },
  live_plan_off_tube_options: { prismaKey: 'livePlanOffTubeOption',  polymorphic: false },
  fiber_audio_formats:        { prismaKey: 'fiberAudioFormat',       polymorphic: false },
  fiber_video_formats:        { prismaKey: 'fiberVideoFormat',       polymorphic: false },
} as const satisfies Record<string, LookupConfig>;

export type LookupType = keyof typeof LOOKUP_REGISTRY;

export function isValidLookupType(type: string): type is LookupType {
  return type in LOOKUP_REGISTRY;
}

/**
 * Prisma client delegate'ini al. Generic service tarafından kullanılır.
 * Type system 25 farklı delegate'i union olarak tutmak yerine pragmatik
 * `unknown` cast (delegate'lerin operation'ları (findMany/create/update/count)
 * homojen interface'e sahiptir; runtime davranış güvenli).
 */
export function getLookupDelegate(prisma: PrismaClient, type: LookupType): LookupDelegate {
  const config = LOOKUP_REGISTRY[type];
  // Prisma client delegate'i (any cast — 25 model'in tek union type'ı oluşturmak
  // pratik değil; delegate operation'ları uniform).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any)[config.prismaKey] as LookupDelegate;
}

/**
 * Lookup row'ların ortak shape'i. Polymorphic tablolarda `type` alanı dolu;
 * diğerlerinde undefined. M5-B4 schema'da tüm kolonlar eşit.
 */
export interface LookupRow {
  id:         number;
  label:      string;
  active:     boolean;
  sortOrder:  number;
  type?:      string;
  createdAt:  Date;
  updatedAt:  Date;
  deletedAt:  Date | null;
}

/**
 * Generic Prisma delegate interface (uniform operation set). Tüm 25 lookup
 * modeli bu interface'i karşılar.
 */
export interface LookupDelegate {
  findUnique:    (args: { where: { id: number } }) => Promise<LookupRow | null>;
  findFirst:     (args: { where: Record<string, unknown> }) => Promise<LookupRow | null>;
  findMany:      (args: {
    where?:   Record<string, unknown>;
    orderBy?: Array<Record<string, 'asc' | 'desc'>>;
    skip?:    number;
    take?:    number;
  }) => Promise<LookupRow[]>;
  count:         (args: { where?: Record<string, unknown> }) => Promise<number>;
  create:        (args: { data: Record<string, unknown> }) => Promise<LookupRow>;
  update:        (args: { where: { id: number }; data: Record<string, unknown> }) => Promise<LookupRow>;
}
