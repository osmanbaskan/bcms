import { Injectable, NgZone, inject, signal } from '@angular/core';
import { KeycloakService } from 'keycloak-angular';
import { environment } from '../../../environments/environment';
import { LoggerService } from '../../core/services/logger.service';
import type { ProvysStreamEvent } from './provys.types';

/**
 * Authorization: Bearer JWT taşıyan SSE client.
 *
 * Native `EventSource` Authorization header set edemediği için fetch
 * streaming + manuel SSE frame parser kullanılır. Token query param'a
 * **kesinlikle** yazılmaz (log/proxy/referrer sızdırma riski).
 *
 * Bağlantı kullanıcı sayfadan ayrılınca veya `disconnect()` çağrısıyla
 * temizlenir; server-side `pg_listener` SSE socket kapanışında
 * `unsubscribe` yapar.
 */
@Injectable({ providedIn: 'root' })
export class ProvysSseClient {
  private readonly keycloak = inject(KeycloakService);
  private readonly logger = inject(LoggerService);
  private readonly zone = inject(NgZone);

  readonly connected = signal(false);
  readonly lastError = signal<string | null>(null);

  private abortCtrl: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Stream'i açar. `onEvent` parse edilmiş SSE event'i alır.
   * Dönen `dispose()` bağlantıyı kapatır (component destroy'da çağrılmalı).
   */
  connect(onEvent: (ev: ProvysStreamEvent) => void): () => void {
    const url = `${environment.apiUrl}/provys/stream`;
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
          this.lastError.set('Token alınamadı');
          this.logger.error('Provys SSE: token retrieval failed', err);
          await this.delay(2000);
          continue;
        }

        try {
          const headers: Record<string, string> = { Accept: 'text/event-stream' };
          if (token) headers['Authorization'] = `Bearer ${token}`;
          const response = await fetch(url, {
            method: 'GET',
            headers,
            signal: this.abortCtrl.signal,
            credentials: 'same-origin',
          });

          if (!response.ok || !response.body) {
            this.lastError.set(`HTTP ${response.status}`);
            await this.delay(3000);
            continue;
          }

          this.zone.run(() => {
            this.connected.set(true);
            this.lastError.set(null);
          });

          await this.consumeStream(response.body, (event) => {
            this.zone.run(() => onEvent(event));
          });
        } catch (err) {
          if (stopped) return;
          this.logger.warn('Provys SSE: connection error, reconnecting', err);
          this.lastError.set(err instanceof Error ? err.message : String(err));
        } finally {
          this.zone.run(() => this.connected.set(false));
        }

        if (!stopped) await this.delay(2000);
      }
    };

    void loop();

    return () => {
      stopped = true;
      this.disconnect();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortCtrl) {
      try { this.abortCtrl.abort(); } catch { /* ignore */ }
      this.abortCtrl = null;
    }
    this.connected.set(false);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.reconnectTimer = setTimeout(resolve, ms);
    });
  }

  /**
   * SSE frame parser. RFC 2024-style: `data: ...\n\n` boundaries, comment
   * lines (`:` prefix) ignore edilir. Multi-line `data:` birleşir.
   */
  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    onEvent: (ev: ProvysStreamEvent) => void,
  ): Promise<void> {
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
        const raw = dataLines.join('\n');
        try {
          const parsed = JSON.parse(raw) as ProvysStreamEvent;
          onEvent(parsed);
        } catch (err) {
          this.logger.warn('Provys SSE: JSON parse hatası', err, raw);
        }
      }
    }
  }
}
