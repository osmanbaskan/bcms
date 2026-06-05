/**
 * Haber > AA bağlantı ayarları — DB (tek satır `news_settings`, id=1) + env merge.
 *
 * Ayarlar > Haber ekranından düzenlenir. Boş/null alan runtime'da env'e (AA_API_*)
 * düşer. Şifre DB'de düz metin (.env ile eş risk) ama:
 *  - GET yanıtı MASKELİ ('********') döner — gerçek değer API'den çıkmaz.
 *  - PUT'ta maske/boş gelen şifre YAZILMAZ (mevcut korunur) — Avid/SMB deseni.
 *  - Yalnız Admin (route preHandler PERMISSIONS.news.admin).
 * news-aa-fetcher worker'ı bu konfigi her tick'te okur (restart gerektirmez).
 */
import type { PrismaClient, NewsSetting } from '@prisma/client';

export const NEWS_MASK = '********';

/** Worker'ın kullandığı efektif (env + DB merge) AA konfigi. */
export interface AaEffectiveConfig {
  base: string;
  user: string;
  pass: string;
  pollSec: number;
  filterType: string;
  filterLang: string;
  filterCategory: string;
  limit: number;
  docFormat: string;
  enabled: boolean;
}

/** Worker/export'un kullandığı efektif (env + DB merge) EGS dışa-aktarım konfigi. */
export interface EgsExportConfig {
  enabled: boolean;
  prompterPath: string; // smb://host/share/dir — _out.WIN buraya
  xmlPath: string;      // smb://host/share/dir — .xml buraya
  smbUser: string;
  smbPassword: string;
  smbDomain: string;
}

/** API GET/PUT şekli. Şifreler GET'te maskeli. */
export interface NewsSettingsDto {
  aaApiUser: string;
  aaApiPassword: string;       // GET: '********' (set ise) | ''  ·  PUT: yeni değer | '' (değişme)
  aaApiBase: string;
  aaApiPollSeconds: number;
  aaApiFilterType: string;
  aaApiFilterLanguage: string;
  aaApiFilterCategory: string;
  aaApiEnabled: boolean;
  // EGS bülten dışa-aktarım
  egsExportEnabled: boolean;
  egsPrompterPath: string;
  egsXmlPath: string;
  egsSmbUser: string;
  egsSmbPassword: string;      // GET: '********' (set ise) | ''  ·  PUT: yeni | '' (değişme)
  egsSmbDomain: string;
  updatedBy: string | null;
  updatedAt: string | null;
}
export type NewsSettingsPatch = Partial<Omit<NewsSettingsDto, 'updatedBy' | 'updatedAt'>>;

function envDefaults() {
  return {
    base: (process.env.AA_API_BASE ?? 'https://api.aa.com.tr').replace(/\/$/, ''),
    user: process.env.AA_API_USER ?? '',
    pass: process.env.AA_API_PASS ?? '',
    pollSec: parseInt(process.env.AA_API_POLL_SECONDS ?? '300', 10),
    filterType: process.env.AA_API_FILTER_TYPE ?? '1',
    filterLang: process.env.AA_API_FILTER_LANGUAGE ?? '1',
    filterCategory: process.env.AA_API_FILTER_CATEGORY ?? '',
    limit: Math.min(100, Math.max(1, parseInt(process.env.AA_API_SEARCH_LIMIT ?? '30', 10))),
    docFormat: process.env.AA_API_DOC_FORMAT ?? 'newsml29',
  };
}

const EGS_DEFAULT_PATH = 'smb://172.26.33.245/mcr/EGS/';
function egsEnvDefaults() {
  return {
    enabled: (process.env.EGS_EXPORT_ENABLED ?? '').toLowerCase() === 'true',
    prompterPath: process.env.EGS_PROMPTER_PATH ?? EGS_DEFAULT_PATH,
    xmlPath: process.env.EGS_XML_PATH ?? EGS_DEFAULT_PATH,
    smbUser: process.env.EGS_SMB_USER ?? '',
    smbPass: process.env.EGS_SMB_PASSWORD ?? '',
    smbDomain: process.env.EGS_SMB_DOMAIN ?? '',
  };
}

const nz = (v: string | null | undefined): string | undefined => {
  const t = (v ?? '').trim();
  return t === '' ? undefined : t;
};

type Row = NewsSetting | null;

/** Saf AA merge (DB > env). */
function mergeAaCfg(row: Row): AaEffectiveConfig {
  const env = envDefaults();
  return {
    base: (nz(row?.aaApiBase) ?? env.base).replace(/\/$/, ''),
    user: nz(row?.aaApiUser) ?? env.user,
    pass: row?.aaApiPassword && row.aaApiPassword !== '' ? row.aaApiPassword : env.pass,
    pollSec: Math.max(60, row?.aaApiPollSeconds ?? env.pollSec),
    filterType: nz(row?.aaApiFilterType) ?? env.filterType,
    filterLang: nz(row?.aaApiFilterLanguage) ?? env.filterLang,
    filterCategory: nz(row?.aaApiFilterCategory) ?? env.filterCategory,
    limit: env.limit,
    docFormat: env.docFormat,
    // enabled: DB'de açıkça false ise kapalı; null/yoksa kimlik varsa açık.
    enabled: row?.aaApiEnabled ?? true,
  };
}

/** Saf EGS merge (DB > env). */
function mergeEgsCfg(row: Row): EgsExportConfig {
  const env = egsEnvDefaults();
  return {
    enabled: row?.egsExportEnabled ?? env.enabled,
    prompterPath: nz(row?.egsPrompterPath) ?? env.prompterPath,
    xmlPath: nz(row?.egsXmlPath) ?? env.xmlPath,
    smbUser: nz(row?.egsSmbUser) ?? env.smbUser,
    smbPassword: row?.egsSmbPassword && row.egsSmbPassword !== '' ? row.egsSmbPassword : env.smbPass,
    smbDomain: nz(row?.egsSmbDomain) ?? env.smbDomain,
  };
}

/** Efektif AA konfig (DB > env) + meta. AA worker bunu her tick okur. */
export async function getEffectiveAaConfig(
  prisma: PrismaClient,
): Promise<{ cfg: AaEffectiveConfig; updatedBy: string | null; updatedAt: Date | null }> {
  const row = await prisma.newsSetting.findUnique({ where: { id: 1 } });
  return { cfg: mergeAaCfg(row), updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null };
}

/** Efektif EGS dışa-aktarım konfig (DB > env). Export endpoint bunu okur. */
export async function getEffectiveEgsConfig(prisma: PrismaClient): Promise<EgsExportConfig> {
  const row = await prisma.newsSetting.findUnique({ where: { id: 1 } });
  return mergeEgsCfg(row);
}

/** GET DTO — AA + EGS birleşik, şifreler maskeli. */
export async function getNewsSettingsDto(prisma: PrismaClient): Promise<NewsSettingsDto> {
  const row = await prisma.newsSetting.findUnique({ where: { id: 1 } });
  return toMaskedDto(mergeAaCfg(row), mergeEgsCfg(row), {
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt ?? null,
  });
}

/** GET DTO oluşturucu — şifreler maskeli. */
export function toMaskedDto(
  aa: AaEffectiveConfig,
  egs: EgsExportConfig,
  meta: { updatedBy: string | null; updatedAt: Date | null },
): NewsSettingsDto {
  return {
    aaApiUser: aa.user,
    aaApiPassword: aa.pass ? NEWS_MASK : '',
    aaApiBase: aa.base,
    aaApiPollSeconds: aa.pollSec,
    aaApiFilterType: aa.filterType,
    aaApiFilterLanguage: aa.filterLang,
    aaApiFilterCategory: aa.filterCategory,
    aaApiEnabled: aa.enabled,
    egsExportEnabled: egs.enabled,
    egsPrompterPath: egs.prompterPath,
    egsXmlPath: egs.xmlPath,
    egsSmbUser: egs.smbUser,
    egsSmbPassword: egs.smbPassword ? NEWS_MASK : '',
    egsSmbDomain: egs.smbDomain,
    updatedBy: meta.updatedBy,
    updatedAt: meta.updatedAt ? meta.updatedAt.toISOString() : null,
  };
}

/** PUT — kısmi güncelle (upsert id=1). Şifre maske/boş ise atlanır. */
export async function writeNewsSettings(
  prisma: PrismaClient,
  patch: NewsSettingsPatch,
  user: string | null,
): Promise<void> {
  const data: Record<string, string | number | boolean | null> = {};
  const setPlain = (key: string, val: string | undefined) => {
    if (val === undefined) return;
    data[key] = val.trim() === '' ? null : val.trim();
  };
  setPlain('aaApiUser', patch.aaApiUser);
  setPlain('aaApiBase', patch.aaApiBase);
  setPlain('aaApiFilterType', patch.aaApiFilterType);
  setPlain('aaApiFilterLanguage', patch.aaApiFilterLanguage);
  setPlain('aaApiFilterCategory', patch.aaApiFilterCategory);
  // Şifre: boş/maske → değişme; gerçek yeni değer → yaz.
  if (patch.aaApiPassword && patch.aaApiPassword !== NEWS_MASK) {
    data['aaApiPassword'] = patch.aaApiPassword;
  }
  if (patch.aaApiPollSeconds !== undefined) {
    data['aaApiPollSeconds'] = Math.max(60, Number(patch.aaApiPollSeconds) || 300);
  }
  if (patch.aaApiEnabled !== undefined) {
    data['aaApiEnabled'] = !!patch.aaApiEnabled;
  }
  // EGS dışa-aktarım
  setPlain('egsPrompterPath', patch.egsPrompterPath);
  setPlain('egsXmlPath', patch.egsXmlPath);
  setPlain('egsSmbUser', patch.egsSmbUser);
  setPlain('egsSmbDomain', patch.egsSmbDomain);
  if (patch.egsSmbPassword && patch.egsSmbPassword !== NEWS_MASK) {
    data['egsSmbPassword'] = patch.egsSmbPassword;
  }
  if (patch.egsExportEnabled !== undefined) {
    data['egsExportEnabled'] = !!patch.egsExportEnabled;
  }

  await prisma.newsSetting.upsert({
    where: { id: 1 },
    create: { id: 1, ...data, updatedBy: user },
    update: { ...data, updatedBy: user },
  });
}
