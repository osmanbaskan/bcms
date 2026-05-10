import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ApiService } from './api.service';
import type {
  Schedule,
  ScheduleStatus,
  PaginatedResponse,
  LivePlanEntry,
  LivePlanListResponse,
  LivePlanStatus,
  CreateLivePlanEntryDto,
  UpdateLivePlanEntryDto,
  CreateLivePlanFromOptaDto,
} from '@bcms/shared';

export interface ScheduleFilter {
  channel?: number;
  from?: string;
  to?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

// SCHED-B5a (Y5-1, ikinci revize 2026-05-08): Canlı Yayın Plan UI datasource
// migration. Bu wrapper eski schedule-list bileşeninin ScheduleService API
// kontratını korur (`getSchedules` → PaginatedResponse<Schedule>) ama altta
// `/api/v1/live-plan` endpoint'ine bağlanır.
//
// Mutation restore (2026-05-10): canonical command metodları eklendi —
// createLivePlanEntry / createLivePlanFromOpta / updateLivePlanEntry /
// duplicateLivePlanEntry / deleteLivePlanEntry. Hepsi `/api/v1/live-plan*`
// canonical endpoint'lerine bağlanır; legacy `/schedules` mutation YOK,
// JSON/metadata YOK. Display'e döndüğünde mapper Schedule shape'ine çevirir.

const STATUS_MAP: Record<LivePlanStatus, ScheduleStatus> = {
  PLANNED:     'CONFIRMED',
  READY:       'CONFIRMED',
  IN_PROGRESS: 'ON_AIR',
  COMPLETED:   'COMPLETED',
  CANCELLED:   'CANCELLED',
};

export function mapLivePlanEntryToSchedule(entry: LivePlanEntry): Schedule {
  return {
    id:           entry.id,
    matchId:      entry.matchId,
    startTime:    entry.eventStartTime,
    endTime:      entry.eventEndTime,
    title:        entry.title,
    status:       STATUS_MAP[entry.status],
    createdBy:    entry.createdBy ?? '',
    version:      entry.version,
    metadata:     {},
    createdAt:    entry.createdAt,
    updatedAt:    entry.updatedAt,
    optaMatchId:  entry.optaMatchId,
    eventKey:     entry.eventKey,
    team1Name:    entry.team1Name,
    team2Name:    entry.team2Name,
    channel1Id:   entry.channel1Id,
    channel2Id:   entry.channel2Id,
    channel3Id:   entry.channel3Id,
    channel:      null,
  };
}

@Injectable({ providedIn: 'root' })
export class ScheduleService {
  private api = inject(ApiService);

  getSchedules(filter: ScheduleFilter = {}): Observable<PaginatedResponse<Schedule>> {
    const query: Record<string, string | number | boolean> = {};
    if (filter.from)     query['from']     = filter.from;
    if (filter.to)       query['to']       = filter.to;
    if (filter.page)     query['page']     = filter.page;
    if (filter.pageSize) query['pageSize'] = filter.pageSize;

    return this.api.get<LivePlanListResponse>('/live-plan', query).pipe(
      map((res) => ({
        data:       res.items.map(mapLivePlanEntryToSchedule),
        total:      res.total,
        page:       res.page,
        pageSize:   res.pageSize,
        totalPages: res.pageSize > 0 ? Math.ceil(res.total / res.pageSize) : 0,
      })),
    );
  }

  // ── Mutation restore (2026-05-10) — canonical live-plan command path ────

  /** Manuel create: backend forced sourceType=MANUAL + eventKey=`manual:<uuid>`. */
  createLivePlanEntry(dto: CreateLivePlanEntryDto): Observable<Schedule> {
    return this.api.post<LivePlanEntry>('/live-plan', dto).pipe(
      map(mapLivePlanEntryToSchedule),
    );
  }

  /** OPTA seçim akışı: matches.opta_uid'den temel bilgi kopya. 409 default
   *  duplicate engelleme caller tarafından snack ile gösterilir. */
  createLivePlanFromOpta(dto: CreateLivePlanFromOptaDto): Observable<Schedule> {
    return this.api.post<LivePlanEntry>('/live-plan/from-opta', dto).pipe(
      map(mapLivePlanEntryToSchedule),
    );
  }

  /** PATCH /live-plan/:id + If-Match: <version>. K9 — version conflict 412. */
  updateLivePlanEntry(
    id: number,
    dto: UpdateLivePlanEntryDto,
    version: number,
  ): Observable<Schedule> {
    return this.api.patch<LivePlanEntry>(`/live-plan/${id}`, dto, version).pipe(
      map(mapLivePlanEntryToSchedule),
    );
  }

  /** POST /live-plan/:id/duplicate — same eventKey kopya entry; status reset
   *  PLANNED. 409 default duplicate engelleme caller snack ile gösterir. */
  duplicateLivePlanEntry(id: number): Observable<Schedule> {
    return this.api.post<LivePlanEntry>(`/live-plan/${id}/duplicate`, {}).pipe(
      map(mapLivePlanEntryToSchedule),
    );
  }

  /** DELETE /live-plan/:id + If-Match: <version>. Hard-delete (M5-B1 K-B3). */
  deleteLivePlanEntry(id: number, version: number): Observable<void> {
    return this.api.delete<void>(`/live-plan/${id}`, version);
  }
}
