/**
 * Avid bağlantı ayarları — DB (tek satır `avid_settings`, id=1) okuma/yazma.
 *
 * Ayarlar ekranından düzenlenir. Boş/null alan runtime'da env'e (AVID_*) düşer
 * (`applyAvidOverrides`). Ara + Restore tek user/pass (IPWS); Transfer ayrı
 * Cloud UX URL+token. Şifre/token DB'de düz metin (.env ile eş risk) ama:
 *  - GET yanıtı MASKELİ ('********') döner — gerçek değer asla API'den çıkmaz.
 *  - PUT'ta maske/boş gelen SIR alanı YAZILMAZ (mevcut korunur) — SMB deseni.
 *  - Yalnız SystemEng erişir (route preHandler).
 */
import type { PrismaClient } from '@prisma/client';
import type { AvidConfig, AvidSettingsOverrides } from './avid.config.js';

/** GET yanıtında / PUT'ta SIR alanların yerine konan maske. */
export const AVID_MASK = '********';

/** API GET/PUT şekli. Sır alanları (avidPassword/clouduxToken) GET'te maskeli. */
export interface AvidSettingsDto {
  interplayUrl: string;
  avidUser:     string;
  avidPassword: string;   // GET: '********' (set ise) | ''  ·  PUT: yeni değer | '' (değişme)
  workspace:    string;
  clouduxUrl:   string;
  clouduxRealm: string;
  clouduxToken: string;   // GET: '********' | ''  ·  PUT: yeni değer | '' (değişme)
  updatedBy:    string | null;
  updatedAt:    string | null;
}

/** PUT gövdesi — tüm alanlar opsiyonel. */
export type AvidSettingsPatch = Partial<Omit<AvidSettingsDto, 'updatedBy' | 'updatedAt'>>;

const nzStr = (v: string | null | undefined): string | undefined => {
  const t = (v ?? '').trim();
  return t === '' ? undefined : t;
};
// Sır alan: boşluk içerebilir → trim YAPMA; boş/null → undefined.
const nzSecret = (v: string | null | undefined): string | undefined =>
  v && v !== '' ? v : undefined;

/**
 * DB satırını override'lara çevirir. Yoksa null → getAvidAdapter env'e düşer.
 */
export async function readAvidSettings(
  prisma: PrismaClient,
): Promise<{ overrides: AvidSettingsOverrides; updatedAt: Date; updatedBy: string | null } | null> {
  const row = await prisma.avidSetting.findUnique({ where: { id: 1 } });
  if (!row) return null;
  const overrides: AvidSettingsOverrides = {
    interplayUrl: nzStr(row.interplayUrl),
    avidUser:     nzStr(row.avidUser),
    avidPassword: nzSecret(row.avidPassword),
    workspace:    nzStr(row.workspace),
    clouduxUrl:   nzStr(row.clouduxUrl),
    clouduxRealm: nzStr(row.clouduxRealm),
    clouduxToken: nzSecret(row.clouduxToken),
  };
  return { overrides, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
}

/**
 * PUT — kısmi güncelleme (upsert id=1). Kurallar:
 *  - Sır alanlar (avidPassword/clouduxToken): yalnız gerçek yeni değer yazılır;
 *    boş ('') veya maske ('********') gelen alan ATLANIR (mevcut korunur).
 *  - Düz alanlar: '' → null (env'e dönsün), dolu → kaydet, undefined → atla.
 *  - updatedBy her zaman güncellenir; updatedAt @updatedAt ile değişir
 *    (getAvidAdapter cache invalidation imzası).
 */
export async function writeAvidSettings(
  prisma: PrismaClient,
  patch: AvidSettingsPatch,
  user: string | null,
): Promise<Date> {
  const data: Record<string, string | null> = {};
  const setPlain = (key: string, val: string | undefined) => {
    if (val === undefined) return;
    data[key] = val.trim() === '' ? null : val.trim();
  };
  const setSecret = (key: string, val: string | undefined) => {
    if (!val || val === AVID_MASK) return;   // boş/maske → değişme
    data[key] = val;
  };
  setPlain('interplayUrl', patch.interplayUrl);
  setPlain('avidUser',     patch.avidUser);
  setSecret('avidPassword', patch.avidPassword);
  setPlain('workspace',    patch.workspace);
  setPlain('clouduxUrl',   patch.clouduxUrl);
  setPlain('clouduxRealm', patch.clouduxRealm);
  setSecret('clouduxToken', patch.clouduxToken);

  const row = await prisma.avidSetting.upsert({
    where:  { id: 1 },
    create: { id: 1, ...data, updatedBy: user },
    update: { ...data, updatedBy: user },
  });
  return row.updatedAt;
}

/**
 * Efektif (env + DB merge edilmiş) AvidConfig'ten maskeli GET DTO üretir.
 * Sır alanlar set ise '********', değilse '' döner — gerçek değer dışarı çıkmaz.
 */
export function toMaskedDto(
  cfg: AvidConfig,
  meta?: { updatedBy?: string | null; updatedAt?: Date | null },
): AvidSettingsDto {
  return {
    interplayUrl: cfg.interplayUrl ?? '',
    avidUser:     cfg.user ?? '',
    avidPassword: cfg.password ? AVID_MASK : '',
    workspace:    cfg.workspace ?? '',
    clouduxUrl:   cfg.clouduxUrl ?? '',
    clouduxRealm: cfg.clouduxRealm ?? '',
    clouduxToken: cfg.clouduxToken ? AVID_MASK : '',
    updatedBy:    meta?.updatedBy ?? null,
    updatedAt:    meta?.updatedAt ? meta.updatedAt.toISOString() : null,
  };
}
