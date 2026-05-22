import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { ProvysSseClient } from './provys-sse.client';
import {
  PROVYS_CHANNELS,
  type ProvysChannelSlug,
  type ProvysItemDto,
  type ProvysStreamEvent,
} from './provys.types';

/**
 * Provys kanal listelerinin tek kaynak signal store'u. Sayfa açıldığında
 * `ensureStreaming()` çağrılır; ilk snapshot + SSE update'leri tek
 * bağlantı üstünden 6 kanala dağıtılır.
 *
 * Polling YOK — UI yalnızca SSE event'i geldikçe re-render eder.
 */
@Injectable({ providedIn: 'root' })
export class ProvysService {
  private readonly api = inject(ApiService);
  private readonly sse = inject(ProvysSseClient);

  private readonly channelStores = new Map<ProvysChannelSlug, ReturnType<typeof signal<ProvysItemDto[]>>>();
  private readonly receivedFor = signal<Set<ProvysChannelSlug>>(new Set());
  private dispose: (() => void) | null = null;
  private streamingStarted = false;

  readonly connected = computed(() => this.sse.connected());
  readonly lastError = computed(() => this.sse.lastError());

  constructor() {
    for (const channel of PROVYS_CHANNELS) {
      this.channelStores.set(channel.slug, signal<ProvysItemDto[]>([]));
    }
  }

  itemsFor(channel: ProvysChannelSlug) {
    const s = this.channelStores.get(channel);
    if (!s) throw new Error(`Unknown Provys channel: ${channel}`);
    return s.asReadonly();
  }

  hasReceived(channel: ProvysChannelSlug): boolean {
    return this.receivedFor().has(channel);
  }

  /** Initial fetch — SSE snapshot beklerken hızlı dolum. Idempotent. */
  async loadInitial(): Promise<void> {
    await Promise.all(
      PROVYS_CHANNELS.map(async (c) => {
        try {
          const items = await firstValueFrom(
            this.api.get<ProvysItemDto[]>('/provys/items', { channel: c.slug }),
          );
          this.applySnapshot(c.slug, items);
        } catch {
          // SSE snapshot bağlantıyla tamamlayacak; initial REST hatasını sessiz geç.
        }
      }),
    );
  }

  ensureStreaming(): void {
    if (this.streamingStarted) return;
    this.streamingStarted = true;
    this.dispose = this.sse.connect((event) => this.handleEvent(event));
  }

  stopStreaming(): void {
    if (this.dispose) {
      this.dispose();
      this.dispose = null;
    }
    this.streamingStarted = false;
  }

  private handleEvent(event: ProvysStreamEvent): void {
    if (event.type === 'snapshot' || event.type === 'update') {
      this.applySnapshot(event.channel, event.items);
    }
    // heartbeat → no-op
  }

  private applySnapshot(channel: ProvysChannelSlug, items: ProvysItemDto[]): void {
    const store = this.channelStores.get(channel);
    if (!store) return;
    store.set(items);
    const next = new Set(this.receivedFor());
    next.add(channel);
    this.receivedFor.set(next);
  }
}
