import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ApiService } from './api.service';
import {
  SCHEDULE_LOOKUP_TYPES,
  type CreateBroadcastScheduleDto,
  type LivePlanEntry,
  type LivePlanListResponse,
  type PaginatedResponse,
  type Schedule,
  type ScheduleLookupListResponse,
  type ScheduleLookupOption,
  type ScheduleLookupType,
  type UpdateBroadcastScheduleDto,
} from '@bcms/shared';

/**
 * SCHED-B4 — Yayın Planlama (broadcast flow) HTTP service.
 *
 * Backend (canonical):
 *   - `GET    /api/v1/schedules/broadcast`        list (server-side filter)
 *   - `GET    /api/v1/schedules/:id`              detail (legacy endpoint;
 *                                                  broadcast flow row dönerse
 *                                                  canonical alanlar dolu)
 *   - `POST   /api/v1/schedules/broadcast`        create
 *   - `PATCH  /api/v1/schedules/broadcast/:id`    update (If-Match)
 *   - `DELETE /api/v1/schedules/broadcast/:id`    delete + live-plan slot NULL
 *   - `GET    /api/v1/schedules/lookups/:type`    read-only lookup options
 *
 * Lookup type whitelist `@bcms/shared:SCHEDULE_LOOKUP_TYPES` üzerinden alınır;
 * component içinde magic string yok.
 *
 * Cache invalidation:
 *   - Schedule mutation: ApiService otomatik `/schedules` prefix'ini temizler.
 *   - Cross-domain: live-plan reverse sync (B3a/B3b — channel propagation +
 *     scheduleDate→eventStartTime) bu service'ten manuel `/live-plan` prefix
 *     invalidate ile tamamlanır (mutation method'larında çağrılır).
 *
 * If-Match: PATCH/DELETE optimistic locking için version parametresi (K-B3.9).
 */

export interface YayinPlanlamaFilter {
  /** event_key tam eşleşme (UNIQUE; tek satır döner). */
  eventKey?: string;
  /** YYYY-MM-DD — canonical scheduleDate range start (B5 paritesi: legacy
   *  start_time/end_time DROP olunca da çalışır). */
  from?:     string;
  /** YYYY-MM-DD — canonical scheduleDate range end. */
  to?:       string;
  status?:   string;
  page?:     number;
  pageSize?: number;
}

/**
 * 2026-05-13: Yayın Planlama listesi artık /api/v1/live-plan endpoint'inden
 * besleniyor — her aktif Canlı Yayın Plan kaydı (eventKey/scheduleId şartı
 * yok) listede görünür. Lig/Hafta filter Match relation üzerinden. EventKey
 * filtresi kaldırıldı (live-plan eventKey non-unique; filter anlamsız).
 */
export interface LivePlanListFilter {
  /** ISO UTC — eventStartTime >= from. */
  from?:       string;
  /** ISO UTC — eventStartTime <= to. */
  to?:         string;
  /** Comma-separated multi value: PLANNED,READY,IN_PROGRESS. */
  status?:     string;
  /** Lig filter; manuel entry (matchId null) bu filter aktifken hariç. */
  leagueId?:   number;
  /** Hafta filter; null weekNumber entry'ler hariç. */
  weekNumber?: number;
  page?:       number;
  pageSize?:   number;
}

export interface LeagueFilterOption {
  id:   number;
  name: string;
}

@Injectable({ providedIn: 'root' })
export class YayinPlanlamaService {
  private readonly api = inject(ApiService);

  // ── List ────────────────────────────────────────────────────────────────
  /** [legacy] GET /api/v1/schedules/broadcast — broadcast-complete schedule
   *  row guarantee. Yayın Planlama listesi 2026-05-13 itibarıyla
   *  `getLivePlanList()` kullanır; bu method form/picker akışı için
   *  geriye-uyumluluk amacıyla korundu. */
  getList(filter: YayinPlanlamaFilter = {}): Observable<PaginatedResponse<Schedule>> {
    const params: Record<string, string | number | boolean> = {};
    if (filter.eventKey) params['eventKey'] = filter.eventKey;
    if (filter.from)     params['from']     = filter.from;
    if (filter.to)       params['to']       = filter.to;
    if (filter.status)   params['status']   = filter.status;
    if (filter.page)     params['page']     = filter.page;
    if (filter.pageSize) params['pageSize'] = filter.pageSize;
    return this.api.get<PaginatedResponse<Schedule>>('/schedules/broadcast', params);
  }

  /**
   * 2026-05-13: Yayın Planlama listesi canonical endpoint — Canlı Yayın
   * Plan'daki tüm aktif kayıtlar (`deletedAt IS NULL`). EventKey/schedule
   * şartı yok; manuel + OPTA kayıtların tümü görünür. Lig/Hafta filter
   * Match relation üzerinden — manuel entry (matchId null) bu filter
   * aktifken doğal olarak hariç.
   */
  getLivePlanList(filter: LivePlanListFilter = {}): Observable<LivePlanListResponse> {
    const params: Record<string, string | number | boolean> = {};
    if (filter.from)       params['from']       = filter.from;
    if (filter.to)         params['to']         = filter.to;
    if (filter.status)     params['status']     = filter.status;
    if (filter.leagueId)   params['leagueId']   = filter.leagueId;
    if (filter.weekNumber) params['weekNumber'] = filter.weekNumber;
    if (filter.page)       params['page']       = filter.page;
    if (filter.pageSize)   params['pageSize']   = filter.pageSize;
    return this.api.get<LivePlanListResponse>('/live-plan', params);
  }

  /**
   * Aktif live-plan entry'lerde kullanılan distinct lig listesi.
   * UI Lig dropdown source.
   */
  getLeagueFilterOptions(): Observable<LeagueFilterOption[]> {
    return this.api.get<LeagueFilterOption[]>('/live-plan/filters/leagues');
  }

  /**
   * Aktif live-plan entry'lerde kullanılan distinct hafta numaraları.
   * `leagueId` verilirse o lige scope'lanır. Null weekNumber dahil edilmez.
   */
  getWeekFilterOptions(leagueId?: number): Observable<number[]> {
    const params: Record<string, string | number | boolean> = {};
    if (leagueId !== undefined) params['leagueId'] = leagueId;
    return this.api.get<number[]>('/live-plan/filters/weeks', params);
  }

  /**
   * 2026-05-13: Yayın Planlama listesinde inline kanal düzenleme.
   *
   * **Bu update LivePlanEntry üstüne yazılır; Schedule veya
   * /schedules/broadcast KULLANILMAZ.** `PATCH /api/v1/live-plan/:id` +
   * `If-Match: version` kanonik canlı yayın plan entry mutation path'i.
   * Aynı kayıt Canlı Yayın Plan sekmesinde de güncel görünür (tek tablo
   * tek satır).
   *
   * - `If-Match` zorunlu (K9 optimistic locking; backend `parseIfMatch`)
   * - 412 → caller reload yapsın
   * - Success → yeni LivePlanEntry (artırılmış version); `/live-plan` cache
   *   invalidate (Canlı Yayın Plan listesi de yenilensin)
   */
  updateLivePlanChannels(
    id:      number,
    dto:     { channel1Id: number | null; channel2Id: number | null; channel3Id: number | null },
    version: number,
  ): Observable<LivePlanEntry> {
    return this.api.patch<LivePlanEntry>(`/live-plan/${id}`, dto, version).pipe(
      map((res) => {
        this.api.invalidateCache('/live-plan');
        return res;
      }),
    );
  }

  /**
   * 2026-05-13: Yayın Planlama seçimli Excel export.
   * POST /api/v1/live-plan/export — body { ids: number[1..500], title? }.
   * Backend ExcelJS ile xlsx blob üretir; frontend download tetikler.
   */
  exportLivePlanExcel(ids: number[], title?: string): Observable<Blob> {
    return this.api.postBlob('/live-plan/export', { ids, ...(title ? { title } : {}) });
  }

  getById(id: number): Observable<Schedule> {
    return this.api.get<Schedule>(`/schedules/${id}`);
  }

  // ── Create ──────────────────────────────────────────────────────────────
  create(dto: CreateBroadcastScheduleDto): Observable<Schedule> {
    return this.api.post<Schedule>('/schedules/broadcast', dto).pipe(
      // Cross-domain invalidate — channel propagation tx live-plan entry'in
      // channel_1/2/3 alanlarını günceller; live-plan list/detail cache stale.
      map((res) => {
        this.api.invalidateCache('/live-plan');
        return res;
      }),
    );
  }

  // ── Update (If-Match version) ───────────────────────────────────────────
  update(
    id:      number,
    dto:     UpdateBroadcastScheduleDto,
    version: number,
  ): Observable<Schedule> {
    return this.api.patch<Schedule>(`/schedules/broadcast/${id}`, dto, version).pipe(
      map((res) => {
        this.api.invalidateCache('/live-plan');
        return res;
      }),
    );
  }

  // ── Delete ──────────────────────────────────────────────────────────────
  /** K-B3.16: schedule sil → aynı event_key'li live_plan_entries channel slot
   *  NULL yapılır (backend tx). Cross-domain invalidate zorunlu. */
  delete(id: number): Observable<void> {
    return this.api.delete<void>(`/schedules/broadcast/${id}`).pipe(
      map((res) => {
        this.api.invalidateCache('/live-plan');
        return res;
      }),
    );
  }

  // ── Lookup options (read-only) ──────────────────────────────────────────
  /** GET /api/v1/schedules/lookups/:type — Yayın Planlama formu dropdown.
   *  Type whitelist SCHEDULE_LOOKUP_TYPES; magic string yok. */
  getLookupOptions(
    type:        ScheduleLookupType,
    activeOnly = true,
  ): Observable<ScheduleLookupOption[]> {
    if (!SCHEDULE_LOOKUP_TYPES.includes(type)) {
      throw new Error(`Geçersiz lookup type: ${type}`);
    }
    const params: Record<string, string | number | boolean> = {};
    if (activeOnly) params['activeOnly'] = 'true';
    return this.api
      .get<ScheduleLookupListResponse>(`/schedules/lookups/${type}`, params)
      .pipe(map((res) => res.items));
  }
}
