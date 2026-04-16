import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatCardModule } from '@angular/material/card';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';

import { ScheduleService } from '../../../core/services/schedule.service';
import { ApiService } from '../../../core/services/api.service';
import type { Schedule } from '@bcms/shared';

interface ImportResult {
  title:   string;
  created: number;
  skipped: number;
  errors:  { row: number; reason: string }[];
}

@Component({
  selector: 'app-schedule-list',
  standalone: true,
  imports: [
    CommonModule, RouterLink, FormsModule,
    MatTableModule, MatButtonModule, MatIconModule,
    MatInputModule, MatSelectModule, MatFormFieldModule,
    MatPaginatorModule, MatProgressSpinnerModule, MatChipsModule, MatCardModule,
    MatSnackBarModule, MatTooltipModule, MatExpansionModule,
  ],
  template: `
    <div class="page-container">
      <div class="page-header">
        <h1>Yayın Planı</h1>
        <div class="header-actions">
          <!-- Import -->
          <input #fileInput type="file" accept=".xlsx,.xls"
                 style="display:none" (change)="onFileSelected($event)" />
          <button mat-stroked-button [disabled]="importing()"
                  matTooltip="Excel'den program yükle"
                  (click)="fileInput.click()">
            <mat-icon>upload_file</mat-icon>
            {{ importing() ? 'Yükleniyor…' : 'Excel İçe Aktar' }}
          </button>
          <!-- Export -->
          <button mat-stroked-button [disabled]="exporting()"
                  matTooltip="Listeyi Excel olarak indir"
                  (click)="exportExcel()">
            <mat-icon>download</mat-icon>
            {{ exporting() ? 'Hazırlanıyor…' : 'Excel Dışa Aktar' }}
          </button>
          <a mat-raised-button color="primary" routerLink="new">
            <mat-icon>add</mat-icon> Yeni Program
          </a>
        </div>
      </div>

      <!-- Import Sonucu -->
      @if (importResult()) {
        <mat-expansion-panel class="import-result-panel" [expanded]="true">
          <mat-expansion-panel-header>
            <mat-panel-title>
              <mat-icon>summarize</mat-icon>&nbsp;
              İçe Aktarma Sonucu — {{ importResult()!.title }}
            </mat-panel-title>
          </mat-expansion-panel-header>
          <div class="import-summary">
            <span class="chip ok">✓ {{ importResult()!.created }} oluşturuldu</span>
            <span class="chip skip">⊘ {{ importResult()!.skipped }} atlandı</span>
            @if (importResult()!.errors.length > 0) {
              <span class="chip err">✗ {{ importResult()!.errors.length }} hata</span>
            }
          </div>
          @if (importResult()!.errors.length > 0) {
            <div class="import-errors">
              @for (e of importResult()!.errors; track e.row) {
                <div class="import-err-row">
                  <span class="err-row">Satır {{ e.row }}</span>
                  <span>{{ e.reason }}</span>
                </div>
              }
            </div>
          }
        </mat-expansion-panel>
      }

      <!-- Filters -->
      <mat-card class="filter-card">
        <mat-card-content>
          <div class="filters-row">
            <mat-form-field>
              <mat-label>Başlangıç</mat-label>
              <input matInput type="datetime-local" [(ngModel)]="filter.from" (change)="onFilter()">
            </mat-form-field>
            <mat-form-field>
              <mat-label>Bitiş</mat-label>
              <input matInput type="datetime-local" [(ngModel)]="filter.to" (change)="onFilter()">
            </mat-form-field>
            <mat-form-field>
              <mat-label>Durum</mat-label>
              <mat-select [(ngModel)]="filter.status" (selectionChange)="onFilter()">
                <mat-option value="">Tümü</mat-option>
                <mat-option value="DRAFT">Taslak</mat-option>
                <mat-option value="CONFIRMED">Onaylandı</mat-option>
                <mat-option value="ON_AIR">Yayında</mat-option>
                <mat-option value="COMPLETED">Tamamlandı</mat-option>
                <mat-option value="CANCELLED">İptal</mat-option>
              </mat-select>
            </mat-form-field>
            <button mat-stroked-button (click)="clearFilter()">
              <mat-icon>clear</mat-icon> Temizle
            </button>
          </div>
        </mat-card-content>
      </mat-card>

      <!-- Table -->
      @if (loading()) {
        <div class="spinner-container">
          <mat-spinner diameter="48"></mat-spinner>
        </div>
      } @else {
        <mat-table [dataSource]="schedules()" class="schedule-table">
          <ng-container matColumnDef="startTime">
            <mat-header-cell *matHeaderCellDef>Başlangıç</mat-header-cell>
            <mat-cell *matCellDef="let s">{{ s.startTime | date:'dd.MM.yyyy HH:mm' }}</mat-cell>
          </ng-container>

          <ng-container matColumnDef="endTime">
            <mat-header-cell *matHeaderCellDef>Bitiş</mat-header-cell>
            <mat-cell *matCellDef="let s">{{ s.endTime | date:'HH:mm' }}</mat-cell>
          </ng-container>

          <ng-container matColumnDef="channel">
            <mat-header-cell *matHeaderCellDef>Kanal</mat-header-cell>
            <mat-cell *matCellDef="let s">{{ s.channel?.name ?? '—' }}</mat-cell>
          </ng-container>

          <ng-container matColumnDef="title">
            <mat-header-cell *matHeaderCellDef>Başlık</mat-header-cell>
            <mat-cell *matCellDef="let s">{{ s.title }}</mat-cell>
          </ng-container>

          <ng-container matColumnDef="status">
            <mat-header-cell *matHeaderCellDef>Durum</mat-header-cell>
            <mat-cell *matCellDef="let s">
              <span [class]="'status-badge ' + s.status">{{ statusLabel(s.status) }}</span>
            </mat-cell>
          </ng-container>

          <ng-container matColumnDef="actions">
            <mat-header-cell *matHeaderCellDef></mat-header-cell>
            <mat-cell *matCellDef="let s">
              <a mat-icon-button [routerLink]="[s.id]" matTooltip="Detay">
                <mat-icon>visibility</mat-icon>
              </a>
              <a mat-icon-button [routerLink]="[s.id, 'edit']" matTooltip="Düzenle">
                <mat-icon>edit</mat-icon>
              </a>
            </mat-cell>
          </ng-container>

          <mat-header-row *matHeaderRowDef="columns"></mat-header-row>
          <mat-row *matRowDef="let row; columns: columns"></mat-row>
          <tr class="mat-row" *matNoDataRow>
            <td class="mat-cell no-data" [attr.colspan]="columns.length">Kayıt bulunamadı</td>
          </tr>
        </mat-table>

        <mat-paginator
          [length]="total()"
          [pageSize]="pageSize"
          [pageSizeOptions]="[20, 50, 100]"
          (page)="onPage($event)">
        </mat-paginator>
      }
    </div>
  `,
  styles: [`
    .page-header    { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
    .header-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .filter-card    { margin-bottom:16px; }
    .filters-row    { display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
    .filters-row mat-form-field { min-width:180px; }
    .schedule-table { width:100%; }
    .spinner-container { display:flex; justify-content:center; padding:48px; }
    .no-data { padding:24px; text-align:center; color:#777; }

    .import-result-panel { margin-bottom:16px; }
    .import-summary { display:flex; gap:12px; flex-wrap:wrap; padding:8px 0; }
    .chip       { padding:4px 12px; border-radius:12px; font-size:0.82rem; font-weight:600; }
    .chip.ok    { background:rgba(76,175,80,0.2);  color:#81c784; }
    .chip.skip  { background:rgba(158,158,158,0.2); color:#bdbdbd; }
    .chip.err   { background:rgba(244,67,54,0.2);  color:#e57373; }
    .import-errors   { margin-top:8px; display:flex; flex-direction:column; gap:4px; }
    .import-err-row  { display:flex; gap:12px; font-size:0.83rem; padding:4px 8px;
                       background:rgba(244,67,54,0.08); border-radius:4px; }
    .err-row    { font-weight:600; min-width:60px; color:#e57373; }

    .status-badge { padding:2px 8px; border-radius:10px; font-size:0.75rem; font-weight:600; }
    .status-badge.DRAFT     { background:#37474f; color:#cfd8dc; }
    .status-badge.CONFIRMED { background:#1565c0; color:#fff; }
    .status-badge.ON_AIR    { background:#b71c1c; color:#fff; }
    .status-badge.COMPLETED { background:#2e7d32; color:#fff; }
    .status-badge.CANCELLED { background:#424242; color:#9e9e9e; }
  `],
})
export class ScheduleListComponent implements OnInit {
  columns = ['startTime', 'endTime', 'channel', 'title', 'status', 'actions'];

  schedules    = signal<Schedule[]>([]);
  total        = signal(0);
  loading      = signal(false);
  importing    = signal(false);
  exporting    = signal(false);
  importResult = signal<ImportResult | null>(null);

  pageSize = 50;
  page     = 1;

  filter: { from?: string; to?: string; status?: string } = {};

  constructor(
    private scheduleSvc: ScheduleService,
    private api: ApiService,
    private snack: MatSnackBar,
  ) {}

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    this.scheduleSvc
      .getSchedules({ ...this.filter, page: this.page, pageSize: this.pageSize })
      .subscribe({
        next: (res) => {
          this.schedules.set(res.data);
          this.total.set(res.total);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  // ── Excel İçe Aktar ────────────────────────────────────────────────────────
  onFileSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    this.importing.set(true);
    this.importResult.set(null);

    const fd = new FormData();
    fd.append('file', file);

    this.api.postFile<ImportResult>('/schedules/import', fd).subscribe({
      next: (res) => {
        this.importResult.set(res);
        this.importing.set(false);
        this.snack.open(
          `İçe aktarma tamamlandı: ${res.created} oluşturuldu, ${res.errors.length} hata`,
          'Kapat', { duration: 5000 },
        );
        this.load();
        // Input'u sıfırla (aynı dosyayı tekrar seçmeye izin ver)
        (event.target as HTMLInputElement).value = '';
      },
      error: (err) => {
        this.importing.set(false);
        this.snack.open(`Hata: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }

  // ── Excel Dışa Aktar ───────────────────────────────────────────────────────
  exportExcel() {
    this.exporting.set(true);

    const params: Record<string, string> = {};
    if (this.filter.from) params['from'] = new Date(this.filter.from).toISOString();
    if (this.filter.to)   params['to']   = new Date(this.filter.to).toISOString();

    this.api.getBlob('/schedules/export', params).subscribe({
      next: (blob) => {
        const url      = URL.createObjectURL(blob);
        const anchor   = document.createElement('a');
        anchor.href    = url;
        anchor.download = `plan_${new Date().toISOString().slice(0, 10)}.xlsx`;
        anchor.click();
        URL.revokeObjectURL(url);
        this.exporting.set(false);
      },
      error: (err) => {
        this.exporting.set(false);
        this.snack.open(`İndirme hatası: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }

  onFilter() { this.page = 1; this.load(); }
  clearFilter() { this.filter = {}; this.onFilter(); }

  onPage(e: PageEvent) {
    this.page     = e.pageIndex + 1;
    this.pageSize = e.pageSize;
    this.load();
  }

  statusLabel(s: string): string {
    const map: Record<string, string> = {
      DRAFT: 'Taslak', CONFIRMED: 'Onaylandı', ON_AIR: 'Yayında',
      COMPLETED: 'Tamamlandı', CANCELLED: 'İptal',
    };
    return map[s] ?? s;
  }
}
