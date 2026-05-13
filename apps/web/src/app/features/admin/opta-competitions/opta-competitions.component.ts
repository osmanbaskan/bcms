import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { HttpErrorResponse } from '@angular/common/http';

import { MatSelectModule } from '@angular/material/select';

import {
  OptaAdminService,
  type OptaCompetitionAdminItem,
  type OptaSportGroup,
} from '../../../core/services/opta-admin.service';

const SPORT_GROUP_LABELS: Record<OptaSportGroup, string> = {
  football: 'Futbol', tennis: 'Tenis', formula1: 'Formula 1',
  motogp: 'MotoGP', basketball: 'Basketbol', rugby: 'Rugby',
};
const SPORT_GROUP_OPTIONS: OptaSportGroup[] = [
  'football','tennis','formula1','motogp','basketball','rugby',
];

/**
 * 2026-05-13: OPTA lig/turnuva görünürlük yönetimi.
 *
 * Route: /admin/opta-competitions (Admin/SystemEng).
 * Tablo: Kod | Ad | Ülke | Görünür (slide-toggle) | Sıra (input) | Kaydet.
 *
 * Toggle/sıra değişimi `dirty` flag set eder; satır bazlı "Kaydet" butonu
 * `PATCH /opta/competitions/admin/:id` çağırır. Mevcut /opta cache
 * invalidate edilir → Canlı Yayın Plan "Yeni Ekle" dialog'u tetik anında
 * güncel ligleri görür.
 */
interface RowState extends OptaCompetitionAdminItem {
  /** Edit anlık değer (canlı) — orijinalden farklıysa dirty=true. */
  draftVisible:    boolean;
  draftSortOrder:  number;
  draftSportGroup: OptaSportGroup;
  saving:          boolean;
}

@Component({
  selector: 'app-admin-opta-competitions',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatCardModule, MatTableModule, MatButtonModule, MatIconModule,
    MatSlideToggleModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatProgressSpinnerModule, MatSnackBarModule,
  ],
  template: `
    <div class="page">
      <h1 class="page-title">OPTA Lig / Turnuva Görünürlüğü</h1>
      <p class="hint">
        Canlı Yayın Plan → "Yeni Ekle" dropdown'unda sadece <b>Görünür</b>
        işaretli ligler gözükür. Yeni eklenen ligler default olarak gizlidir.
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
              <td mat-cell *matCellDef="let r">{{ r.country }}</td>
            </ng-container>
            <ng-container matColumnDef="sportGroup">
              <th mat-header-cell *matHeaderCellDef>Spor</th>
              <td mat-cell *matCellDef="let r">
                <mat-form-field appearance="outline" subscriptSizing="dynamic" class="sport-select">
                  <mat-select [(ngModel)]="r.draftSportGroup" [disabled]="r.saving">
                    @for (g of sportGroupOptions; track g) {
                      <mat-option [value]="g">{{ sportGroupLabel(g) }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
              </td>
            </ng-container>
            <ng-container matColumnDef="visible">
              <th mat-header-cell *matHeaderCellDef>Görünür</th>
              <td mat-cell *matCellDef="let r">
                <mat-slide-toggle
                  [(ngModel)]="r.draftVisible"
                  [disabled]="r.saving">
                </mat-slide-toggle>
              </td>
            </ng-container>
            <ng-container matColumnDef="sortOrder">
              <th mat-header-cell *matHeaderCellDef>Sıra</th>
              <td mat-cell *matCellDef="let r">
                <input type="number"
                       class="sort-input"
                       min="0"
                       [(ngModel)]="r.draftSortOrder"
                       [disabled]="r.saving" />
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
    .sort-input {
      width: 70px; padding: 4px 6px;
      border: 1px solid rgba(0,0,0,0.2); border-radius: 4px;
      background: transparent; color: inherit; font: inherit;
    }
    .sport-select { width: 120px; }
    .sport-select ::ng-deep .mat-mdc-form-field-infix { padding: 4px 0; min-height: 28px; }
    .sort-input:focus { outline: 2px solid var(--mat-sys-primary); outline-offset: -1px; }
    .sort-input:disabled { opacity: 0.5; }
    .state { display: flex; align-items: center; gap: 12px; padding: 48px; justify-content: center; color: var(--mat-sys-on-surface-variant); }
    .state-error { color: var(--mat-sys-error); }
  `],
})
export class OptaCompetitionsComponent implements OnInit {
  private service = inject(OptaAdminService);
  private snack   = inject(MatSnackBar);

  protected cols = ['code', 'name', 'country', 'sportGroup', 'visible', 'sortOrder', 'actions'];
  protected readonly sportGroupOptions = SPORT_GROUP_OPTIONS;
  protected sportGroupLabel(g: OptaSportGroup): string {
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
    this.service.getCompetitionAdminList().subscribe({
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
    return r.draftVisible !== r.visible
        || r.draftSortOrder !== r.sortOrder
        || r.draftSportGroup !== r.sportGroup;
  }

  protected save(r: RowState): void {
    if (!this.isDirty(r) || r.saving) return;
    r.saving = true;
    const dto: { visible?: boolean; sortOrder?: number; sportGroup?: OptaSportGroup } = {};
    if (r.draftVisible !== r.visible)         dto.visible    = r.draftVisible;
    if (r.draftSortOrder !== r.sortOrder)     dto.sortOrder  = r.draftSortOrder;
    if (r.draftSportGroup !== r.sportGroup)   dto.sportGroup = r.draftSportGroup;

    this.service.updateCompetitionAdmin(r.id, dto).subscribe({
      next: (updated) => {
        // Row in-place update (signal trigger).
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

  private toRowState(i: OptaCompetitionAdminItem): RowState {
    return {
      ...i,
      draftVisible:    i.visible,
      draftSortOrder:  i.sortOrder,
      draftSportGroup: i.sportGroup,
      saving:          false,
    };
  }
}
