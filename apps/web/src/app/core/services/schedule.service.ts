import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import type { Schedule, CreateScheduleDto, UpdateScheduleDto, PaginatedResponse, ScheduleUsage } from '@bcms/shared';

export interface ScheduleFilter {
  channel?: number;
  from?: string;
  to?: string;
  status?: string;
  usage?: ScheduleUsage;
  page?: number;
  pageSize?: number;
}

@Injectable({ providedIn: 'root' })
export class ScheduleService {
  constructor(private api: ApiService) {}

  getSchedules(filter: ScheduleFilter = {}): Observable<PaginatedResponse<Schedule>> {
    return this.api.get<PaginatedResponse<Schedule>>('/schedules', filter as Record<string, string | number | boolean>);
  }

  getSchedule(id: number): Observable<Schedule> {
    return this.api.get<Schedule>(`/schedules/${id}`);
  }

  createSchedule(dto: CreateScheduleDto): Observable<Schedule> {
    return this.api.post<Schedule>('/schedules', dto);
  }

  updateSchedule(id: number, dto: UpdateScheduleDto, version?: number): Observable<Schedule> {
    return this.api.patch<Schedule>(`/schedules/${id}`, dto, version);
  }

  deleteSchedule(id: number): Observable<void> {
    return this.api.delete<void>(`/schedules/${id}`);
  }
}
