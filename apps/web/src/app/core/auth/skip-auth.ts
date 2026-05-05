import { environment } from '../../../environments/environment';

/**
 * MED-FE-005/010/011 fix (2026-05-05) — skipAuth runtime guard.
 *
 * `environment.skipAuth=true` development backdoor; build pipeline
 * yanlışlıkla prod'a sıçrayabilir veya prod environment dosyası unutulabilir.
 * Runtime'da hostname'i de kontrol et: sadece localhost/127.0.0.1/private LAN
 * IP'lerinde true dön. Aksi halde her durumda false zorla — auth flow tetiklenir.
 *
 * Kullanım: `if (isSkipAuthAllowed()) { ... dev path ... }`
 */
const PRIVATE_HOSTNAME_REGEX = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|.*\.local)$/i;

export function isSkipAuthAllowed(): boolean {
  if (!environment.skipAuth) return false;
  // Browser context guard
  if (typeof window === 'undefined' || !window.location) return false;
  const host = window.location.hostname.toLowerCase();
  return PRIVATE_HOSTNAME_REGEX.test(host);
}
