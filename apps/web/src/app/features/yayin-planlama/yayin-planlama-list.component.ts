import { Component, OnInit, inject, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { KeycloakService } from 'keycloak-angular';
import { GROUP, LIVE_PLAN_STATUSES, PERMISSIONS, type LivePlanEntry, type LivePlanStatus } from '@bcms/shared';
import { isSkipAuthAllowed } from '../../core/auth/skip-auth';
import type { BcmsTokenParsed } from '../../core/types/auth';
import { YayinPlanlamaService, type LeagueFilterOption } from '../../core/services/yayin-planlama.service';

/**
 * 2026-05-13: Yayın Planlama list, Canlı Yayın Plan kayıtlarını gösterir.
 * Veri kaynağı `GET /api/v1/live-plan` (entry-level; eventKey/schedule şartı
 * yok). EventKey filtresi kaldırıldı; Lig/Hafta filter eklendi.
 *
 * Önceki kontrat: `GET /api/v1/schedules/broadcast` (broadcast-complete row
 * guarantee) — geriye-uyumluluk amacıyla service'te `getList()` korunur
 * (yeni create akışı `/yayin-planlama/new` form için). Bu liste artık
 * `getLivePlanList()` kullanır.
 *
 * Row aksiyonları (Düzenle / Sil) bu iterasyonda **gizli** — önceki shema
 * `Schedule.id` bekliyordu, yeni row tipi `LivePlanEntry`. Aksiyonların
 * canlı yayın plan entry'sine mi yoksa bağlı broadcast schedule'a mı işaret
 * etmesi karar bekleyen tasarım sorusu (raporda detay).
 */

const PAGE_SIZE_DEFAULT = 25;
const STATUS_LABELS: Record<LivePlanStatus, string> = {
  PLANNED:     'Planlandı',
  READY:       'Hazır',
  IN_PROGRESS: 'Devam Ediyor',
  COMPLETED:   'Tamamlandı',
  CANCELLED:   'İptal',
};

@Component({
  selector: 'app-yayin-planlama-list',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink,
    MatTableModule, MatButtonModule, MatIconModule, MatChipsModule,
    MatFormFieldModule, MatInputModule, MatSelectModule, MatPaginatorModule,
    MatTooltipModule, MatDialogModule, MatSnackBarModule, MatProgressSpinnerModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Yayın Planlama</h2>
        @if (canWrite()) {
          <button mat-raised-button color="primary" routerLink="/yayin-planlama/new">
            <mat-icon>add</mat-icon> Yeni
          </button>
        }
      </div>

      <div class="filter-bar">
        <mat-form-field appearance="outline">
          <mat-label>Başlangıç</mat-label>
          <input matInput type="date" name="from" [(ngModel)]="dateFrom" (change)="reload()" />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Bitiş</mat-label>
          <input matInput type="date" name="to" [(ngModel)]="dateTo" (change)="reload()" />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Durum</mat-label>
          <mat-select [(ngModel)]="status" name="status" (selectionChange)="reload()">
            <mat-option [value]="null">(hepsi)</mat-option>
            @for (s of statuses; track s) {
              <mat-option [value]="s">{{ statusLabel(s) }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Lig</mat-label>
          <mat-select [(ngModel)]="leagueId" name="leagueId" (selectionChange)="onLeagueChange()">
            <mat-option [value]="null">Tümü</mat-option>
            @for (lg of leagues(); track lg.id) {
              <mat-option [value]="lg.id">{{ lg.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Hafta</mat-label>
          <mat-select [(ngModel)]="weekNumber" name="weekNumber"
                      [disabled]="leagueId == null"
                      (selectionChange)="reload()">
            <mat-option [value]="null">Tüm Haftalar</mat-option>
            @for (w of weeks(); track w) {
              <mat-option [value]="w">{{ w }}. Hafta</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <button mat-button (click)="reload()">
          <mat-icon>refresh</mat-icon> Yenile
        </button>
      </div>

      @if (loading()) {
        <div class="state state-loading">
          <mat-progress-spinner mode="indeterminate" diameter="32"></mat-progress-spinner>
        </div>
      } @else if (error()) {
        <div class="state state-error">
          <mat-icon>error_outline</mat-icon>
          <span>{{ error() }}</span>
        </div>
      } @else if (rows().length === 0) {
        <div class="state state-empty">
          <mat-icon>event_available</mat-icon>
          <span>Yayın Planlama kaydı bulunamadı.</span>
        </div>
      } @else {
        <table mat-table [dataSource]="rows()" class="yp-table">
          <ng-container matColumnDef="title">
            <th mat-header-cell *matHeaderCellDef>Başlık</th>
            <td mat-cell *matCellDef="let r">{{ r.title }}</td>
          </ng-container>
          <ng-container matColumnDef="teams">
            <th mat-header-cell *matHeaderCellDef>Takım</th>
            <td mat-cell *matCellDef="let r">
              @if (r.team1Name && r.team2Name) {
                {{ r.team1Name }} vs {{ r.team2Name }}
              } @else {
                —
              }
            </td>
          </ng-container>
          <ng-container matColumnDef="league">
            <th mat-header-cell *matHeaderCellDef>Lig</th>
            <td mat-cell *matCellDef="let r">{{ r.leagueName ?? '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="week">
            <th mat-header-cell *matHeaderCellDef>Hafta</th>
            <td mat-cell *matCellDef="let r">{{ r.weekNumber ?? '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="date">
            <th mat-header-cell *matHeaderCellDef>Tarih</th>
            <td mat-cell *matCellDef="let r">{{ formatDate(r.eventStartTime) }}</td>
          </ng-container>
          <ng-container matColumnDef="time">
            <th mat-header-cell *matHeaderCellDef>Saat</th>
            <td mat-cell *matCellDef="let r">{{ formatTime(r.eventStartTime) }}</td>
          </ng-container>
          <ng-container matColumnDef="channels">
            <th mat-header-cell *matHeaderCellDef>Kanallar</th>
            <td mat-cell *matCellDef="let r">{{ countChannels(r) }}</td>
          </ng-container>
          <ng-container matColumnDef="status">
            <th mat-header-cell *matHeaderCellDef>Durum</th>
            <td mat-cell *matCellDef="let r"><mat-chip>{{ statusLabel(r.status) }}</mat-chip></td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="cols"></tr>
          <tr mat-row *matRowDef="let row; columns: cols;"></tr>
        </table>
        <mat-paginator
          [length]="total()"
          [pageSize]="pageSize()"
          [pageIndex]="page() - 1"
          [pageSizeOptions]="[10, 25, 50, 100]"
          (page)="onPage($event)">
        </mat-paginator>
      }
    </div>
  `,
  styles: [`
    .page { padding: 24px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .page-header h2 { margin: 0; font-size: 20px; font-weight: 600; }
    .filter-bar { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 16px; }
    .yp-table { width: 100%; }
    .state { display: flex; align-items: center; gap: 12px; padding: 48px; justify-content: center; color: var(--mat-sys-on-surface-variant); }
    .state-error { color: var(--mat-sys-error); }
  `],
})
export class YayinPlanlamaListComponent implements OnInit {
  private router  = inject(Router);
  private dialog  = inject(MatDialog);
  private snack   = inject(MatSnackBar);
  private service = inject(YayinPlanlamaService);
  private keycloak = inject(KeycloakService, { optional: true });

  protected cols = ['title', 'teams', 'league', 'week', 'date', 'time', 'channels', 'status'];
  protected statuses = LIVE_PLAN_STATUSES;

  // Filter state
  protected dateFrom   = '';
  protected dateTo     = '';
  protected status:     LivePlanStatus | null = null;
  protected leagueId:   number | null = null;
  protected weekNumber: number | null = null;

  // Filter dropdown options
  protected leagues = signal<LeagueFilterOption[]>([]);
  protected weeks   = signal<number[]>([]);

  // Page state
  protected rows     = signal<LivePlanEntry[]>([]);
  protected total    = signal(0);
  protected page     = signal(1);
  protected pageSize = signal(PAGE_SIZE_DEFAULT);
  protected loading  = signal(false);
  protected error    = signal<string | null>(null);

  protected canWrite = computed<boolean>(() => this.hasGroup(PERMISSIONS.schedules.write));

  ngOnInit(): void {
    this.loadLeagues();
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    // `from/to` UI'dan YYYY-MM-DD geliyor; backend `from/to` ISO datetime
    // bekliyor — gün başlangıcı/sonu olarak compose.
    const fromIso = this.dateFrom ? `${this.dateFrom}T00:00:00.000Z` : undefined;
    const toIso   = this.dateTo   ? `${this.dateTo}T23:59:59.999Z`   : undefined;
    this.service.getLivePlanList({
      from:       fromIso,
      to:         toIso,
      status:     this.status     ?? undefined,
      leagueId:   this.leagueId   ?? undefined,
      weekNumber: this.weekNumber ?? undefined,
      page:       this.page(),
      pageSize:   this.pageSize(),
    }).subscribe({
      next: (res) => {
        this.rows.set(res.items);
        this.total.set(res.total);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message ?? 'Liste yüklenemedi.');
        this.loading.set(false);
      },
    });
  }

  onLeagueChange(): void {
    // Lig değişti → weekNumber resetlensin ve hafta options yeniden yüklensin.
    this.weekNumber = null;
    this.loadWeeks(this.leagueId ?? undefined);
    this.reload();
  }

  private loadLeagues(): void {
    this.service.getLeagueFilterOptions().subscribe({
      next: (items) => this.leagues.set(items),
      error: () => this.leagues.set([]),
    });
  }

  private loadWeeks(leagueId?: number): void {
    if (leagueId === undefined) { this.weeks.set([]); return; }
    this.service.getWeekFilterOptions(leagueId).subscribe({
      next: (items) => this.weeks.set(items),
      error: () => this.weeks.set([]),
    });
  }

  onPage(ev: PageEvent): void {
    this.page.set(ev.pageIndex + 1);
    this.pageSize.set(ev.pageSize);
    this.reload();
  }

  protected formatDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    return iso.slice(0, 10);
  }

  protected formatTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const m = /T(\d{2}:\d{2})/.exec(iso);
    return m?.[1] ?? '—';
  }

  protected countChannels(row: LivePlanEntry): number {
    return [row.channel1Id, row.channel2Id, row.channel3Id].filter((v) => v != null).length;
  }

  protected statusLabel(s: LivePlanStatus): string {
    return STATUS_LABELS[s] ?? s;
  }

  private hasGroup(allowed: readonly string[]): boolean {
    if (allowed.length === 0) return true;
    if (isSkipAuthAllowed()) return true;
    const groups = (this.keycloak?.getKeycloakInstance()?.tokenParsed as BcmsTokenParsed | undefined)?.groups ?? [];
    if (groups.includes(GROUP.Admin)) return true;
    return groups.some((g) => allowed.includes(g));
  }
}
