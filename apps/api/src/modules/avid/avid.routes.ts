/**
 * Avid bağlantı ayarları REST (Ayarlar ekranı).
 *
 *  GET /api/v1/avid/settings  → efektif (env+DB) ayarlar; şifre/token MASKELİ.
 *  PUT /api/v1/avid/settings  → kısmi güncelle; maske/boş sır alanı yazılmaz.
 *
 * Yetki: yalnız SystemEng (+ Admin auto-bypass). Ara+Restore tek user/pass
 * (IPWS); Transfer ayrı Cloud UX URL+token. Kaydedince worker bir sonraki
 * tick'te yeni bilgiyi alır (getAvidAdapter updatedAt imzası).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, type JwtPayload } from '@bcms/shared';
import { loadAvidConfig, applyAvidOverrides } from './avid.config.js';
import {
  readAvidSettings,
  writeAvidSettings,
  toMaskedDto,
  type AvidSettingsPatch,
} from './avid.settings.js';

const patchSchema = z
  .object({
    interplayUrl: z.string().max(500).optional(),
    avidUser:     z.string().max(200).optional(),
    avidPassword: z.string().max(2000).optional(),
    workspace:    z.string().max(500).optional(),
    clouduxUrl:   z.string().max(500).optional(),
    clouduxRealm: z.string().max(200).optional(),
    clouduxToken: z.string().max(8000).optional(),
  })
  .strict();

async function effectiveDto(app: FastifyInstance) {
  const r = await readAvidSettings(app.prisma);
  const cfg = applyAvidOverrides(loadAvidConfig(), r?.overrides ?? null);
  return toMaskedDto(cfg, { updatedBy: r?.updatedBy ?? null, updatedAt: r?.updatedAt ?? null });
}

export async function avidRoutes(app: FastifyInstance) {
  // GET /api/v1/avid/settings — efektif ayarlar (şifre/token maskeli)
  app.get('/settings', {
    preHandler: app.requireGroup(...PERMISSIONS.avidSettings.read),
    schema: { tags: ['Avid'], summary: 'Avid bağlantı ayarları (maskeli)' },
  }, async () => effectiveDto(app));

  // PUT /api/v1/avid/settings — kısmi güncelle
  app.put<{ Body: AvidSettingsPatch }>('/settings', {
    preHandler: app.requireGroup(...PERMISSIONS.avidSettings.write),
    schema: { tags: ['Avid'], summary: 'Avid bağlantı ayarlarını kaydet' },
  }, async (request) => {
    const patch = patchSchema.parse(request.body);
    const user = (request.user as JwtPayload | undefined)?.preferred_username ?? null;
    await writeAvidSettings(app.prisma, patch, user);
    return effectiveDto(app);
  });
}
