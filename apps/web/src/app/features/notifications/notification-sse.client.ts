import { Injectable, NgZone, inject, signal } from '@angular/core';
import { KeycloakService } from 'keycloak-angular';
import { environment } from '../../../environments/environment';
import { LoggerService } from '../../core/services/logger.service';
import type { NotifyStreamEvent } from './notification.types';

/**
 * Bildirim SSE client — Authorization: Bearer JWT taşır (provys-sse.client
 * paritesi). Native EventSource header set edemediği için fetch streaming +
 * manuel SSE frame parser. Token query param'a YAZILMAZ.
 */
@Injectable({ providedIn: 'root' })
export class NotificationSseClient {
  private readonly keycloak = inject(KeycloakService);
  private readonly logger = inject(LoggerService);
  private readonly zone = inject(NgZone);

  readonly connected = signal(false);

  private abortCtrl: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connect(onEvent: (ev: NotifyStreamEvent) => void): () => void {
    const url = `${environment.apiUrl}/notifications/stream`;
    let stopped = false;

    const loop = async (): Promise<void> => {
      while (!stopped) {
        this.abortCtrl = new AbortController();
        let token = '';
        try {
          if (!environment.skipAuth) {
            await this.keycloak.updateToken(120);
            token = await this.keycloak.getToken();
          }
        } catch (err) {
          this.logger.error('Notification SSE: token alınamadı', err);
          await this.delay(2000);
          continue;
        }
        try {
          const headers: Record<string, string> = { Accept: 'text/event-stream' };
          if (token) headers['Authorization'] = `Bearer ${token}`;
          const response = await fetch(url, { method: 'GET', headers, signal: this.abortCtrl.signal, credentials: 'same-origin' });
          if (!response.ok || !response.body) { await this.delay(3000); continue; }
          this.zone.run(() => this.connected.set(true));
          await this.consumeStream(response.body, (event) => this.zone.run(() => onEvent(event)));
        } catch (err) {
          if (stopped) return;
          this.logger.warn('Notification SSE: bağlantı hatası, yeniden denenecek', err);
        } finally {
          this.zone.run(() => this.connected.set(false));
        }
        if (!stopped) await this.delay(2000);
      }
    };
    void loop();

    return () => { stopped = true; this.disconnect(); };
  }

  disconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.abortCtrl) { try { this.abortCtrl.abort(); } catch { /* ignore */ } this.abortCtrl = null; }
    this.connected.set(false);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => { this.reconnectTimer = setTimeout(resolve, ms); });
  }

  private async consumeStream(body: ReadableStream<Uint8Array>, onEvent: (ev: NotifyStreamEvent) => void): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith(':') || line.length === 0) continue;
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        try { onEvent(JSON.parse(dataLines.join('\n')) as NotifyStreamEvent); }
        catch (err) { this.logger.warn('Notification SSE: JSON parse hatası', err); }
      }
    }
  }
}
