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

/** 2026-05-11: Yeni Ekle dialog (Fikstürden Seç) için minimal display tipler.
 *  Backend route response shape'leri ile birebir. */
export interface BroadcastType {
  id:          number;
  code:        string;
  description: string;
}

/** 2026-05-13: Sport bazlı UI gruplandırma (mat-optgroup). */
export type FixtureSportGroup = 'football' | 'tennis' | 'motogp' | 'rugby' | 'formula1' | 'basketball';

export interface FixtureCompetition {
  id:         string;
  name:       string;
  season:     string;
  /** Backend `/opta/fixture-competitions` response'una 2026-05-13 eklendi.
   *  Geriye uyumluluk için optional; opsiyonel boş gelirse 'football'. */
  sportGroup?: FixtureSportGroup;
}

export interface OptaFixtureRow {
  matchId:         string;
  competitionId:   string;
  competitionName: string;
  season:          string;
  homeTeamName:    string;
  awayTeamName:    string;
  matchDate:       string;
  weekNumber?:     number | null;
  label?:          string;
}

/** 2026-05-14: Manuel takım listesi destekli ligler (OPTA fixture'ı olmayan
 *  ama DB-backed team kaydı bulunan, ör. Türkiye Basketbol Ligi). */
export interface ManualLeague {
  id:         number;
  code:       string;
  name:       string;
  country:    string;
  sportGroup: string;
  teamCount:  number;
}

export interface ManualTeam {
  id:        number;
  leagueId:  number;
  name:      string;
  shortName: string;
}

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

// Hard delete (2026-05-11): ScheduleStatus.ON_AIR kaldırıldı. LivePlanEntry
// IN_PROGRESS canlı yayın source-of-truth'unu temsil eder; Schedule
// projeksiyonu IN_PROGRESS değerini CONFIRMED'a düşürmez (sahte mapping
// yasak) — mapper IN_PROGRESS için Schedule shape'inde CONFIRMED bırakır,
// "canlı" durumu LivePlanEntry tarafından ayrıca okunur.
const STATUS_MAP: Record<LivePlanStatus, ScheduleStatus> = {
  PLANNED:     'CONFIRMED',
  READY:       'CONFIRMED',
  IN_PROGRESS: 'CONFIRMED',
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
    // 2026-05-11: liste display alanları — backend list response'tan flatten.
    leagueName:       entry.leagueName ?? null,
    technicalDetails: entry.technicalDetails ?? null,
    operationNotes:   entry.operationNotes ?? null,
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

  // 2026-05-11: Yeni Yayın Kaydı Ekle dialog OPTA fixture seçim akışı için
  // helper'lar. Cache: /broadcast-types ve /opta/fixture-competitions zaten
  // ApiService CACHEABLE_PATHS listesinde (60s TTL).
  getBroadcastTypes(): Observable<BroadcastType[]> {
    return this.api.get<BroadcastType[]>('/broadcast-types');
  }

  getFixtureCompetitions(): Observable<FixtureCompetition[]> {
    return this.api.get<FixtureCompetition[]>('/opta/fixture-competitions');
  }

  getOptaFixtures(competitionId: string, season: string, fromIso?: string): Observable<OptaFixtureRow[]> {
    const params: Record<string, string> = { competitionId, season };
    if (fromIso) params['from'] = fromIso;
    return this.api.get<OptaFixtureRow[]>('/opta/fixtures', params);
  }

  /** 2026-05-14: Manuel takım listesi destekli ligler (OPTA fixture'ı olmayan
   *  ama DB-backed team listesi olan ligler). Yayın Planlama "Yeni Ekle /
   *  Manuel Giriş" dropdown'ı için. */
  getManualLeagues(): Observable<ManualLeague[]> {
    return this.api.get<ManualLeague[]>('/matches/leagues/manual');
  }

  /** 2026-05-14: Tek ligin takımları. Home/away select doldurmak için. */
  getTeamsByLeague(leagueId: number): Observable<ManualTeam[]> {
    return this.api.get<ManualTeam[]>(`/matches/leagues/${leagueId}/teams`);
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
