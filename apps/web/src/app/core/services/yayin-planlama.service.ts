import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ApiService } from './api.service';
import {
  SCHEDULE_LOOKUP_TYPES,
  type CreateBroadcastScheduleDto,
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
  from?:     string;
  to?:       string;
  status?:   string;
  page?:     number;
  pageSize?: number;
}

@Injectable({ providedIn: 'root' })
export class YayinPlanlamaService {
  private readonly api = inject(ApiService);

  // ── List ────────────────────────────────────────────────────────────────
  /** GET /api/v1/schedules/broadcast — server-side broadcast-complete filter:
   *  eventKey/selectedLivePlanEntryId/scheduleDate/scheduleTime not null.
   *  Pagination server-side; frontend-side post-filter YOK (yanlış sayfa
   *  sayımı önlenir). */
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
