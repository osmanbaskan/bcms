import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { HttpErrorResponse } from '@angular/common/http';

import {
  ScheduleService,
  type ManualLeagueAdminRow,
} from '../../../core/services/schedule.service';

const SPORT_GROUP_LABELS: Record<string, string> = {
  football: 'Futbol', tennis: 'Tenis', formula1: 'Formula 1',
  motogp: 'MotoGP', basketball: 'Basketbol', rugby: 'Rugby',
};

/**
 * 2026-05-15: Manuel Lig Yönetimi.
 *
 * Route: /admin/manual-leagues (yetki: GROUP.SystemEng + Admin auto-bypass —
 * OPTA Lig Görünürlüğü ekranıyla birebir aynı).
 *
 * Tablo: Kod | Ad | Ülke | Spor | Takım Sayısı | Manuel Seçim (toggle) | Kaydet.
 * Toggle/dirty pattern OPTA admin component ile aynı; teamCount=0 olan
 * satırlarda toggle yine kullanılabilir ama "Takım eklenmedikçe dropdown'da
 * görünmez" uyarısı tooltip ile sunulur (backend filter aynı).
 *
 * Cache: save sonrası /matches stale invalidate edilir (ScheduleService
 * içinde) → Canlı Yayın Plan Yeni Ekle modal tetik anında güncel.
 */
interface RowState extends ManualLeagueAdminRow {
  draftManualSelectable: boolean;
  saving:                boolean;
}

@Component({
  selector: 'app-admin-manual-leagues',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatCardModule, MatTableModule, MatButtonModule, MatIconModule,
    MatSlideToggleModule, MatTooltipModule,
    MatProgressSpinnerModule, MatSnackBarModule,
  ],
  template: `
    <div class="page">
      <h1 class="page-title">Manuel Lig Yönetimi</h1>
      <p class="hint">
        Canlı Yayın Plan → "Yeni Ekle / Manuel Giriş" → "Lig (opsiyonel)"
        dropdown'unda sadece <b>Manuel Seçim</b> aktif olan ligler görünür.
        Yeni eklenen ligler default kapalıdır. Bu ekran OPTA fixture
        görünürlüğünden bağımsızdır.
      </p>

      @if (loading()) {
        <div class="state"><mat-spinner diameter="36"></mat-spinner></div>
      } @else if (error()) {
        <div class="state state-error">
          <mat-icon>error_outline</mat-icon>
          <span>{{ error() }}</span>
          <button mat-stroked-button (click)="reload()">
            <mat-icon>refresh</mat-icon> Tekrar dene
          </button>
        </div>
      } @else {
        <mat-card class="card">
          <table mat-table [dataSource]="rows()" class="comp-table">
            <ng-container matColumnDef="code">
              <th mat-header-cell *matHeaderCellDef>Kod</th>
              <td mat-cell *matCellDef="let r" class="cell-code">{{ r.code }}</td>
            </ng-container>
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef>Ad</th>
              <td mat-cell *matCellDef="let r">{{ r.name }}</td>
            </ng-container>
            <ng-container matColumnDef="country">
              <th mat-header-cell *matHeaderCellDef>Ülke</th>
              <td mat-cell *matCellDef="let r">{{ r.country || '—' }}</td>
            </ng-container>
            <ng-container matColumnDef="sportGroup">
              <th mat-header-cell *matHeaderCellDef>Spor</th>
              <td mat-cell *matCellDef="let r">{{ sportGroupLabel(r.sportGroup) }}</td>
            </ng-container>
            <ng-container matColumnDef="teamCount">
              <th mat-header-cell *matHeaderCellDef>Takım Sayısı</th>
              <td mat-cell *matCellDef="let r" class="cell-team-count">
                <span [class.zero]="r.teamCount === 0">{{ r.teamCount }}</span>
                @if (r.teamCount === 0) {
                  <mat-icon class="warn-icon"
                            matTooltip="Takım eklenmedikçe dropdown'da görünmez">
                    info
                  </mat-icon>
                }
              </td>
            </ng-container>
            <ng-container matColumnDef="manualSelectable">
              <th mat-header-cell *matHeaderCellDef>Manuel Seçim</th>
              <td mat-cell *matCellDef="let r">
                <mat-slide-toggle
                  [(ngModel)]="r.draftManualSelectable"
                  [disabled]="r.saving">
                </mat-slide-toggle>
              </td>
            </ng-container>
            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let r" class="cell-actions">
                <button mat-stroked-button
                        [disabled]="!isDirty(r) || r.saving"
                        (click)="save(r)">
                  @if (r.saving) {
                    <mat-spinner diameter="16"></mat-spinner>
                  } @else {
                    <mat-icon>save</mat-icon>
                  }
                  Kaydet
                </button>
              </td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="cols"></tr>
            <tr mat-row *matRowDef="let row; columns: cols;"></tr>
          </table>
        </mat-card>
      }
    </div>
  `,
  styles: [`
    .page { padding: 24px; max-width: 1100px; margin: 0 auto; }
    .page-title { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
    .hint { color: var(--mat-sys-on-surface-variant); font-size: 13px; margin: 0 0 16px; }
    .card { padding: 0; }
    .comp-table { width: 100%; }
    .cell-code { font-family: monospace; font-size: 12px; }
    .cell-actions { text-align: right; }
    .cell-team-count { display: flex; align-items: center; gap: 6px; }
    .cell-team-count .zero { color: var(--mat-sys-error); }
    .warn-icon { font-size: 18px; width: 18px; height: 18px; color: var(--mat-sys-on-surface-variant); }
    .state { display: flex; align-items: center; gap: 12px; padding: 48px; justify-content: center; color: var(--mat-sys-on-surface-variant); }
    .state-error { color: var(--mat-sys-error); }
  `],
})
export class ManualLeaguesComponent implements OnInit {
  private service = inject(ScheduleService);
  private snack   = inject(MatSnackBar);

  protected cols = ['code', 'name', 'country', 'sportGroup', 'teamCount', 'manualSelectable', 'actions'];
  protected sportGroupLabel(g: string): string {
    return SPORT_GROUP_LABELS[g] ?? g;
  }
  protected rows    = signal<RowState[]>([]);
  protected loading = signal(false);
  protected error   = signal<string | null>(null);

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.service.getManualLeagueAdminRows().subscribe({
      next: (items) => {
        this.rows.set(items.map((i) => this.toRowState(i)));
        this.loading.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.error.set(err?.error?.message ?? 'Lig listesi yüklenemedi.');
        this.loading.set(false);
      },
    });
  }

  protected isDirty(r: RowState): boolean {
    return r.draftManualSelectable !== r.manualSelectable;
  }

  protected save(r: RowState): void {
    if (!this.isDirty(r) || r.saving) return;
    r.saving = true;
    this.service.updateManualLeagueSelectable(r.id, r.draftManualSelectable).subscribe({
      next: (updated) => {
        this.rows.update((rows) => rows.map((x) =>
          x.id === r.id ? this.toRowState(updated) : x,
        ));
        this.snack.open(`"${updated.name}" güncellendi.`, 'Kapat', { duration: 2000 });
      },
      error: (err: HttpErrorResponse) => {
        r.saving = false;
        const msg = err?.error?.message ?? 'Güncellenemedi.';
        this.snack.open(msg, 'Kapat', { duration: 4000 });
      },
    });
  }

  private toRowState(i: ManualLeagueAdminRow): RowState {
    return {
      ...i,
      draftManualSelectable: i.manualSelectable,
      saving:                false,
    };
  }
}
