import { Component, OnInit, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { KeycloakService } from 'keycloak-angular';
import { GROUP, PERMISSIONS } from '@bcms/shared';

import { ApiService } from '../../../core/services/api.service';
import { isSkipAuthAllowed } from '../../../core/auth/skip-auth';
import type { BcmsTokenParsed } from '../../../core/types/auth';
import {
  LIVE_PLAN_STATUS_LABELS,
  livePlanEndpoint,
  type LivePlanEntry, type LivePlanListResponse,
} from '../live-plan.types';
import { LivePlanCreateDialogComponent } from './live-plan-create-dialog.component';

/**
 * Madde 5 M5-B10a — Live-Plan list page.
 *
 * Y1 lock: yeni `/live-plan` route, mevcut `/schedules` ekranına dokunulmaz.
 *
 * Görüntüleme: tüm authenticated (PERMISSIONS.livePlan.read = []).
 * Yeni: PERMISSIONS.livePlan.write (Tekyon/Transmisyon/Booking/YayınPlanlama
 *   + Admin auto-bypass).
 */
@Component({
  selector: 'app-live-plan-list',
  standalone: true,
  imports: [
    CommonModule, RouterLink,
    MatTableModule, MatButtonModule, MatIconModule, MatChipsModule,
    MatDialogModule, MatSnackBarModule, MatTooltipModule, MatProgressSpinnerModule,
  ],
  template: `
    <div class="page-header">
      <h2>Canlı Yayın Plan</h2>
      @if (canWrite()) {
        <button mat-raised-button color="primary" (click)="openCreate()">
          <mat-icon>add</mat-icon> Yeni
        </button>
      }
    </div>

    @if (loading()) {
      <div class="loading"><mat-spinner diameter="36"></mat-spinner></div>
    } @else if (rows().length === 0) {
      <div class="empty">Henüz live-plan kaydı yok.</div>
    } @else {
      <table mat-table [dataSource]="rows()" class="lp-table">
        <ng-container matColumnDef="id">
          <th mat-header-cell *matHeaderCellDef>#</th>
          <td mat-cell *matCellDef="let r">{{ r.id }}</td>
        </ng-container>
        <ng-container matColumnDef="title">
          <th mat-header-cell *matHeaderCellDef>Başlık</th>
          <td mat-cell *matCellDef="let r">{{ r.title }}</td>
        </ng-container>
        <ng-container matColumnDef="window">
          <th mat-header-cell *matHeaderCellDef>Pencere (UTC)</th>
          <td mat-cell *matCellDef="let r">{{ formatRange(r.eventStartTime, r.eventEndTime) }}</td>
        </ng-container>
        <ng-container matColumnDef="status">
          <th mat-header-cell *matHeaderCellDef>Durum</th>
          <td mat-cell *matCellDef="let r">
            <mat-chip>{{ statusLabel(r.status) }}</mat-chip>
          </td>
        </ng-container>
        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef></th>
          <td mat-cell *matCellDef="let r">
            <button mat-icon-button matTooltip="Detay" [routerLink]="['/live-plan', r.id]">
              <mat-icon>arrow_forward</mat-icon>
            </button>
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="cols"></tr>
        <tr mat-row *matRowDef="let row; columns: cols;" class="row" (click)="goDetail(row.id)"></tr>
      </table>
    }
  `,
  styles: [`
    .page-header { display:flex; justify-content:space-between; align-items:center; padding:16px 24px 8px; }
    .page-header h2 { margin:0; font-size:20px; font-weight:500; }
    .loading { display:flex; justify-content:center; padding:60px; }
    .empty { padding:60px; text-align:center; color:#888; font-size:14px; }
    .lp-table { width:100%; }
    .row { cursor: pointer; }
    .row:hover { background: rgba(255,255,255,0.04); }
  `],
})
export class LivePlanListComponent implements OnInit {
  private api      = inject(ApiService);
  private dialog   = inject(MatDialog);
  private snack    = inject(MatSnackBar);
  private router   = inject(Router);
  private keycloak = inject(KeycloakService);

  rows       = signal<LivePlanEntry[]>([]);
  loading    = signal(true);
  userGroups = signal<string[]>([]);

  cols = ['id', 'title', 'window', 'status', 'actions'];

  isAdmin   = computed(() => this.userGroups().includes(GROUP.Admin));
  canWrite  = computed(() => this.isAdmin()
    || PERMISSIONS.livePlan.write.some((g) => this.userGroups().includes(g)));

  statusLabel = (s: keyof typeof LIVE_PLAN_STATUS_LABELS) => LIVE_PLAN_STATUS_LABELS[s];

  ngOnInit() {
    if (isSkipAuthAllowed()) {
      this.userGroups.set([GROUP.SystemEng]);
    } else {
      const kc = this.keycloak.getKeycloakInstance();
      const parsed: BcmsTokenParsed = (kc?.tokenParsed as BcmsTokenParsed | undefined) ?? {};
      this.userGroups.set(parsed.groups ?? []);
    }
    this.load();
  }

  load() {
    this.loading.set(true);
    this.api.get<LivePlanListResponse>(livePlanEndpoint.list(), { pageSize: 200 }).subscribe({
      next: (res) => { this.rows.set(res.items ?? []); this.loading.set(false); },
      error: () => {
        this.loading.set(false);
        this.rows.set([]);
        this.snack.open('Liste yüklenemedi', 'Kapat', { duration: 4000 });
      },
    });
  }

  openCreate() {
    this.dialog.open(LivePlanCreateDialogComponent, { width: '480px' })
      .afterClosed().subscribe((entry: LivePlanEntry | undefined) => {
        if (entry?.id) {
          this.snack.open('Live-plan oluşturuldu', 'Kapat', { duration: 2500 });
          this.router.navigate(['/live-plan', entry.id]);
        }
      });
  }

  goDetail(id: number) {
    this.router.navigate(['/live-plan', id]);
  }

  formatRange(s: string, e: string): string {
    if (!s || !e) return '—';
    const sd = new Date(s);
    const ed = new Date(e);
    if (!Number.isFinite(sd.getTime()) || !Number.isFinite(ed.getTime())) return '—';
    const pad = (n: number) => n.toString().padStart(2, '0');
    const d = `${sd.getUTCFullYear()}-${pad(sd.getUTCMonth()+1)}-${pad(sd.getUTCDate())}`;
    const sh = `${pad(sd.getUTCHours())}:${pad(sd.getUTCMinutes())}`;
    const eh = `${pad(ed.getUTCHours())}:${pad(ed.getUTCMinutes())}`;
    return `${d} ${sh}–${eh}`;
  }
}
