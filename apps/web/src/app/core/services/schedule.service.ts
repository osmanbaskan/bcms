import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ApiService } from './api.service';
import type { Schedule, ScheduleStatus, PaginatedResponse } from '@bcms/shared';

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
// `/api/v1/live-plan` endpoint'ine bağlanır. Mutation metodları YOK — Canlı
// Yayın Plan B5a'da liste odaklı / read-only; create/edit Yayın Planlama
// üstünden yapılır.

type LivePlanStatus = 'PLANNED' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

interface LivePlanEntry {
  id:             number;
  title:          string;
  eventStartTime: string;
  eventEndTime:   string;
  matchId:        number | null;
  optaMatchId:    string | null;
  status:         LivePlanStatus;
  operationNotes: string | null;
  createdBy:      string | null;
  version:        number;
  createdAt:      string;
  updatedAt:      string;
  deletedAt:      string | null;
  eventKey:       string | null;
  sourceType:     string;
  channel1Id:     number | null;
  channel2Id:     number | null;
  channel3Id:     number | null;
  team1Name:      string | null;
  team2Name:      string | null;
}

interface LivePlanListResponse {
  items:    LivePlanEntry[];
  total:    number;
  page:     number;
  pageSize: number;
}

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
    channelId:    entry.channel1Id,
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
}
