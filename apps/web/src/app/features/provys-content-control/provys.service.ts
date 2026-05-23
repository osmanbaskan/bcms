import { Injectable, type Signal, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { ProvysSseClient } from './provys-sse.client';
import {
  PROVYS_CHANNELS,
  PROVYS_CATEGORIES,
  type ProvysCategory,
  type ProvysChannelSlug,
  type ProvysItemDto,
  type ProvysStreamEvent,
} from './provys.types';

/** Europe/Istanbul bugünün `YYYY-MM-DD` tarihini döner. */
function istanbulTodayDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Provys per-day snapshot store. UI tarafı aktif `(channel, scheduleDate)`
 * çiftine ait listeyi okur; SSE update event'i geldiğinde sadece eşleşen
 * (channel, date) için store güncellenir.
 *
 * Polling YOK. SSE'de gelen event farklı bir güne aitse görmezden gelinir
 * (UI o günü zaten göstermiyor) — REST `/items?channel&date` sorgusu
 * yeni güne geçince yapılır.
 */
@Injectable({ providedIn: 'root' })
export class ProvysService {
  private readonly api = inject(ApiService);
  private readonly sse = inject(ProvysSseClient);

  private readonly channelStores = new Map<ProvysChannelSlug, ReturnType<typeof signal<ProvysItemDto[]>>>();
  private readonly receivedFor = signal<Set<ProvysChannelSlug>>(new Set());
  private dispose: (() => void) | null = null;
  private streamingStarted = false;

  /** Aktif yayın günü; UI date picker bunu set eder. */
  readonly activeDate = signal<string>(istanbulTodayDate());

  /**
   * Kullanıcının ekranda görmek istediği kategoriler. Default: tüm 6
   * kategori görünür. Tab/tarih değişiminde korunur (date refetch sırasında
   * sıfırlanmaz). UI client-side filter; raw store her zaman tüm satırları
   * tutar, sadece `filteredItemsFor()` filtre uygular.
   */
  readonly selectedCategories = signal<ReadonlySet<ProvysCategory>>(new Set(PROVYS_CATEGORIES));

  /**
   * "Program başlıkları" toggle'ı — `Primary-ProgramHeader` event'lerini
   * (rawKind='ProgramHeader', DC'siz block manşetleri) gösterip gizler.
   * Default kapalı: kullanıcı gerçek Content satırlarını görür; aynı
   * timecode'da çakışan duplicate görünüm önlenir.
   */
  readonly showProgramHeaders = signal<boolean>(false);
  /** O kanal için DB'de mevcut günler (`/provys/dates?channel=` döner). */
  private readonly availableDatesStore = new Map<ProvysChannelSlug, ReturnType<typeof signal<string[]>>>();

  readonly connected = computed(() => this.sse.connected());
  readonly lastError = computed(() => this.sse.lastError());

  constructor() {
    for (const channel of PROVYS_CHANNELS) {
      this.channelStores.set(channel.slug, signal<ProvysItemDto[]>([]));
      this.availableDatesStore.set(channel.slug, signal<string[]>([]));
    }
  }

  itemsFor(channel: ProvysChannelSlug) {
    const s = this.channelStores.get(channel);
    if (!s) throw new Error(`Unknown Provys channel: ${channel}`);
    return s.asReadonly();
  }

  /**
   * Aktif kategori filtresi + ProgramHeader toggle uygulanmış liste
   * (UI'da gösterilen).
   */
  filteredItemsFor(channel: ProvysChannelSlug): Signal<ProvysItemDto[]> {
    return computed(() => {
      const items = this.itemsFor(channel)();
      const allowed = this.selectedCategories();
      const showHeaders = this.showProgramHeaders();
      const allCategoriesActive = allowed.size === PROVYS_CATEGORIES.length;
      if (allCategoriesActive && showHeaders) return items;
      return items.filter((i) => {
        if (!allCategoriesActive && !allowed.has(i.category)) return false;
        if (!showHeaders && i.rawKind === 'ProgramHeader') return false;
        return true;
      });
    });
  }

  /** Aktif filtreyi değiştirir (multi-select). */
  setSelectedCategories(set: ReadonlySet<ProvysCategory>): void {
    this.selectedCategories.set(set);
  }

  toggleCategory(category: ProvysCategory): void {
    const cur = new Set(this.selectedCategories());
    if (cur.has(category)) cur.delete(category);
    else cur.add(category);
    this.selectedCategories.set(cur);
  }

  setShowProgramHeaders(show: boolean): void {
    this.showProgramHeaders.set(show);
  }

  availableDatesFor(channel: ProvysChannelSlug) {
    const s = this.availableDatesStore.get(channel);
    if (!s) throw new Error(`Unknown Provys channel: ${channel}`);
    return s.asReadonly();
  }

  hasReceived(channel: ProvysChannelSlug): boolean {
    return this.receivedFor().has(channel);
  }

  /**
   * Kullanıcı serbest notu güncelle (PATCH /provys/items/:id/note).
   * Optimistic: önce store'da güncelle, sonra API; başarısız olursa eski
   * değere geri al ve hata fırlat. Boş string → null (silme).
   */
  async updateNote(channel: ProvysChannelSlug, id: number, note: string | null): Promise<void> {
    const trimmed = note == null || note.trim() === '' ? null : note;
    const store = this.channelStores.get(channel);
    if (!store) throw new Error(`Unknown Provys channel: ${channel}`);
    const prev = store();
    const previousValue = prev.find((i) => i.id === id)?.userNote ?? null;
    // Optimistic — ekranda hemen güncelle
    store.set(prev.map((i) => (i.id === id ? { ...i, userNote: trimmed } : i)));
    try {
      const dto = await firstValueFrom(
        this.api.patch<ProvysItemDto>(`/provys/items/${id}/note`, { note: trimmed }),
      );
      // Backend authoritative DTO ile replace
      store.set(store().map((i) => (i.id === id ? dto : i)));
    } catch (err) {
      // Hata: önceki nota geri dön ve fırlat
      store.set(store().map((i) => (i.id === id ? { ...i, userNote: previousValue } : i)));
      throw err;
    }
  }

  /** Tarih değişiminde çağrılır — store'ları sıfırla, yeni tarih için REST fetch. */
  async setActiveDate(date: string): Promise<void> {
    if (date === this.activeDate()) return;
    this.activeDate.set(date);
    this.resetReceived();
    await this.loadInitial();
  }

  /**
   * Aktif tarih için tüm kanal listelerini REST üstünden çeker (paralel).
   * SSE update'leri için ek context — aktif kanal+tarih dışındaki notify'lar
   * görmezden gelinir.
   */
  async loadInitial(): Promise<void> {
    const date = this.activeDate();
    await Promise.all(
      PROVYS_CHANNELS.map(async (c) => {
        try {
          const items = await firstValueFrom(
            this.api.get<ProvysItemDto[]>('/provys/items', { channel: c.slug, date }),
          );
          this.applySnapshot(c.slug, date, items);
        } catch {
          // SSE veya retry ileride deneyecek; sessiz geç.
        }
      }),
    );
  }

  /** O kanal için mevcut yayın günlerini çeker — date picker filter'ı için. */
  async loadAvailableDates(channel: ProvysChannelSlug): Promise<void> {
    try {
      const dates = await firstValueFrom(
        this.api.get<string[]>('/provys/dates', { channel }),
      );
      this.availableDatesStore.get(channel)?.set(dates);
    } catch { /* sessiz geç */ }
  }

  /**
   * Excel/PDF export — aktif kanal + tarih için backend endpoint'i çağırır,
   * Blob'u browser'a indirir. Mevcut `live-plan` export pattern paritesi
   * (ApiService.getBlob + anchor download).
   */
  async exportExcel(channel: ProvysChannelSlug, date: string): Promise<void> {
    await this.downloadBlob('/provys/export/excel', this.buildExportParams(channel, date), `provys_${channel}_${date}.xlsx`);
  }

  async exportPdf(channel: ProvysChannelSlug, date: string): Promise<void> {
    await this.downloadBlob('/provys/export/pdf', this.buildExportParams(channel, date), `provys_${channel}_${date}.pdf`);
  }

  /** Aktif UI filtrelerini export query param setine taşır. */
  private buildExportParams(channel: ProvysChannelSlug, date: string): Record<string, string> {
    const params: Record<string, string> = { channel, date };
    const cats = this.activeCategoriesParam();
    if (cats) params['categories'] = cats;
    // ProgramHeader gösterimi default kapalı → export'a hariç (default
    // server-side davranışı zaten kapalı; explicit göndermesek de OK ama
    // niyet netliği için her zaman gönderelim).
    params['includeProgramHeaders'] = this.showProgramHeaders() ? 'true' : 'false';
    return params;
  }

  /**
   * Aktif kategori filtresini export query param'ına çevirir. Tüm
   * kategoriler seçiliyse `null` döner (param gönderme — backend default
   * "tümü dahil"). Aksi halde virgül-ayrımlı liste.
   */
  private activeCategoriesParam(): string | null {
    const selected = this.selectedCategories();
    if (selected.size === PROVYS_CATEGORIES.length) return null;
    return PROVYS_CATEGORIES.filter((c) => selected.has(c)).join(',');
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
      // Browser yeterli süre tutması için kısa gecikme + revoke.
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
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
    if (event.type !== 'snapshot' && event.type !== 'update') return;
    // SSE event'in tarihi UI aktif tarihinden farklıysa görmezden gel.
    if (event.scheduleDate !== this.activeDate()) return;
    this.applySnapshot(event.channel, event.scheduleDate, event.items);
  }

  private applySnapshot(channel: ProvysChannelSlug, scheduleDate: string, items: ProvysItemDto[]): void {
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
}
