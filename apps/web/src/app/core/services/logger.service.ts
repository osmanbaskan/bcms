import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

@Injectable({ providedIn: 'root' })
export class LoggerService {
  /** Geliştirici hata ayıklamak için: production'da no-op. */
  debug(message: string, ...details: unknown[]): void {
    if (!environment.production) this.emit('debug', message, details);
  }

  /** Bilgilendirme: production'da konsola gitmez, ileride analytics'e yönlendirilebilir. */
  info(message: string, ...details: unknown[]): void {
    if (!environment.production) this.emit('info', message, details);
  }

  /** Beklenen ama dikkat edilmesi gereken durumlar (token refresh fail vb). */
  warn(message: string, ...details: unknown[]): void {
    this.emit('warn', message, details);
  }

  /** Beklenmeyen hatalar — gelecekte Sentry/Posthog gibi bir servise gönderilir. */
  error(message: string, ...details: unknown[]): void {
    this.emit('error', message, details);
  }

  private emit(level: LogLevel, message: string, details: unknown[]): void {
    // Şimdilik tarayıcı konsoluna düşüyoruz. Centralized log sink (Sentry, custom
    // /api/v1/client-log endpoint vb.) eklendiğinde tek yerden anahtarlanabilir.
    const fn = level === 'error' ? console.error
             : level === 'warn'  ? console.warn
             : console.log;
    if (details.length) fn(`[${level}] ${message}`, ...details);
    else fn(`[${level}] ${message}`);
  }
}
