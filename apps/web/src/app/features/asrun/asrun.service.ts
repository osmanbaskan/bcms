import { Injectable, type Signal, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import {
  ASRUN_CHANNELS,
  ASRUN_CATEGORIES,
  type AsrunCategory,
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
 * Europe/Istanbul "dün" tarihini `YYYY-MM-DD` döner. ASRUN default açılışı
 * için: gün tamamlanmadan bugünün ASRUN listesi eksik olduğundan default
 * tarih dün olarak verilir. UTC string aritmetiği ile TZ-safe.
 */
function istanbulYesterdayDate(): string {
  const today = istanbulTodayDate();
  const [y, m, d] = today.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  const yy = prev.getUTCFullYear();
  const mm = String(prev.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(prev.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
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
  private readonly filteredStores = new Map<AsrunChannelSlug, Signal<AsrunItemDto[]>>();
  private readonly receivedFor = signal<Set<AsrunChannelSlug>>(new Set());

  // 2026-05-27: ASRUN gün-sonu kaynağı; gün tamamlanmadan bugünün listesi
  // eksik olur. Default açılış dünün tarihiyle gelir. Kullanıcı tarih
  // picker'dan bugünü veya başka bir günü manuel seçebilir (setActiveDate).
  readonly activeDate = signal<string>(istanbulYesterdayDate());

  /** Aktif kategori filtresi — default tüm 6 kategori seçili. */
  readonly selectedCategories = signal<ReadonlySet<AsrunCategory>>(new Set(ASRUN_CATEGORIES));

  constructor() {
    for (const c of ASRUN_CHANNELS) {
      const slug = c.slug as AsrunChannelSlug;
      const store = signal<AsrunItemDto[]>([]);
      this.channelStores.set(slug, store);
      // Kanal başına TEK computed — filteredItemsFor() çağrı sayısından
      // bağımsız, sabit reactive node.
      const filtered = computed(() => {
        const items = store();
        const allowed = this.selectedCategories();
        if (allowed.size === ASRUN_CATEGORIES.length) return items;
        return items.filter((i) => allowed.has(i.category));
      });
      this.filteredStores.set(slug, filtered);
    }
  }

  itemsFor(channel: AsrunChannelSlug) {
    const s = this.channelStores.get(channel);
    if (!s) throw new Error(`Unknown Asrun channel: ${channel}`);
    return s.asReadonly();
  }

  /** Kategori filtresi uygulanmış görünür liste (kanal başına tek cached signal). */
  filteredItemsFor(channel: AsrunChannelSlug): Signal<AsrunItemDto[]> {
    const s = this.filteredStores.get(channel);
    if (!s) throw new Error(`Unknown Asrun channel: ${channel}`);
    return s;
  }

  setSelectedCategories(set: ReadonlySet<AsrunCategory>): void {
    this.selectedCategories.set(set);
  }

  toggleCategory(category: AsrunCategory): void {
    const cur = new Set(this.selectedCategories());
    if (cur.has(category)) cur.delete(category);
    else cur.add(category);
    this.selectedCategories.set(cur);
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

  /**
   * Excel/PDF export — aktif kanal + tarih + kategori filtresi backend
   * endpoint'ine iletilir; Blob anchor download.
   */
  async exportExcel(channel: AsrunChannelSlug, date: string): Promise<void> {
    await this.downloadBlob('/asrun/export/excel', this.buildExportParams(channel, date), `asrun_${channel}_${date}.xlsx`);
  }

  async exportPdf(channel: AsrunChannelSlug, date: string): Promise<void> {
    await this.downloadBlob('/asrun/export/pdf', this.buildExportParams(channel, date), `asrun_${channel}_${date}.pdf`);
  }

  private buildExportParams(channel: AsrunChannelSlug, date: string): Record<string, string> {
    const params: Record<string, string> = { channel, date };
    const cats = this.activeCategoriesParam();
    if (cats) params['categories'] = cats;
    return params;
  }

  /** Tüm kategoriler seçiliyse `null` döner (default davranış = tümünü dahil). */
  private activeCategoriesParam(): string | null {
    const selected = this.selectedCategories();
    if (selected.size === ASRUN_CATEGORIES.length) return null;
    return ASRUN_CATEGORIES.filter((c) => selected.has(c)).join(',');
  }

  private async downloadBlob(path: string, params: Record<string, string>, filename: string): Promise<void> {
    const blob = await firstValueFrom(this.api.getBlob(path, params));
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
  }
}
