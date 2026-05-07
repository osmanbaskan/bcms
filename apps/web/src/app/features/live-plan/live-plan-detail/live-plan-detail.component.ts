import { Component, OnInit, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatTabsModule } from '@angular/material/tabs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDividerModule } from '@angular/material/divider';
import { KeycloakService } from 'keycloak-angular';
import { GROUP, PERMISSIONS } from '@bcms/shared';

import { ApiService } from '../../../core/services/api.service';
import { isSkipAuthAllowed } from '../../../core/auth/skip-auth';
import type { BcmsTokenParsed } from '../../../core/types/auth';
import {
  LIVE_PLAN_STATUS_LABELS,
  livePlanEndpoint,
  type LivePlanEntry,
} from '../live-plan.types';
import { TransmissionSegmentsComponent } from './transmission-segments.component';

/**
 * Madde 5 M5-B10a — Live-Plan Detail page (iskelet).
 *
 * Y10: Detay ayrı sayfa (modal değil).
 * Y11: 6 mat-tab full form **M5-B10b'de** gelir; M5-B10a'da sadece:
 *   - "Genel Bilgi" sekmesi (entry meta read-only)
 *   - "Transmisyon Süreleri" sekmesi (full CRUD)
 *   - "Teknik Detay" sekmesi placeholder ("M5-B10b'de eklenecek")
 *
 * Auth: page read all-auth; write/delete butonları role-check.
 */
@Component({
  selector: 'app-live-plan-detail',
  standalone: true,
  imports: [
    CommonModule, RouterLink,
    MatButtonModule, MatIconModule, MatChipsModule, MatTabsModule,
    MatProgressSpinnerModule, MatSnackBarModule, MatDividerModule,
    TransmissionSegmentsComponent,
  ],
  template: `
    <div class="page-header">
      <button mat-icon-button [routerLink]="['/live-plan']" matTooltip="Listeye dön">
        <mat-icon>arrow_back</mat-icon>
      </button>
      <h2>Canlı Yayın Plan #{{ entryId() ?? '?' }}</h2>
      @if (entry(); as e) {
        <mat-chip class="status-chip">{{ statusLabel(e.status) }}</mat-chip>
      }
    </div>

    @if (loading()) {
      <div class="loading"><mat-spinner diameter="36"></mat-spinner></div>
    } @else if (!entry()) {
      <div class="empty">Kayıt bulunamadı.</div>
    } @else {
      <mat-tab-group class="tabs">
        <mat-tab label="Genel Bilgi">
          <div class="tab-pad">
            <div class="meta-grid">
              <div><b>Başlık</b></div><div>{{ entry()!.title }}</div>
              <div><b>Başlangıç (UTC)</b></div><div>{{ entry()!.eventStartTime }}</div>
              <div><b>Bitiş (UTC)</b></div><div>{{ entry()!.eventEndTime }}</div>
              <div><b>Durum</b></div><div>{{ statusLabel(entry()!.status) }}</div>
              <div><b>OPTA Match</b></div><div>{{ entry()!.optaMatchId ?? '—' }}</div>
              <div><b>Internal Match</b></div><div>{{ entry()!.matchId ?? '—' }}</div>
              <div><b>Oluşturan</b></div><div>{{ entry()!.createdBy ?? '—' }}</div>
              <div><b>Versiyon</b></div><div>v{{ entry()!.version }}</div>
              <div><b>Notlar</b></div><div>{{ entry()!.operationNotes ?? '—' }}</div>
            </div>
            <p class="hint">
              Düzenleme + 73 alan teknik detay formu M5-B10b PR'ında eklenecek.
              Bu PR yalnız iskelet + Transmisyon Süreleri.
            </p>
          </div>
        </mat-tab>

        <mat-tab label="Transmisyon Süreleri">
          <div class="tab-pad">
            <app-transmission-segments
              [entryId]="entryId()!"
              [canWrite]="canWrite()"
              [canDelete]="canDelete()">
            </app-transmission-segments>
          </div>
        </mat-tab>

        <mat-tab label="Teknik Detay" disabled>
          <div class="tab-pad placeholder">
            76 alan teknik detay formu (Yayın/OB · Ortak · IRD/Fiber · Ana Feed ·
            Yedek Feed · Fiber Format) M5-B10b PR'ında eklenecek.
          </div>
        </mat-tab>
      </mat-tab-group>
    }
  `,
  styles: [`
    .page-header { display:flex; align-items:center; gap:12px; padding:16px 24px 8px; }
    .page-header h2 { margin:0; font-size:20px; font-weight:500; flex:1; }
    .status-chip { font-size:11px; }
    .loading { display:flex; justify-content:center; padding:60px; }
    .empty { padding:60px; text-align:center; color:#888; }
    .tabs { padding: 0 24px; }
    .tab-pad { padding: 16px 0; }
    .meta-grid { display:grid; grid-template-columns: 180px 1fr; gap:6px 16px; font-size:14px; }
    .meta-grid b { color:#888; font-weight:500; }
    .hint { color:#888; font-size:12px; margin-top:24px; }
    .placeholder { padding: 32px; color:#888; text-align:center; font-size:14px; }
  `],
})
export class LivePlanDetailComponent implements OnInit {
  private api      = inject(ApiService);
  private route    = inject(ActivatedRoute);
  private router   = inject(Router);
  private snack    = inject(MatSnackBar);
  private keycloak = inject(KeycloakService);

  entryId    = signal<number | null>(null);
  entry      = signal<LivePlanEntry | null>(null);
  loading    = signal(true);
  userGroups = signal<string[]>([]);

  isAdmin   = computed(() => this.userGroups().includes(GROUP.Admin));
  canWrite  = computed(() => this.isAdmin()
    || PERMISSIONS.livePlan.write.some((g) => this.userGroups().includes(g)));
  canDelete = computed(() => this.isAdmin()
    || PERMISSIONS.livePlan.delete.some((g) => this.userGroups().includes(g)));

  statusLabel = (s: keyof typeof LIVE_PLAN_STATUS_LABELS) => LIVE_PLAN_STATUS_LABELS[s];

  ngOnInit() {
    // RBAC user groups
    if (isSkipAuthAllowed()) {
      this.userGroups.set([GROUP.SystemEng]);
    } else {
      const kc = this.keycloak.getKeycloakInstance();
      const parsed: BcmsTokenParsed = (kc?.tokenParsed as BcmsTokenParsed | undefined) ?? {};
      this.userGroups.set(parsed.groups ?? []);
    }

    // Route param parse
    this.route.paramMap.subscribe((pm) => {
      const raw = pm.get('entryId');
      const id = raw ? parseInt(raw, 10) : NaN;
      if (!Number.isFinite(id) || id <= 0) {
        this.snack.open('Geçersiz entry id', 'Kapat', { duration: 4000 });
        this.router.navigate(['/live-plan']);
        return;
      }
      this.entryId.set(id);
      this.load(id);
    });
  }

  load(id: number) {
    this.loading.set(true);
    this.api.get<LivePlanEntry>(livePlanEndpoint.detail(id)).subscribe({
      next: (e) => { this.entry.set(e); this.loading.set(false); },
      error: () => {
        this.entry.set(null);
        this.loading.set(false);
        this.snack.open('Kayıt yüklenemedi', 'Kapat', { duration: 4000 });
      },
    });
  }
}
