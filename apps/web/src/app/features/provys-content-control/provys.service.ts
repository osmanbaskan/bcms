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
import { isMaterialMissing } from './provys-material-badge';

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

  // 2026-05-27 (night): showProgramHeaders toggle kaldırıldı. `rawKind=
  // 'ProgramHeader'` satırlar artık her zaman gizlenir; backend export query
  // `includeProgramHeaders=false` sabit gönderilir. Backend Zod param ve
  // `userNote` model alanı korunur (PATCH /provys/items/:id/note hâlâ aktif).

  /**
   * "Sadece eksik materyaller" filtresi. Açık iken `missing_material`,
   * `found_duration_mismatch`, `found_duration_unknown`, `ssdb_error`
   * status'lar görünür. `live_not_applicable`, `dc_not_applicable` (her ikisi
   * de SSDB kapsamı dışı), `unchecked`, `found_match` gizlenir.
   */
  readonly onlyMissingMaterial = signal<boolean>(false);

  /**
   * 2026-05-27: Kullanıcı UI'da her satır için opsiyonel transient "Not" yazabilir.
   * Map key = `item.eventId`, value = boş veya kısa metin.
   * DB'ye yazılmaz; sadece export request body'de gönderilir. Filtre/tab/tarih
   * değiştirilince Map kaybolmaz (tek session içinde kalır).
   */
  readonly notesByEventId = signal<ReadonlyMap<string, string>>(new Map());

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
      const onlyMissing = this.onlyMissingMaterial();
      const allCategoriesActive = allowed.size === PROVYS_CATEGORIES.length;
      // ProgramHeader satırlar her zaman gizli — toggle kaldırıldı (2026-05-27).
      return items.filter((i) => {
        if (i.rawKind === 'ProgramHeader') return false;
        if (!allCategoriesActive && !allowed.has(i.category)) return false;
        if (onlyMissing && !isMaterialMissing(i)) return false;
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

  setOnlyMissingMaterial(show: boolean): void {
    this.onlyMissingMaterial.set(show);
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
    await this.downloadBlobPost('/provys/export/excel', this.buildExportBody(channel, date), `provys_${channel}_${date}.xlsx`);
  }

  async exportPdf(channel: ProvysChannelSlug, date: string): Promise<void> {
    await this.downloadBlobPost('/provys/export/pdf', this.buildExportBody(channel, date), `provys_${channel}_${date}.pdf`);
  }

  /** UI'da bir satıra not yazıldığında çağrılır. Boş string Map'ten kaldırır. */
  setNote(eventId: string, text: string): void {
    const next = new Map(this.notesByEventId());
    const trimmed = text ?? '';
    if (trimmed.length === 0) next.delete(eventId);
    else next.set(eventId, trimmed.slice(0, 500));
    this.notesByEventId.set(next);
  }

  /** Template binding için tek satırın notunu döner. */
  getNote(eventId: string): string {
    return this.notesByEventId().get(eventId) ?? '';
  }

  /**
   * Aktif UI filtreleri + notesByEventId Map'ini POST export body olarak
   * yapılandırır. Backend `exportBodySchema` ile aynı sözleşme.
   */
  private buildExportBody(channel: ProvysChannelSlug, date: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      channel, date,
      includeProgramHeaders: 'false',
    };
    const cats = this.activeCategoriesParam();
    if (cats) body['categories'] = cats;
    const noteEntries: Record<string, string> = {};
    for (const [eventId, text] of this.notesByEventId()) {
      if (text && text.length > 0) noteEntries[eventId] = text;
    }
    if (Object.keys(noteEntries).length > 0) body['notes'] = noteEntries;
    return body;
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
    this.triggerBlobDownload(blob, filename);
  }

  /** POST body ile blob indirme (export endpoint notes Map'i destekler). */
  private async downloadBlobPost(path: string, body: Record<string, unknown>, filename: string): Promise<void> {
    const blob = await firstValueFrom(this.api.postBlob(path, body));
    this.triggerBlobDownload(blob, filename);
  }

  private triggerBlobDownload(blob: Blob, filename: string): void {
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
