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
  /**
   * K3 (transfer) — Transfer.SendToPlayback birincil hedef engine (rapor §13.1).
   * Asset'i Avid DIŞI yayın havuzuna gönderir. Operasyon kararı: playback-engine-01 + MCR.
   */
  transferEngine: string;
  /**
   * K3 — Yedek (failover) engine. Birincil SendToPlayback başarısız olursa
   * bu engine'e tekrar denenir. Operasyon kararı: playback-engine-02. Boş ise failover yok.
   */
  transferEngineFallback: string;
  /** K3 — DestinationPlaybackDevice (birincil). Operasyon kararı: playback-engine-01/MCR. */
  playbackDevice: string;
  /**
   * K3 — Yedek engine'in device adı. ⚠️ playback-engine-02'de device "MCR" DEĞİL,
   * "MCR_YEDEK" (canlı doğrulandı 2026-05-31). Boş ise playbackDevice kullanılır.
   */
  playbackDeviceFallback: string;
  /** K3 — SendToPlayback Priority. NORMAL | PWT | UNASSIGNED. Default NORMAL. */
  transferPriority: string;
  /**
   * K3 (transfer) GERÇEK YOLU — MediaCentral Cloud UX / CTMS REST.
   * IPWS SendToPlayback "Cannot import" verdiği için terk edildi; transfer artık
   * Cloud UX'in `submitSTPJob` endpoint'ine gider (CDS mixdown+encode+playback'i
   * kendi orkestra eder). 2026-06-01 BCMS'ten canlı doğrulandı.
   */
  /** Cloud UX taban URL (CTMS). Default https://cloudux-host.example.local. */
  clouduxUrl: string;
  /** CTMS realm = Interplay PAM systemID. Default saha değeri (BSVMIPE). */
  clouduxRealm: string;
  /**
   * Başlangıç `avidAccessToken` (login session cookie değeri). SIR — hata
   * mesajlarına ASLA değeri girmez (sadece env adı). extension ile canlı tutulur.
   */
  clouduxToken: string | null;
  /**
   * Cloud UX ROPC login kullanıcı/parola. Boşsa IPWS `user`/`password`'a düşer
   * (saha: aynı hesap her adımda). Token bununla programatik ÜRETİLİR (kalıcı).
   */
  clouduxUser: string | null;
  clouduxPassword: string | null;
  /**
   * OAuth2 client Basic auth değeri = base64("client_id:client_secret").
   * Web app'in gömülü public client'ı (`com.avid.mediacentralcloud-...`). ROPC
   * login için ZORUNLU (Authorization: Basic <bu>). SIR — log'a girmez.
   */
  clouduxClientBasic: string | null;
  /** STP hedef device (submitSTPJob device alanı). Default MCR. */
  stpDevice: string;
  /** STP profil adı (submitSTPJob profile alanı). Default MCR. */
  stpProfile: string;
  /**
   * Cloud UX self-signed sertifika — TLS doğrulamasını SADECE CTMS client'ta
   * gevşetir (global NODE_TLS_REJECT_UNAUTHORIZED kullanılmaz). Default true.
   */
  clouduxInsecureTls: boolean;
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
    // K3 (transfer) — SendToPlayback hedefi (operasyon kararı 2026-05-31):
    // birincil playback-engine-01/MCR, yedek playback-engine-02/MCR.
    transferEngine: env.AVID_TRANSFER_ENGINE?.trim() || 'playback-engine-01',
    transferEngineFallback: env.AVID_TRANSFER_ENGINE_FALLBACK?.trim() || 'playback-engine-02',
    playbackDevice: env.AVID_PLAYBACK_DEVICE?.trim() || 'MCR',
    // playback-engine-02'de device adı MCR_YEDEK (MCR değil — canlı doğrulandı).
    playbackDeviceFallback: env.AVID_PLAYBACK_DEVICE_FALLBACK?.trim() || 'MCR_YEDEK',
    transferPriority: env.AVID_TRANSFER_PRIORITY?.trim() || 'NORMAL',
    // K3 gerçek yolu — Cloud UX / CTMS submitSTPJob (2026-06-01 canlı doğrulandı).
    clouduxUrl: (env.AVID_CLOUDUX_URL?.trim() || 'https://cloudux-host.example.local').replace(/\/+$/, ''),
    clouduxRealm: env.AVID_CLOUDUX_REALM?.trim() || 'F580021A-2720-4117-B33C-A5B843A2B586',
    // Token trim YAPMA — opaque değer; boşsa null.
    clouduxToken: env.AVID_CLOUDUX_TOKEN && env.AVID_CLOUDUX_TOKEN !== '' ? env.AVID_CLOUDUX_TOKEN : null,
    // ROPC login (kalıcı token). user/password trim YAPMA — boşluk içerebilir.
    clouduxUser: env.AVID_CLOUDUX_USER?.trim() || null,
    clouduxPassword: env.AVID_CLOUDUX_PASSWORD && env.AVID_CLOUDUX_PASSWORD !== '' ? env.AVID_CLOUDUX_PASSWORD : null,
    clouduxClientBasic: env.AVID_CLOUDUX_CLIENT_BASIC?.trim() || null,
    stpDevice: env.AVID_STP_DEVICE?.trim() || 'MCR',
    stpProfile: env.AVID_STP_PROFILE?.trim() || 'MCR',
    clouduxInsecureTls: env.AVID_CLOUDUX_INSECURE_TLS === undefined
      ? true
      : parseBoolEnv(env.AVID_CLOUDUX_INSECURE_TLS),
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

/**
 * K3 (transfer / CTMS submitSTPJob) için zorunlu env kontrolü. K1/K2'den AYRI —
 * search/restore CTMS token'ı gerektirmez, transfer gerektirir. Transfer yolu
 * (requestTransfer) çağrılınca kontrol edilir. Mesaj SADECE env adı (token değeri
 * ASLA). Mock mode'da çağrılmaz.
 */
export function assertCtmsConfigReady(config: AvidConfig): void {
  const missing: string[] = [];
  if (!config.clouduxUrl)   missing.push('AVID_CLOUDUX_URL');
  if (!config.clouduxRealm) missing.push('AVID_CLOUDUX_REALM');
  // Kalıcı yol: ROPC login (client Basic + kullanıcı/parola). Yoksa legacy manual token.
  const canLogin = !!config.clouduxClientBasic
    && !!(config.clouduxUser ?? config.user)
    && !!(config.clouduxPassword ?? config.password);
  if (!canLogin && !config.clouduxToken) {
    missing.push('AVID_CLOUDUX_CLIENT_BASIC + AVID_CLOUDUX_USER(/AVID_USER) + AVID_CLOUDUX_PASSWORD(/AVID_PASSWORD)  — veya legacy AVID_CLOUDUX_TOKEN');
  }
  if (missing.length > 0) {
    throw new Error(`Avid CTMS (transfer) config missing required: ${missing.join(', ')}`);
  }
}

/**
 * DB'deki `avid_settings` satırından gelen, env üstüne bindirilecek override
 * alanları. Sadece DOLU (boş/null olmayan) alanlar env değerini ezer; boş/null
 * alan env'e düşer (geriye dönük uyumlu). `avid.settings.ts` doldurur.
 */
export interface AvidSettingsOverrides {
  interplayUrl?: string;
  avidUser?: string;
  avidPassword?: string;
  workspace?: string;
  clouduxUrl?: string;
  clouduxRealm?: string;
  clouduxToken?: string;
  clouduxUser?: string;
  clouduxPassword?: string;
}

/**
 * `loadAvidConfig(env)` çıktısına DB override'larını bindirir (saf fonksiyon).
 * Override yoksa cfg aynen döner → DB satırı yok/boşken davranış = bugünkü env.
 */
export function applyAvidOverrides(cfg: AvidConfig, ov?: AvidSettingsOverrides | null): AvidConfig {
  if (!ov) return cfg;
  return {
    ...cfg,
    interplayUrl: ov.interplayUrl ?? cfg.interplayUrl,
    user:         ov.avidUser ?? cfg.user,
    password:     ov.avidPassword ?? cfg.password,
    workspace:    ov.workspace ?? cfg.workspace,
    clouduxUrl:   ov.clouduxUrl ? ov.clouduxUrl.replace(/\/+$/, '') : cfg.clouduxUrl,
    clouduxRealm: ov.clouduxRealm ?? cfg.clouduxRealm,
    clouduxToken: ov.clouduxToken ?? cfg.clouduxToken,
    clouduxUser:  ov.clouduxUser ?? cfg.clouduxUser,
    clouduxPassword: ov.clouduxPassword ?? cfg.clouduxPassword,
  };
}
