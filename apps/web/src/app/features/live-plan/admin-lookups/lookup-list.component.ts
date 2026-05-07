import { Component, Input, OnChanges, SimpleChanges, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ApiService } from '../../../core/services/api.service';
import {
  type LookupDefinition,
  type LookupRow,
  type LookupListResponse,
  lookupEndpoint,
} from './lookup.types';
import {
  LookupFormDialogComponent,
  type LookupFormDialogData,
} from './lookup-form-dialog.component';
import {
  ConfirmDialogComponent,
  type ConfirmDialogData,
} from './confirm-dialog.component';

@Component({
  selector: 'app-lookup-list',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatTableModule, MatButtonModule, MatIconModule, MatChipsModule,
    MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatSlideToggleModule, MatSnackBarModule, MatTooltipModule,
    MatProgressSpinnerModule,
  ],
  template: `
    @if (!definition) {
      <div class="empty">Sol panelden bir lookup tipi seçin.</div>
    } @else {
      <div class="header">
        <div class="title">
          <h3>{{ definition.label }}</h3>
          <span class="meta">{{ rows().length }} kayıt</span>
        </div>
        <div class="actions">
          @if (definition.polymorphic) {
            <mat-form-field appearance="outline" class="filter-field">
              <mat-label>Tip filtresi</mat-label>
              <mat-select [(ngModel)]="typeFilter" (ngModelChange)="onFilterChange()">
                <mat-option [value]="''">Hepsi</mat-option>
                @for (t of definition.allowedTypes ?? []; track t) {
                  <mat-option [value]="t">{{ t }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          }
          @if (canWrite) {
            <mat-slide-toggle
              [(ngModel)]="includeDeleted"
              (ngModelChange)="onFilterChange()"
              matTooltip="Silinmiş kayıtları da göster">
              Silinenler
            </mat-slide-toggle>
            <button mat-raised-button color="primary" (click)="openCreate()">
              <mat-icon>add</mat-icon> Yeni
            </button>
          }
        </div>
      </div>

      @if (loading()) {
        <div class="loading"><mat-spinner diameter="36"></mat-spinner></div>
      } @else {
        <table mat-table [dataSource]="rows()" class="lookup-table">
          <ng-container matColumnDef="label">
            <th mat-header-cell *matHeaderCellDef>Etiket</th>
            <td mat-cell *matCellDef="let r" [class.deleted]="r.deletedAt">{{ r.label }}</td>
          </ng-container>

          @if (definition.polymorphic) {
            <ng-container matColumnDef="type">
              <th mat-header-cell *matHeaderCellDef>Tip</th>
              <td mat-cell *matCellDef="let r">
                <mat-chip>{{ r.type }}</mat-chip>
              </td>
            </ng-container>
          }

          <ng-container matColumnDef="active">
            <th mat-header-cell *matHeaderCellDef>Durum</th>
            <td mat-cell *matCellDef="let r">
              @if (r.deletedAt) {
                <span class="status del">silindi</span>
              } @else if (r.active) {
                <span class="status on">aktif</span>
              } @else {
                <span class="status off">pasif</span>
              }
            </td>
          </ng-container>

          <ng-container matColumnDef="sortOrder">
            <th mat-header-cell *matHeaderCellDef>Sıra</th>
            <td mat-cell *matCellDef="let r">{{ r.sortOrder }}</td>
          </ng-container>

          <ng-container matColumnDef="actions">
            <th mat-header-cell *matHeaderCellDef></th>
            <td mat-cell *matCellDef="let r">
              @if (canWrite && !r.deletedAt) {
                <button mat-icon-button matTooltip="Düzenle" (click)="openEdit(r)">
                  <mat-icon>edit</mat-icon>
                </button>
              }
              @if (canDelete && !r.deletedAt) {
                <button mat-icon-button matTooltip="Sil" (click)="softDelete(r)">
                  <mat-icon>delete_outline</mat-icon>
                </button>
              }
              @if (canWrite && r.deletedAt) {
                <button mat-icon-button matTooltip="Geri al" (click)="restore(r)">
                  <mat-icon>restore</mat-icon>
                </button>
              }
            </td>
          </ng-container>

          <tr mat-header-row *matHeaderRowDef="cols()"></tr>
          <tr mat-row *matRowDef="let row; columns: cols();"
              [class.deleted-row]="row.deletedAt"></tr>
        </table>

        @if (rows().length === 0) {
          <div class="empty">Bu kategoride kayıt yok.</div>
        }
      }
    }
  `,
  styles: [`
    .header { display:flex; align-items:center; justify-content:space-between; padding:16px 8px; gap:16px; flex-wrap:wrap; }
    .title h3 { margin:0; font-size:18px; font-weight:500; }
    .title .meta { font-size:12px; color:#888; margin-left:8px; }
    .actions { display:flex; align-items:center; gap:12px; }
    .filter-field { width:180px; }
    .lookup-table { width:100%; }
    .loading { display:flex; justify-content:center; padding:40px; }
    .empty { padding:40px; text-align:center; color:#888; font-size:14px; }
    .status { font-size:11px; padding:2px 10px; border-radius:10px; font-weight:600; }
    .status.on  { background:#1b5e20; color:#fff; }
    .status.off { background:#37474f; color:#cfd8dc; }
    .status.del { background:#b71c1c; color:#fff; }
    .deleted-row { opacity:.55; }
    .deleted { text-decoration:line-through; }
  `],
})
export class LookupListComponent implements OnChanges {
  @Input() definition?: LookupDefinition;
  @Input() canWrite  = false;
  @Input() canDelete = false;

  private api    = inject(ApiService);
  private dialog = inject(MatDialog);
  private snack  = inject(MatSnackBar);

  rows           = signal<LookupRow[]>([]);
  loading        = signal(false);
  typeFilter     = '';
  includeDeleted = false;

  cols(): string[] {
    const base = ['label'];
    if (this.definition?.polymorphic) base.push('type');
    base.push('active', 'sortOrder', 'actions');
    return base;
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['definition']) {
      this.typeFilter     = '';
      this.includeDeleted = false;
      this.load();
    }
  }

  onFilterChange() {
    this.load();
  }

  load() {
    if (!this.definition) {
      this.rows.set([]);
      return;
    }
    this.loading.set(true);
    const params: Record<string, string | number | boolean> = {
      activeOnly:     false,
      includeDeleted: this.canWrite && this.includeDeleted,
      pageSize:       500,
    };
    if (this.definition.polymorphic && this.typeFilter) {
      params['type'] = this.typeFilter;
    }
    this.api.get<LookupListResponse>(lookupEndpoint.list(this.definition.type), params).subscribe({
      next: (res) => {
        this.rows.set(res.items ?? []);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.rows.set([]);
        this.snack.open('Liste yüklenemedi', 'Kapat', { duration: 4000 });
      },
    });
  }

  openCreate() {
    if (!this.definition) return;
    const data: LookupFormDialogData = { definition: this.definition };
    this.dialog.open(LookupFormDialogComponent, { data, width: '440px' })
      .afterClosed().subscribe((ok) => {
        if (ok) { this.snack.open('Kayıt oluşturuldu', 'Kapat', { duration: 2500 }); this.load(); }
      });
  }

  openEdit(row: LookupRow) {
    if (!this.definition) return;
    const data: LookupFormDialogData = { definition: this.definition, row };
    this.dialog.open(LookupFormDialogComponent, { data, width: '440px' })
      .afterClosed().subscribe((ok) => {
        if (ok) { this.snack.open('Güncellendi', 'Kapat', { duration: 2500 }); this.load(); }
      });
  }

  softDelete(row: LookupRow) {
    if (!this.definition) return;
    const data: ConfirmDialogData = {
      title:        'Kaydı Sil',
      message:      `"${row.label}" kaydı silinsin mi?`,
      confirmText:  'Sil',
      confirmColor: 'warn',
    };
    this.dialog.open(ConfirmDialogComponent, { data, width: '380px' })
      .afterClosed().subscribe((ok: boolean | undefined) => {
        if (!ok || !this.definition) return;
        this.api.delete(lookupEndpoint.detail(this.definition.type, row.id)).subscribe({
          next: () => { this.snack.open('Silindi', 'Kapat', { duration: 2500 }); this.load(); },
          error: (err: { status?: number; error?: { message?: string } }) => {
            this.snack.open(err?.error?.message ?? 'Silme başarısız', 'Kapat', { duration: 4000 });
          },
        });
      });
  }

  restore(row: LookupRow) {
    if (!this.definition) return;
    const data: ConfirmDialogData = {
      title:        'Kaydı Geri Al',
      message:      `"${row.label}" kaydı tekrar listeye alınsın mı? (silindi durumu kaldırılır, durum pasif kalır.)`,
      confirmText:  'Geri Al',
      confirmColor: 'primary',
    };
    this.dialog.open(ConfirmDialogComponent, { data, width: '380px' })
      .afterClosed().subscribe((ok: boolean | undefined) => {
        if (!ok || !this.definition) return;
        this.api.patch(lookupEndpoint.detail(this.definition.type, row.id), { deletedAt: null }).subscribe({
          next: () => { this.snack.open('Geri alındı', 'Kapat', { duration: 2500 }); this.load(); },
          error: (err: { status?: number; error?: { message?: string } }) => {
            this.snack.open(err?.error?.message ?? 'İşlem başarısız', 'Kapat', { duration: 4000 });
          },
        });
      });
  }
}
