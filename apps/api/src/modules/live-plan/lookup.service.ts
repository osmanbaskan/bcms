import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  type LookupRow,
  type LookupType,
  LOOKUP_REGISTRY,
  getLookupDelegate,
} from './lookup.registry.js';

/**
 * Madde 5 M5-B5 (L1-L12 lock 2026-05-06):
 * Lookup tabloları generic CRUD service.
 *
 * - L3 single service + registry adapter pattern.
 * - L4 audit Prisma write üzerinden otomatik (raw SQL yok).
 * - L5 DELETE soft (deletedAt=NOW + active=false); restore PATCH deletedAt=null.
 * - L7 pagination 50/200; L8 activeOnly default + includeDeleted write-only.
 * - L9 ORDER BY active DESC, sort_order ASC, label ASC.
 * - L10 PATCH allowed: label/active/sortOrder/deletedAt:null.
 * - L11 polymorphic type immutable (PATCH'te kabul edilmez; service rejects).
 * - L12 optimistic locking YOK V1.
 *
 * Audit (K10): Prisma model adı `entityType` olarak otomatik audit_logs'a yazılır.
 * Polymorphic tablolar tek model adı paylaşır (TechnicalCompany / LivePlanEquipmentOption).
 */

export interface ListLookupResult {
  items:    LookupRow[];
  total:    number;
  page:     number;
  pageSize: number;
}

export interface ListLookupParams {
  activeOnly:     boolean;
  includeDeleted: boolean;
  type?:          string;
  page:           number;
  pageSize:       number;
}

export class LookupService {
  constructor(private readonly app: FastifyInstance) {}

  // ── List ───────────────────────────────────────────────────────────────────
  async list(lookupType: LookupType, params: ListLookupParams): Promise<ListLookupResult> {
    const config   = LOOKUP_REGISTRY[lookupType];
    const delegate = getLookupDelegate(this.app.prisma, lookupType);

    const where: Record<string, unknown> = {};

    if (!params.includeDeleted) {
      where.deletedAt = null;
    }
    if (params.activeOnly) {
      where.active = true;
    }
    if (params.type !== undefined) {
      this.validatePolymorphicType(lookupType, params.type);
      where.type = params.type;
    }

    const [items, total] = await Promise.all([
      delegate.findMany({
        where,
        orderBy: [{ active: 'desc' }, { sortOrder: 'asc' }, { label: 'asc' }],
        skip:  (params.page - 1) * params.pageSize,
        take:  params.pageSize,
      }),
      delegate.count({ where }),
    ]);

    // config not used after polymorphic check; suppress lint via underscore
    void config;
    return { items, total, page: params.page, pageSize: params.pageSize };
  }

  // ── Detail ─────────────────────────────────────────────────────────────────
  async getById(lookupType: LookupType, id: number): Promise<LookupRow> {
    const delegate = getLookupDelegate(this.app.prisma, lookupType);
    const row = await delegate.findUnique({ where: { id } });
    if (!row) {
      throw Object.assign(new Error('Lookup not found'), { statusCode: 404 });
    }
    // Soft-deleted row detail erişimi sadece write-yetkili — route layer'da
    // includeDeleted check yok burada; service-level pure lookup.
    // (UI use-case: restore için detail görüntüleme).
    return row;
  }

  // ── Create ─────────────────────────────────────────────────────────────────
  /**
   * data: validated DTO (Zod sonrası); polymorphic ise type field içerir.
   * Polymorphic doğrulama service-level (registry'den allowedTypes).
   */
  async create(
    lookupType: LookupType,
    data: { label: string; active?: boolean; sortOrder?: number; type?: string },
  ): Promise<LookupRow> {
    const config   = LOOKUP_REGISTRY[lookupType];
    const delegate = getLookupDelegate(this.app.prisma, lookupType);

    if (config.polymorphic) {
      if (data.type === undefined) {
        throw Object.assign(
          new Error(`type field zorunlu (polymorphic ${lookupType})`),
          { statusCode: 400 },
        );
      }
      this.validatePolymorphicType(lookupType, data.type);
    } else if (data.type !== undefined) {
      throw Object.assign(
        new Error(`type field bu lookup tipinde kullanılmıyor (${lookupType})`),
        { statusCode: 400 },
      );
    }

    try {
      return await delegate.create({
        data: {
          label:     data.label,
          active:    data.active     ?? true,
          sortOrder: data.sortOrder  ?? 0,
          ...(config.polymorphic && data.type !== undefined ? { type: data.type } : {}),
        },
      });
    } catch (err) {
      this.handleUniqueViolation(err);
    }
  }

  // ── Update (PATCH; L10/L11/L12) ────────────────────────────────────────────
  async update(
    lookupType: LookupType,
    id: number,
    data: { label?: string; active?: boolean; sortOrder?: number; deletedAt?: null },
  ): Promise<LookupRow> {
    const delegate = getLookupDelegate(this.app.prisma, lookupType);

    // Existence check (route handler 404 döndürür if not found).
    const existing = await delegate.findUnique({ where: { id } });
    if (!existing) {
      throw Object.assign(new Error('Lookup not found'), { statusCode: 404 });
    }

    const updateData: Record<string, unknown> = {};
    if (data.label !== undefined)     updateData.label     = data.label;
    if (data.active !== undefined)    updateData.active    = data.active;
    if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
    // L10: deletedAt sadece null (restore). Zod schema zaten enforce eder
    // (.strict() + z.null()), defensive olarak burada da kontrol.
    if ('deletedAt' in data) {
      if (data.deletedAt !== null) {
        throw Object.assign(
          new Error('deletedAt PATCH ile sadece null (restore) olabilir; soft delete için DELETE endpoint kullanın'),
          { statusCode: 400 },
        );
      }
      updateData.deletedAt = null;
    }

    try {
      return await delegate.update({ where: { id }, data: updateData });
    } catch (err) {
      this.handleUniqueViolation(err);
    }
  }

  // ── Soft Delete (L5) ───────────────────────────────────────────────────────
  /**
   * deletedAt=NOW + active=false (atomik). Restore için PATCH deletedAt=null
   * kullanılır.
   */
  async softDelete(lookupType: LookupType, id: number): Promise<LookupRow> {
    const delegate = getLookupDelegate(this.app.prisma, lookupType);

    const existing = await delegate.findUnique({ where: { id } });
    if (!existing) {
      throw Object.assign(new Error('Lookup not found'), { statusCode: 404 });
    }
    // Idempotent: zaten soft-deleted ise tekrar silmeye gerek yok.
    if (existing.deletedAt !== null) {
      return existing;
    }

    return delegate.update({
      where: { id },
      data:  {
        deletedAt: new Date(),
        active:    false,
      },
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private validatePolymorphicType(lookupType: LookupType, candidate: string): void {
    const config = LOOKUP_REGISTRY[lookupType];
    if (!config.polymorphic) {
      return; // non-polymorphic — type filter göz ardı
    }
    const allowed = config.allowedTypes as readonly string[] | undefined;
    if (!allowed?.includes(candidate)) {
      throw Object.assign(
        new Error(
          `type='${candidate}' geçersiz; ${lookupType} için izin verilenler: ${allowed?.join(', ')}`,
        ),
        { statusCode: 400 },
      );
    }
  }

  private handleUniqueViolation(err: unknown): never {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw Object.assign(
        new Error('Aynı label ile aktif kayıt zaten mevcut (case-insensitive)'),
        { statusCode: 409 },
      );
    }
    throw err;
  }
}
