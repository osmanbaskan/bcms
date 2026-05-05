import { beforeEach, describe, expect, test } from 'vitest';
import { cleanupTransactional, getRawPrisma } from '../../../test/integration/helpers.js';

/**
 * DB-level constraints integration spec — Madde 4 son temizlik.
 *
 * Production CHECK constraint (`schedules_usage_scope_check`) gerçekten zorlanıyor
 * mu — schema/zod katmanını bypass eden raw SQL yazımıyla doğrulanır.
 *
 * Test setup'ı `applyTestConstraints()` ile constraint'i manuel reapply eder
 * (Madde 1 migration baseline çözüldükten sonra `migrate reset` ile otomatik gelir).
 *
 * FK-valid channel_id (seed'deki id=1) kullanılır; failure FK'den DEĞİL CHECK'ten
 * gelmeli — guard test isminde de açık.
 */

describe('DB Constraints — integration', () => {
  beforeEach(async () => {
    await cleanupTransactional();
  });

  test('CHECK schedules_usage_scope_check: invalid usage_scope FK-valid satır için CHECK ile reddedilir', async () => {
    const prisma = getRawPrisma();

    // updated_at NOT NULL (Prisma @updatedAt; raw SQL'de manuel set).
    // Önce sanity: aynı SQL valid usage_scope ile başarılı (CHECK testinin
    // diğer NOT NULL/FK sebepleriyle değil gerçekten CHECK ile reddedildiğini doğrular).
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "schedules"
          ("channel_id", "start_time", "end_time", "title", "usage_scope", "created_by", "updated_at")
        VALUES
          (1, NOW(), NOW() + INTERVAL '1 hour', 'CHECK sanity (valid)', 'broadcast', 'test', NOW())
      `),
    ).resolves.toBeGreaterThanOrEqual(1);

    // Asıl test: invalid usage_scope (FK valid: channel_id=1 seed mevcut, NOT NULL'lar sağlandı).
    let caught: unknown;
    try {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "schedules"
          ("channel_id", "start_time", "end_time", "title", "usage_scope", "created_by", "updated_at")
        VALUES
          (1, NOW(), NOW() + INTERVAL '1 hour', 'CHECK fail expected', 'invalid_scope', 'test', NOW())
      `);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    // Hata mesajı CHECK'i işaret etmeli; FK violation değil.
    const msg = String((caught as { message?: string })?.message ?? caught);
    expect(msg.toLowerCase()).toMatch(/check.*usage_scope|usage_scope.*check|schedules_usage_scope_check/);
    expect(msg.toLowerCase()).not.toMatch(/foreign key|fkey/);
  });

  test('CHECK constraint idempotent reapply (helper guard): ikinci çağrı hata vermez', async () => {
    const { applyTestConstraints } = await import('../../../test/integration/helpers.js');
    // İlk reapply (setup.ts'de zaten yapıldı; tekrar çağrı idempotent olmalı).
    await expect(applyTestConstraints()).resolves.toBeUndefined();
    await expect(applyTestConstraints()).resolves.toBeUndefined();
  });
});
