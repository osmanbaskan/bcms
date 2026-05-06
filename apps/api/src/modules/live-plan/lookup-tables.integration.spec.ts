import { beforeEach, describe, expect, test } from 'vitest';
import { cleanupTransactional, getRawPrisma } from '../../../test/integration/helpers.js';

/**
 * Madde 5 M5-B4 spec — Lookup tabloları schema sanity.
 *
 * Tasarım: ops/REQUIREMENTS-LIVE-PLAN-TECHNICAL-FIELDS-V1.md §3 (25 lookup tablo)
 * Lock: K15.6-K15.9 + ek kurallar (DECISION §3.4).
 *
 * Test kapsamı (sadece schema mekaniği; service/route M5-B5+):
 *   ✓ Standard kolon set (label/active/sort_order/timestamps/deletedAt)
 *   ✓ CHECK length(trim(label)) > 0 — boş whitespace label engeli
 *   ✓ Partial unique LOWER(label) WHERE deleted_at IS NULL
 *     - case-insensitive: 'IRD - 1' / 'ird - 1' aynı satır
 *     - soft-deleted aynı label ile yeni kayıt açılabilir
 *   ✓ Type-polymorphic tabloda (type, LOWER(label)) partial unique
 *   ✓ Type CHECK constraint (technical_companies, equipment_options)
 *   ✓ live_plan_entries.metadata kolonu DROP edildi (schema'da yok)
 */

describe('LookupTables — schema foundation (DB integration)', () => {
  beforeEach(async () => {
    await cleanupTransactional();
  });

  // ── §1. Standard kolon set ─────────────────────────────────────────────
  test('transmission_irds: standard kolon set + defaults', async () => {
    const prisma = getRawPrisma();
    const created = await prisma.transmissionIrd.create({
      data: { label: 'IRD - 999' },
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.label).toBe('IRD - 999');
    expect(created.active).toBe(true);
    expect(created.sortOrder).toBe(0);
    expect(created.deletedAt).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  // ── §2. CHECK length(trim(label)) > 0 ─────────────────────────────────
  test('CHECK label_not_blank: boş string → 23514 violation', async () => {
    const prisma = getRawPrisma();
    await expect(
      prisma.$executeRawUnsafe(`INSERT INTO transmission_irds (label) VALUES ('')`),
    ).rejects.toThrow();
  });

  test('CHECK label_not_blank: sadece whitespace → 23514 violation', async () => {
    const prisma = getRawPrisma();
    await expect(
      prisma.$executeRawUnsafe(`INSERT INTO transmission_irds (label) VALUES ('   ')`),
    ).rejects.toThrow();
  });

  test('CHECK label_not_blank: meaningful label OK', async () => {
    const prisma = getRawPrisma();
    const r = await prisma.transmissionIrd.create({ data: { label: '  Padded label  ' } });
    expect(r.label).toBe('  Padded label  '); // padding kalır; trim kontrolü sadece "tüm whitespace" engeli
  });

  // ── §3. Partial unique LOWER(label) ────────────────────────────────────
  test('partial unique LOWER(label): aynı label case-insensitive 2. ekleme → P2002', async () => {
    const prisma = getRawPrisma();
    await prisma.transmissionIrd.create({ data: { label: 'IRD - X' } });
    await expect(
      prisma.transmissionIrd.create({ data: { label: 'ird - x' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  test('partial unique: soft-deleted label aynı isimle yeni kayıt OK', async () => {
    const prisma = getRawPrisma();
    const a = await prisma.transmissionIrd.create({ data: { label: 'IRD - Y' } });

    // Soft delete
    await prisma.transmissionIrd.update({
      where: { id: a.id },
      data:  { deletedAt: new Date() },
    });

    // Aynı label ile yeni kayıt — partial unique (WHERE deleted_at IS NULL) ile çakışmaz
    const b = await prisma.transmissionIrd.create({ data: { label: 'IRD - Y' } });
    expect(b.id).not.toBe(a.id);
    expect(b.label).toBe('IRD - Y');
    expect(b.deletedAt).toBeNull();
  });

  // ── §4. Type-polymorphic: technical_companies ─────────────────────────
  test('technical_companies: type CHECK — geçerli value OK', async () => {
    const prisma = getRawPrisma();
    const c = await prisma.technicalCompany.create({
      data: { type: 'OB_VAN', label: 'Test OB Firma' },
    });
    expect(c.type).toBe('OB_VAN');
  });

  test('technical_companies: type CHECK — geçersiz value 23514', async () => {
    const prisma = getRawPrisma();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO technical_companies (type, label) VALUES ('INVALID_TYPE', 'X')`,
      ),
    ).rejects.toThrow();
  });

  test('technical_companies: (type, LOWER(label)) partial unique — aynı type+label çakışır', async () => {
    const prisma = getRawPrisma();
    await prisma.technicalCompany.create({ data: { type: 'OB_VAN', label: 'AcmeCo' } });
    await expect(
      prisma.technicalCompany.create({ data: { type: 'OB_VAN', label: 'acmeco' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  test('technical_companies: aynı label farklı type → OK (type ayrımı)', async () => {
    const prisma = getRawPrisma();
    const a = await prisma.technicalCompany.create({ data: { type: 'OB_VAN', label: 'SharedName' } });
    const b = await prisma.technicalCompany.create({ data: { type: 'GENERATOR', label: 'SharedName' } });
    expect(a.id).not.toBe(b.id);
    expect(a.type).toBe('OB_VAN');
    expect(b.type).toBe('GENERATOR');
  });

  // ── §5. Type-polymorphic: live_plan_equipment_options ─────────────────
  test('live_plan_equipment_options: type CHECK — geçerli value OK', async () => {
    const prisma = getRawPrisma();
    const e = await prisma.livePlanEquipmentOption.create({
      data: { type: 'JIMMY_JIB', label: 'Demo Jib' },
    });
    expect(e.type).toBe('JIMMY_JIB');
  });

  test('live_plan_equipment_options: type CHECK — geçersiz value 23514', async () => {
    const prisma = getRawPrisma();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO live_plan_equipment_options (type, label) VALUES ('UNKNOWN', 'X')`,
      ),
    ).rejects.toThrow();
  });

  // ── §6. live_plan_entries.metadata DROP doğrulama ─────────────────────
  test('live_plan_entries.metadata kolonu DROP edildi (schemada yok)', async () => {
    const prisma = getRawPrisma();
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'live_plan_entries' AND column_name = 'metadata'
    `;
    expect(cols).toHaveLength(0);
  });

  // ── §7. Sanity: 25 lookup tablo mevcut ─────────────────────────────────
  test('25 lookup tablo information_schema\'da mevcut', async () => {
    const prisma = getRawPrisma();
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'transmission_satellites','transmission_irds','transmission_fibers',
        'transmission_int_resources','transmission_tie_options','transmission_demod_options',
        'transmission_virtual_resources','transmission_feed_types','transmission_modulation_types',
        'transmission_video_codings','transmission_audio_configs','transmission_key_types',
        'transmission_polarizations','transmission_fec_rates','transmission_roll_offs',
        'transmission_iso_feed_options','technical_companies','live_plan_equipment_options',
        'live_plan_locations','live_plan_usage_locations','live_plan_regions',
        'live_plan_languages','live_plan_off_tube_options',
        'fiber_audio_formats','fiber_video_formats'
      )
    `;
    expect(rows).toHaveLength(25);
  });

  // ── §8. Soft-delete + active flag ──────────────────────────────────────
  test('active flag toggle + soft delete davranışı', async () => {
    const prisma = getRawPrisma();
    const c = await prisma.transmissionFeedType.create({
      data: { label: 'Test Feed Type', active: true },
    });

    // Active toggle
    const inactive = await prisma.transmissionFeedType.update({
      where: { id: c.id },
      data:  { active: false },
    });
    expect(inactive.active).toBe(false);
    expect(inactive.deletedAt).toBeNull();

    // Soft delete
    const soft = await prisma.transmissionFeedType.update({
      where: { id: c.id },
      data:  { deletedAt: new Date() },
    });
    expect(soft.deletedAt).not.toBeNull();
  });

  // ── §9. sortOrder default 0; manuel set OK ─────────────────────────────
  test('sortOrder default 0 + manuel set OK', async () => {
    const prisma = getRawPrisma();
    const a = await prisma.transmissionPolarization.create({ data: { label: 'X' } });
    expect(a.sortOrder).toBe(0);

    const b = await prisma.transmissionPolarization.create({
      data: { label: 'Y', sortOrder: 42 },
    });
    expect(b.sortOrder).toBe(42);
  });
});
