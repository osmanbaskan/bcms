import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { catchError, throwError } from 'rxjs';

/**
 * HIGH-FE-003 fix (2026-05-05) — global HTTP error interceptor.
 * api.service'in zero error handling sorununu çözmek için tek noktadan
 * tutarlı kullanıcı bildirimi:
 *   - 401: throttle'lanmış login redirect (auth.interceptor sorumlu — burada
 *     mesaj göstermiyoruz)
 *   - 403: "Bu işlem için yetkiniz yok"
 *   - 404: silent (component'in kendi handle etmesi mantıklı)
 *   - 409: "Çakışma" (caller başka mesaj geçtiyse o görünür)
 *   - 412: "Versiyon çakışması — sayfayı yenileyin"
 *   - 429: "Çok fazla istek — biraz bekleyin"
 *   - 5xx: "Sunucu hatası, tekrar deneyin"
 *
 * Component'in kendi error callback'i `next(...)` zinciriyle yine çağrılır
 * (throwError ile re-throw). Yani local handler özel mesaj gösterebilir;
 * interceptor sadece DEFAULT toast'u atar (caller error vermezse).
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const snack = inject(MatSnackBar);

  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse) {
        const message = friendlyMessage(err);
        if (message) {
          snack.open(message, 'Kapat', { duration: 4000, panelClass: ['snack-error'] });
        }
      }
      return throwError(() => err);
    }),
  );
};

function friendlyMessage(err: HttpErrorResponse): string | null {
  if (err.status === 0) return 'Sunucuya ulaşılamıyor — bağlantınızı kontrol edin';
  if (err.status === 401) return null;                     // auth.interceptor handle eder
  if (err.status === 403) return 'Bu işlem için yetkiniz yok';
  if (err.status === 404) return null;                     // sessiz, component handle eder
  if (err.status === 409) return err.error?.message ?? 'Çakışma';
  if (err.status === 412) return 'Versiyon çakışması — sayfayı yenileyin';
  if (err.status === 429) return 'Çok fazla istek — birkaç saniye sonra tekrar deneyin';
  if (err.status >= 500)  return 'Sunucu hatası, tekrar deneyin';
  return null;
}
