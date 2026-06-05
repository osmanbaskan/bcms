import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@bcms/shared';
import { currentUser } from './news.service.js';
import { getNewsSettingsDto, writeNewsSettings, type NewsSettingsDto } from './news-settings.js';

const smbPathSchema = z
  .string()
  .max(400)
  .refine((v) => v === '' || /^smb:\/\/[^/]+\/[^/]+/i.test(v), 'smb://host/share/... bekleniyor');

const patchSchema = z.object({
  aaApiUser: z.string().max(100).optional(),
  aaApiPassword: z.string().max(200).optional(),
  aaApiBase: z.string().max(300).optional(),
  aaApiPollSeconds: z.coerce.number().int().min(60).max(86_400).optional(),
  aaApiFilterType: z.string().max(40).optional(),
  aaApiFilterLanguage: z.string().max(40).optional(),
  aaApiFilterCategory: z.string().max(120).optional(),
  aaApiEnabled: z.boolean().optional(),
  // EGS dışa-aktarım
  egsExportEnabled: z.boolean().optional(),
  egsPrompterPath: smbPathSchema.optional(),
  egsXmlPath: smbPathSchema.optional(),
  egsSmbUser: z.string().max(100).optional(),
  egsSmbPassword: z.string().max(200).optional(),
  egsSmbDomain: z.string().max(100).optional(),
});

/**
 * Haber > AA bağlantı ayarları — /api/v1/news/settings (SystemEng + Admin).
 * GET maskeli efektif (env+DB) ayar; PUT kısmi güncelle (şifre maske/boş yazılmaz).
 */
export async function newsSettingsRoutes(app: FastifyInstance) {
  app.get('/settings', {
    preHandler: app.requireGroup(...PERMISSIONS.news.settings),
    schema: { tags: ['News'], summary: 'Haber > AA bağlantı ayarları (maskeli)' },
  }, async (): Promise<NewsSettingsDto> => {
    return getNewsSettingsDto(app.prisma);
  });

  app.put('/settings', {
    preHandler: app.requireGroup(...PERMISSIONS.news.settings),
    schema: { tags: ['News'], summary: 'Haber > AA + EGS ayarlarını kaydet' },
  }, async (request): Promise<NewsSettingsDto> => {
    const patch = patchSchema.parse(request.body);
    await writeNewsSettings(app.prisma, patch, currentUser(request));
    return getNewsSettingsDto(app.prisma);
  });
}
