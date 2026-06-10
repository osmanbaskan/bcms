/**
 * Capture Web Service REST routes (Faz 0 — SALT-OKUMA).
 *
 *  GET /api/v1/capture/settings → ayarlar + efektif config (sır yok, maske gerekmez)
 *  PUT /api/v1/capture/settings → wsUrl / connectionEnabled / writeEnabled / pollSeconds
 *      ⛔ writeEnabled (ON/OFF yazma anahtarı): YALNIZ Admin + Ingest
 *        (PERMISSIONS.capture.settings = [Ingest]; Admin auto-bypass).
 *  GET /api/v1/capture/health   → ELLE tetiklenen bağlantı testi:
 *      connectionEnabled=false veya wsUrl boş → ağa ÇIKMADAN 'disabled' döner.
 *      Aktifse: TCP probe + WSDL fetch + operasyon envanteri (read/write sınıflı).
 *
 * Otomatik/periyodik HİÇBİR çağrı yok (worker Faz 1'de, ayrı onayla).
 * Bu modülde Capture'a YAZAN endpoint yok ve bu fazda eklenemez (2026-06-10 emri).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, type JwtPayload } from '@bcms/shared';
import { loadCaptureConfig } from './capture.config.js';
import { tcpProbe, fetchWsdl } from './capture.client.js';

const settingsPatchSchema = z.object({
  wsUrl:             z.string().trim().max(300).nullable().optional(),
  connectionEnabled: z.boolean().optional(),
  writeEnabled:      z.boolean().optional(),
  pollSeconds:       z.number().int().min(15).max(3600).optional(),
}).strict();

export async function captureRoutes(app: FastifyInstance) {
  // GET /api/v1/capture/settings
  app.get('/settings', {
    preHandler: app.requireGroup(...PERMISSIONS.capture.read),
    schema: { tags: ['Capture'], summary: 'Capture WS ayarları + efektif config' },
  }, async () => {
    const row = await app.prisma.captureSetting.findUnique({ where: { id: 1 } });
    const effective = await loadCaptureConfig(app.prisma);
    return {
      settings: row ?? null,
      effective: {
        wsUrl: effective.wsUrl,
        connectionEnabled: effective.connectionEnabled,
        writeEnabled: effective.writeEnabled,
        pollSeconds: effective.pollSeconds,
        timeoutMs: effective.timeoutMs,
      },
    };
  });

  // PUT /api/v1/capture/settings — yalnız Admin + Ingest (writeEnabled anahtarı dahil)
  app.put('/settings', {
    preHandler: app.requireGroup(...PERMISSIONS.capture.settings),
    schema: { tags: ['Capture'], summary: 'Capture WS ayarlarını kaydet (Admin+Ingest)' },
  }, async (request) => {
    const patch = settingsPatchSchema.parse(request.body);
    const user = (request.user as JwtPayload | undefined)?.preferred_username ?? null;

    const existing = await app.prisma.captureSetting.findUnique({ where: { id: 1 } });
    const row = existing
      ? await app.prisma.captureSetting.update({
          where: { id: 1 },
          data: { ...patch, updatedBy: user },
        })
      : await app.prisma.captureSetting.create({
          data: { id: 1, ...patch, updatedBy: user },
        });

    if (patch.writeEnabled !== undefined) {
      app.log.warn(
        { writeEnabled: patch.writeEnabled, user },
        'Capture YAZMA anahtarı değiştirildi (bu fazda outbound kod yok; bilgi amaçlı)',
      );
    }
    return row;
  });

  // GET /api/v1/capture/health — elle tetiklenen bağlantı testi (salt-okuma)
  app.get('/health', {
    preHandler: app.requireGroup(...PERMISSIONS.capture.read),
    schema: { tags: ['Capture'], summary: 'Capture WS bağlantı testi (TCP + WSDL, salt-okuma)' },
  }, async (request) => {
    const cfg = await loadCaptureConfig(app.prisma);

    if (!cfg.connectionEnabled || !cfg.wsUrl) {
      // Ağa hiç çıkmadan döner — default güvenli durum.
      return {
        enabled: false,
        wsUrl: cfg.wsUrl,
        reason: !cfg.wsUrl ? 'wsUrl tanımsız' : 'connectionEnabled=false',
      };
    }

    const user = (request.user as JwtPayload | undefined)?.preferred_username ?? null;
    app.log.info({ wsUrl: cfg.wsUrl, user }, 'Capture bağlantı testi (elle) — TCP + WSDL');

    const tcp = await tcpProbe(cfg.wsUrl, cfg.timeoutMs);
    // TCP başarısızsa WSDL'i hiç deneme (canlıya gereksiz istek atma).
    const wsdl = tcp.ok ? await fetchWsdl(cfg.wsUrl, cfg.timeoutMs) : null;

    return {
      enabled: true,
      wsUrl: cfg.wsUrl,
      tcp,
      wsdl: wsdl && {
        ok: wsdl.ok,
        httpStatus: wsdl.httpStatus,
        bytes: wsdl.bytes,
        ms: wsdl.ms,
        error: wsdl.error,
        operationCount: wsdl.operations?.length ?? 0,
        operations: wsdl.operations, // [{name, kind:'read'|'write'}] — keşif envanteri
      },
    };
  });
}
