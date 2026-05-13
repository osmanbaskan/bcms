import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ApiService } from './api.service';

/**
 * 2026-05-13: OPTA lig görünürlük yönetimi.
 *
 * `GET /api/v1/opta/competitions/admin` — tüm ligler + visible/sortOrder.
 * `PATCH /api/v1/opta/competitions/admin/:id` — visible/sortOrder güncelle.
 *
 * Hardcoded FEATURED array kaldırıldı; /opta/fixture-competitions endpoint'i
 * artık DB-driven (`visible=true`) filtre kullanır — Canlı Yayın Plan
 * "Yeni Ekle" dialog'unda sadece görünür ligler gözükür.
 *
 * Permission: `PERMISSIONS.opta.admin = ['SystemEng']` + Admin auto-bypass.
 */

export interface OptaCompetitionAdminItem {
  id:        number;
  code:      string;
  name:      string;
  country:   string;
  visible:   boolean;
  sortOrder: number;
}

export interface OptaCompetitionAdminPatch {
  visible?:   boolean;
  sortOrder?: number;
}

@Injectable({ providedIn: 'root' })
export class OptaAdminService {
  private readonly api = inject(ApiService);

  getCompetitionAdminList(): Observable<OptaCompetitionAdminItem[]> {
    return this.api.get<OptaCompetitionAdminItem[]>('/opta/competitions/admin');
  }

  updateCompetitionAdmin(
    id:  number,
    dto: OptaCompetitionAdminPatch,
  ): Observable<OptaCompetitionAdminItem> {
    return this.api.patch<OptaCompetitionAdminItem>(`/opta/competitions/admin/${id}`, dto).pipe(
      map((res) => {
        // Cross-cache invalidate — /opta/fixture-competitions çağrısı stale kalmasın.
        this.api.invalidateCache('/opta');
        return res;
      }),
    );
  }
}
