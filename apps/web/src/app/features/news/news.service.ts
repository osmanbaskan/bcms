import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import type {
  CreateBulletinDto,
  CreateStoryDto,
  NewsBulletin,
  NewsMosDevice,
  NewsStory,
  NewsWireItem,
  SendToAirDto,
  SendToAirResult,
  UpdateBulletinDto,
  UpdateStoryDto,
  UpsertLowerThirdDto,
} from '@bcms/shared';

/**
 * Haber (NewsWorks NRCS) — frontend API servisi.
 * Tüm /api/v1/news uçlarını sarmalar. Optimistic-lock için patch(version).
 */
@Injectable({ providedIn: 'root' })
export class NewsService {
  private readonly api = inject(ApiService);

  // ---- Bülten ----
  listBulletins(params?: { date?: string; group?: string; status?: string }): Observable<NewsBulletin[]> {
    return this.api.get<NewsBulletin[]>('/news/bulletins', params as Record<string, string>);
  }
  getBulletin(id: number): Observable<NewsBulletin> {
    return this.api.get<NewsBulletin>(`/news/bulletins/${id}`);
  }
  createBulletin(dto: CreateBulletinDto): Observable<NewsBulletin> {
    return this.api.post<NewsBulletin>('/news/bulletins', dto);
  }
  updateBulletin(id: number, dto: UpdateBulletinDto, version?: number): Observable<NewsBulletin> {
    return this.api.patch<NewsBulletin>(`/news/bulletins/${id}`, dto, version);
  }
  deleteBulletin(id: number): Observable<void> {
    return this.api.delete<void>(`/news/bulletins/${id}`);
  }
  reorderStories(id: number, orderedStoryIds: number[]): Observable<NewsBulletin> {
    return this.api.put<NewsBulletin>(`/news/bulletins/${id}/order`, { orderedStoryIds });
  }

  // ---- Haber (story) ----
  listStories(params?: { bulletinId?: number; pool?: boolean; group?: string; q?: string; from?: string; to?: string }): Observable<NewsStory[]> {
    return this.api.get<NewsStory[]>('/news/stories', params as Record<string, string | number | boolean>);
  }
  getStory(id: number): Observable<NewsStory> {
    return this.api.get<NewsStory>(`/news/stories/${id}`);
  }
  createStory(dto: CreateStoryDto): Observable<NewsStory> {
    return this.api.post<NewsStory>('/news/stories', dto);
  }
  updateStory(id: number, dto: UpdateStoryDto, version?: number): Observable<NewsStory> {
    return this.api.patch<NewsStory>(`/news/stories/${id}`, dto, version);
  }
  deleteStory(id: number): Observable<void> {
    return this.api.delete<void>(`/news/stories/${id}`);
  }
  lockStory(id: number): Observable<NewsStory> {
    return this.api.post<NewsStory>(`/news/stories/${id}/lock`, {});
  }
  unlockStory(id: number): Observable<NewsStory> {
    return this.api.post<NewsStory>(`/news/stories/${id}/unlock`, {});
  }
  moveStory(id: number, bulletinId: number | null): Observable<NewsStory> {
    return this.api.post<NewsStory>(`/news/stories/${id}/move`, { bulletinId });
  }
  replaceLowerThirds(id: number, items: UpsertLowerThirdDto[]): Observable<NewsStory> {
    return this.api.put<NewsStory>(`/news/stories/${id}/lower-thirds`, { items });
  }
  sendToAir(storyId: number, dto: SendToAirDto): Observable<SendToAirResult> {
    return this.api.post<SendToAirResult>(`/news/stories/${storyId}/send`, dto);
  }

  // ---- MOS cihaz + Ajans ----
  listMosDevices(): Observable<NewsMosDevice[]> {
    return this.api.get<NewsMosDevice[]>('/news/mos/devices');
  }
  listWires(params?: { source?: string; priority?: string; used?: boolean }): Observable<NewsWireItem[]> {
    return this.api.get<NewsWireItem[]>('/news/wires', params as Record<string, string | boolean>);
  }
  createWire(dto: { source: string; headline: string; body?: string; priority?: string; category?: string }): Observable<NewsWireItem> {
    return this.api.post<NewsWireItem>('/news/wires', dto);
  }
  wireToStory(id: number, newsGroup?: string | null): Observable<NewsStory> {
    return this.api.post<NewsStory>(`/news/wires/${id}/to-story`, { newsGroup });
  }
}

/** EGS "Haberin Türü" etiketleri (UI gösterimi). */
export const STORY_TYPE_LABELS: Record<string, string> = {
  PKG: 'Paket', VO: 'VO', VOSOT: 'VO/SOT', READER: 'Spiker',
  LIVE: 'Canlı', PHONE: 'Telefon', CRAWL: 'Crawl', ROLL: 'Roll',
};

export const BULLETIN_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Taslak', READY: 'Hazır', ON_AIR: 'Yayında', DONE: 'Bitti', ARCHIVED: 'Arşiv',
};

/** Gün-dakikası → "HH:MM". */
export function minuteToHHMM(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "HH:MM" → gün-dakikası. */
export function hhmmToMinute(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Saniye → "M:SS" (bant süresi). */
export function secToClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
