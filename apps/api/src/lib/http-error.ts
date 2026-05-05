/**
 * DÜŞÜK-API-1.13.1 fix (2026-05-04): HttpError class.
 *
 * Birçok yerde `Object.assign(new Error('msg'), { statusCode: N })` pattern'i
 * kullanılıyordu. Tip güvenliği zayıf, ek alanlar (conflicts, activeSchedule
 * vb.) eklemek string-based.
 *
 * Bu yardımcı sınıf:
 *   - statusCode zorunlu typed field
 *   - extras opsiyonel — conflict detayı, activeSchedule referansı vb.
 *   - app.ts errorResponse() Object.assign pattern'iyle ZATEN uyumlu;
 *     `instanceof HttpError` kontrolü gerekmiyor (legacy kod kırılmaz).
 *
 * Kullanım:
 *   throw new HttpError(404, 'Schedule bulunamadı');
 *   throw new HttpError(409, 'Schedule conflict', { conflicts: [...] });
 *
 * Mevcut Object.assign pattern'i bırakıyoruz; yeni kodda HttpError tercih edilir.
 */
export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly extras?: Record<string, unknown>;

  constructor(statusCode: number, message: string, extras?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    if (extras) {
      this.extras = extras;
      // app.ts errorResponse'un beklediği shape için ekstra alanları self'e
      // de attach et — Object.assign kullanan caller'larla aynı semantic.
      Object.assign(this, extras);
    }
    // V8'de prototype zinciri preserve için.
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

export function httpError(statusCode: number, message: string, extras?: Record<string, unknown>): HttpError {
  return new HttpError(statusCode, message, extras);
}
