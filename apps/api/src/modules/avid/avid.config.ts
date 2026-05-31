/**
 * Avid Interplay adapter runtime config — env tabanlı, saf.
 *
 * Feature flag: `RESTORE_AVID_ENABLED` (default OFF). Açık iken
 * `assertAvidConfigReady` zorunlu env'leri kontrol eder.
 *
 * Mock mode: `RESTORE_AVID_MOCK=true` → factory mock adapter döner;
 * gerçek Interplay client çağrılmaz, network olmaz.
 *
 * `AVID_PASSWORD` bu modülden dışarı yalnız dönülen `AvidConfig.password`
 * alanı üzerinden geçer. Hata mesajları ASLA parola değerini içermez —
 * sadece env adlarını listeler (SSDB pattern paritesi).
 *
 * Side-effect'siz: top-level `process.env` okumaz; `loadAvidConfig(env)`
 * çağrıldığında okunur.
 */

export interface AvidConfig {
  enabled: boolean;
  mockMode: boolean;
  interplayUrl: string | null;
  user: string | null;
  password: string | null;
  workspace: string | null;
  requestTimeoutMs: number;
  /** Search kök path (Assets.Search InterplayPathURI). Default Projects kökü. */
  searchRootUri: string;
  /** Workgroup adı — interplay:// URI prefix kurarken. Default BSVMWG. */
  workgroup: string;
  /**
   * K2 (restore) hazırlığı — bu PR'da KULLANILMAZ. Jobs.SubmitJobUsingProfile
   * profile string'i birebir eşleşmeli (rapor §11.3). Default Partial.
   */
  restoreProfile: string;
  /** K2 hazırlığı — Jobs.SubmitJobUsingProfile Service. Default com.avid.dms.restore. */
  restoreService: string;
}

function parseBoolEnv(v: string | undefined): boolean {
  if (!v) return false;
  const t = v.trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'on';
}

function parsePositiveIntEnv(v: string | undefined, fallback: number): number {
  if (!v || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export function loadAvidConfig(env: NodeJS.ProcessEnv = process.env): AvidConfig {
  return {
    enabled: parseBoolEnv(env.RESTORE_AVID_ENABLED),
    // V2 default: mock ON — gerçek Interplay client PR'ı açılana kadar
    // mock adapter çalışır. Üretimde flag'i kapatmak için RESTORE_AVID_MOCK=false.
    mockMode: env.RESTORE_AVID_MOCK === undefined ? true : parseBoolEnv(env.RESTORE_AVID_MOCK),
    interplayUrl: env.AVID_INTERPLAY_URL?.trim() || null,
    user: env.AVID_USER?.trim() || null,
    // Password trim YAPMA — boşluk içerebilir.
    password: env.AVID_PASSWORD && env.AVID_PASSWORD !== '' ? env.AVID_PASSWORD : null,
    workspace: env.AVID_WORKSPACE?.trim() || null,
    requestTimeoutMs: parsePositiveIntEnv(env.AVID_REQUEST_TIMEOUT_MS, 30000),
    searchRootUri: env.AVID_SEARCH_ROOT_URI?.trim() || 'interplay://BSVMWG/Projects/',
    workgroup: env.AVID_WORKGROUP?.trim() || 'BSVMWG',
    // K2 hazırlığı (bu PR'da kullanılmaz). Boşluk/tire farkı önemli (rapor §11.3).
    restoreProfile: env.AVID_RESTORE_PROFILE?.trim() || 'BeINSports - Partial Restore',
    restoreService: env.AVID_RESTORE_SERVICE?.trim() || 'com.avid.dms.restore',
  };
}

/**
 * Adapter ENABLED ve MOCK kapalıyken zorunlu env'lerin doluluk kontrolü.
 * Eksik varsa Error fırlatır; mesaj SADECE env adlarını içerir
 * (parola değeri ASLA).
 *
 * Mock mode'da bu fonksiyon çağrılmaz — mock adapter env'siz çalışır.
 */
export function assertAvidConfigReady(config: AvidConfig): void {
  if (!config.enabled) {
    throw new Error(
      'Avid adapter is disabled (RESTORE_AVID_ENABLED != on); restore/transfer cannot be used.',
    );
  }
  if (config.mockMode) {
    // Mock için env zorunlu değil — sessizce return.
    return;
  }
  const missing: string[] = [];
  if (!config.interplayUrl) missing.push('AVID_INTERPLAY_URL');
  if (!config.user)         missing.push('AVID_USER');
  if (!config.password)     missing.push('AVID_PASSWORD');
  if (!config.workspace)    missing.push('AVID_WORKSPACE');
  if (missing.length > 0) {
    throw new Error(`Avid config missing required env: ${missing.join(', ')}`);
  }
}
