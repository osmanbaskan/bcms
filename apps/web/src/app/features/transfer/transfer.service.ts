import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import type {
  TransferJobDto,
  EnqueueTransferRequest,
  EnqueueTransferResponse,
  TransferJobsResponse,
} from '@bcms/shared';

/**
 * Restore V2 — kademe 3 (Interplay'den production storage'a) frontend service.
 *
 * 3 kademe modeli (2026-05-28): body { restoreJobId }; backend restore DONE
 * job'tan asset bilgisini kopyalar.
 *
 * Signal map cross-sharing: Restore sekmesi 5sn polling ile günceller; Transfer
 * butonu restore.status === 'DONE' iken enable olur.
 */
@Injectable({ providedIn: 'root' })
export class TransferService {
  private readonly api = inject(ApiService);

  readonly jobsByDcDate = signal<Map<string, TransferJobDto>>(new Map());
  readonly lastDate = signal<string | null>(null);

  jobFor(dcCode: string, scheduleDate: string): TransferJobDto | undefined {
    return this.jobsByDcDate().get(this.key(dcCode, scheduleDate));
  }

  async enqueue(input: EnqueueTransferRequest): Promise<EnqueueTransferResponse> {
    return firstValueFrom(this.api.post<EnqueueTransferResponse>('/transfer/jobs', input));
  }

  /** Today-future scope: date opsiyonel; yoksa scheduleDate >= today. */
  async fetchJobs(date?: string): Promise<TransferJobDto[]> {
    const resp = await firstValueFrom(
      date
        ? this.api.get<TransferJobsResponse>('/transfer/jobs', { date })
        : this.api.get<TransferJobsResponse>('/transfer/jobs'),
    );
    const map = new Map<string, TransferJobDto>();
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
