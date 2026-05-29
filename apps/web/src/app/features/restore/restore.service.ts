import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import type {
  RestoreJobDto,
  EnqueueRestoreRequest,
  EnqueueRestoreResponse,
  RestoreJobsResponse,
} from '@bcms/shared';

/**
 * Restore V2 — kademe 2 (Avid arşivinden Interplay workspace'e) frontend service.
 *
 * 3 kademe modeli (2026-05-28): body { searchJobId }; backend search SELECTED
 * job'tan asset bilgisini kopyalar.
 *
 * Signal map (`jobsByDcDate`) cross-sharing: Restore sekmesi 5sn polling ile
 * günceller, butonlar reaktif state'e göre etkin/disable olur.
 */
@Injectable({ providedIn: 'root' })
export class RestoreService {
  private readonly api = inject(ApiService);

  /** dcCode|scheduleDate -> en güncel job kaydı. */
  readonly jobsByDcDate = signal<Map<string, RestoreJobDto>>(new Map());
  readonly lastDate = signal<string | null>(null);

  jobFor(dcCode: string, scheduleDate: string): RestoreJobDto | undefined {
    return this.jobsByDcDate().get(this.key(dcCode, scheduleDate));
  }

  async enqueue(input: EnqueueRestoreRequest): Promise<EnqueueRestoreResponse> {
    return firstValueFrom(this.api.post<EnqueueRestoreResponse>('/restore/jobs', input));
  }

  /** Today-future scope: date opsiyonel; yoksa scheduleDate >= today. */
  async fetchJobs(date?: string): Promise<RestoreJobDto[]> {
    const resp = await firstValueFrom(
      date
        ? this.api.get<RestoreJobsResponse>('/restore/jobs', { date })
        : this.api.get<RestoreJobsResponse>('/restore/jobs'),
    );
    const map = new Map<string, RestoreJobDto>();
    for (const job of resp.jobs) {
      const k = this.key(job.dcCode, job.scheduleDate);
      const existing = map.get(k);
      // Aynı (dcCode,date) için birden çok satır varsa en yenisini tut
      // (terminal+aktif yan yana yaşar — partial unique active-only).
      if (!existing || existing.id < job.id) map.set(k, job);
    }
    this.jobsByDcDate.set(map);
    this.lastDate.set(resp.date);
    return resp.jobs;
  }

  private key(dcCode: string, scheduleDate: string): string {
    return `${dcCode}|${scheduleDate}`;
  }
}
