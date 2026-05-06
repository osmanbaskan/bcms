import { z } from 'zod';
import { EQUIPMENT_TYPES, TECHNICAL_COMPANY_TYPES } from './lookup.registry.js';

/**
 * Madde 5 M5-B5 (L6 lock): Lookup CRUD Zod schemas.
 *
 * Standart kolonlar: label/active/sortOrder/type? (polymorphic).
 *   - label: trim().min(1).max(200)
 *   - active: boolean default true
 *   - sortOrder: int >=0 default 0
 *   - type: enum (sadece polymorphic; create'te zorunlu, PATCH'te yok — L11)
 *
 * PATCH (L10):
 *   - label, active, sortOrder, deletedAt sadece null kabul eder (restore).
 *   - deletedAt=<date> reddedilir (DELETE endpoint zaten var).
 *   - type immutable (polymorphic).
 *   - Min 1 field zorunlu.
 */

const labelSchema = z.string().trim().min(1).max(200);

/** Polymorphic type enum'ları — registry'den. */
const technicalCompanyTypeSchema = z.enum(TECHNICAL_COMPANY_TYPES);
const equipmentTypeSchema        = z.enum(EQUIPMENT_TYPES);

/**
 * Create base — tüm lookup'lar için ortak.
 */
const createBaseLookupSchema = z.object({
  label:     labelSchema,
  active:    z.boolean().optional().default(true),
  sortOrder: z.coerce.number().int().min(0).optional().default(0),
});

/**
 * Polymorphic create — `type` zorunlu (whitelist enum).
 * Route handler registry'ye göre doğru schema seçer.
 */
export const createTechnicalCompanySchema = createBaseLookupSchema.extend({
  type: technicalCompanyTypeSchema,
});

export const createEquipmentOptionSchema = createBaseLookupSchema.extend({
  type: equipmentTypeSchema,
});

/** Non-polymorphic create — type yok. */
export const createLookupSchema = createBaseLookupSchema.strict();

export type CreateLookupDto                 = z.input<typeof createLookupSchema>;
export type CreateTechnicalCompanyDto       = z.input<typeof createTechnicalCompanySchema>;
export type CreateEquipmentOptionDto        = z.input<typeof createEquipmentOptionSchema>;

/**
 * Update (PATCH) — tüm fields optional; deletedAt SADECE null kabul (L10);
 * type yok (L11 immutable).
 *   .strict() ile bilinmeyen field'ları reject — type spoofing engeli.
 *   .refine min 1 field.
 */
export const updateLookupSchema = z.object({
  label:     labelSchema.optional(),
  active:    z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  // L10: deletedAt sadece null (restore); non-null reddedilir.
  deletedAt: z.null().optional(),
}).strict().refine(
  (d) => Object.keys(d).length > 0,
  { message: 'En az bir field güncellenmeli' },
);

export type UpdateLookupDto = z.input<typeof updateLookupSchema>;

/**
 * List query — pagination + filter.
 * - activeOnly default true (L8)
 * - includeDeleted default false; route handler write-yetki kontrolü yapar (L8)
 * - type (polymorphic için filter): registry validation route'ta
 */
export const listLookupQuerySchema = z.object({
  activeOnly:      z.coerce.boolean().optional().default(true),
  includeDeleted:  z.coerce.boolean().optional().default(false),
  type:            z.string().trim().min(1).max(30).optional(),
  page:            z.coerce.number().int().positive().default(1),
  pageSize:        z.coerce.number().int().positive().max(200).default(50),
});

export type ListLookupQuery = z.infer<typeof listLookupQuerySchema>;
