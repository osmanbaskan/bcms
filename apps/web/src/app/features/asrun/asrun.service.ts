import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import {
  ASRUN_CHANNELS,
  type AsrunChannelSlug,
  type AsrunItemDto,
} from './asrun.types';

/** Europe/Istanbul bugünün `YYYY-MM-DD` tarihini döner. */
function istanbulTodayDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Asrun per-day store. Provys'ten ayrı, ayrı endpoint çağırır
 * (`/api/v1/asrun/items`). SSE V1 kapsamında değil; REST polling/refresh
 * ile yenilenir.
 */
@Injectable({ providedIn: 'root' })
export class AsrunService {
  private readonly api = inject(ApiService);

  private readonly channelStores = new Map<AsrunChannelSlug, ReturnType<typeof signal<AsrunItemDto[]>>>();
  private readonly receivedFor = signal<Set<AsrunChannelSlug>>(new Set());

  readonly activeDate = signal<string>(istanbulTodayDate());

  constructor() {
    for (const c of ASRUN_CHANNELS) {
      this.channelStores.set(c.slug as AsrunChannelSlug, signal<AsrunItemDto[]>([]));
    }
  }

  itemsFor(channel: AsrunChannelSlug) {
    const s = this.channelStores.get(channel);
    if (!s) throw new Error(`Unknown Asrun channel: ${channel}`);
    return s.asReadonly();
  }

  hasReceived(channel: AsrunChannelSlug): boolean {
    return this.receivedFor().has(channel);
  }

  async setActiveDate(date: string): Promise<void> {
    if (date === this.activeDate()) return;
    this.activeDate.set(date);
    this.resetReceived();
    await this.loadInitial();
  }

  async loadInitial(): Promise<void> {
    const date = this.activeDate();
    await Promise.all(
      ASRUN_CHANNELS.map(async (c) => {
        try {
          const items = await firstValueFrom(
            this.api.get<AsrunItemDto[]>('/asrun/items', { channel: c.slug, date }),
          );
          this.applySnapshot(c.slug as AsrunChannelSlug, date, items);
        } catch {
          /* sessiz geç */
        }
      }),
    );
  }

  private applySnapshot(channel: AsrunChannelSlug, scheduleDate: string, items: AsrunItemDto[]): void {
    if (scheduleDate !== this.activeDate()) return;
    const store = this.channelStores.get(channel);
    if (!store) return;
    store.set(items);
    const next = new Set(this.receivedFor());
    next.add(channel);
    this.receivedFor.set(next);
  }

  private resetReceived(): void {
    for (const store of this.channelStores.values()) store.set([]);
    this.receivedFor.set(new Set());
  }

  readonly hasAnyData = computed(() => this.receivedFor().size > 0);
}
