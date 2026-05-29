import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import type {
  SearchJobDto,
  EnqueueSearchRequest,
  EnqueueSearchResponse,
  SearchJobsResponse,
  SelectAssetRequest,
} from '@bcms/shared';

/**
 * Restore V2 — kademe 1 (search) frontend service.
 *
 * Signal map (`jobsByDcDate`) Provys panel + Restore sekmesi arasında paylaşılır;
 * tek polling kaynağı (Restore sekmesi) sayesinde panel butonları otomatik
 * güncellenir. Map key: `${dcCode}|${scheduleDate}`.
 *
 * 3 kademe modeli: 'Ara' butonu enqueue → AWAITING_SELECTION → operatör seçim
 * dialog'undan asset seçer → PATCH select → SELECTED → restore enable.
 */
@Injectable({ providedIn: 'root' })
export class SearchService {
  private readonly api = inject(ApiService);

  /** dcCode|scheduleDate -> en güncel search job kaydı. */
  readonly jobsByDcDate = signal<Map<string, SearchJobDto>>(new Map());
  readonly lastDate = signal<string | null>(null);

  jobFor(dcCode: string, scheduleDate: string): SearchJobDto | undefined {
    return this.jobsByDcDate().get(this.key(dcCode, scheduleDate));
  }

  async enqueue(input: EnqueueSearchRequest): Promise<EnqueueSearchResponse> {
    return firstValueFrom(this.api.post<EnqueueSearchResponse>('/search/jobs', input));
  }

  async selectAsset(jobId: number, body: SelectAssetRequest): Promise<SearchJobDto> {
    return firstValueFrom(
      this.api.patch<SearchJobDto>(`/search/jobs/${jobId}/select`, body),
    );
  }

  /**
   * Today-future scope (2026-05-28): `date` parametresi opsiyonel.
   *  - `date` verilirse legacy single-date GET.
   *  - `date` undefined ise scheduleDate >= today (Restore sekmesi varsayılan).
   */
  async fetchJobs(date?: string): Promise<SearchJobDto[]> {
    const resp = await firstValueFrom(
      date
        ? this.api.get<SearchJobsResponse>('/search/jobs', { date })
        : this.api.get<SearchJobsResponse>('/search/jobs'),
    );
    const map = new Map<string, SearchJobDto>();
    for (const job of resp.jobs) {
      const k = this.key(job.dcCode, job.scheduleDate);
      const existing = map.get(k);
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
