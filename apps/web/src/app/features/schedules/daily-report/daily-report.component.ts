import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { ApiService } from '../../../core/services/api.service';
import type { Schedule } from '@bcms/shared';

interface Channel { id: number; name: string; type: string; }

interface ReportRow {
  schedule: Schedule;
  durationMin: number;
}

@Component({
  selector: 'app-daily-report',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatCardModule, MatTableModule, MatFormFieldModule, MatInputModule,
    MatSelectModule, MatButtonModule, MatIconModule,
    MatProgressSpinnerModule, MatTooltipModule, MatSnackBarModule,
  ],
  template: `
    <div class="page-container">
      <div class="page-header">
        <h1>Günlük Yayın Raporu</h1>
        <div class="header-actions">
          <button mat-stroked-button [disabled]="exporting()" matTooltip="Excel olarak indir" (click)="exportExcel()">
            <mat-icon>download</mat-icon>
            {{ exporting() ? 'Hazırlanıyor…' : 'Excel İndir' }}
          </button>
        </div>
      </div>

      <!-- Filtreler -->
      <mat-card class="filter-card">
        <mat-card-content>
          <div class="filters-row">
            <mat-form-field class="channel-field">
              <mat-label>Kanal</mat-label>
              <mat-select [(ngModel)]="selectedChannelId" (selectionChange)="load()">
                @for (ch of channels(); track ch.id) {
                  <mat-option [value]="ch.id">{{ ch.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>

            <mat-form-field>
              <mat-label>Tarih</mat-label>
              <input matInput type="date" [(ngModel)]="selectedDate" (change)="load()">
            </mat-form-field>

            <button mat-stroked-button (click)="clearFilter()">
              <mat-icon>clear</mat-icon> Temizle
            </button>
          </div>
        </mat-card-content>
      </mat-card>

      @if (!selectedChannelId) {
        <div class="no-channel">
          <mat-icon>live_tv</mat-icon>
          <p>Raporu görüntülemek için lütfen bir kanal seçin.</p>
        </div>
      }

      @if (selectedChannelId) {
        @if (loading()) {
          <div class="spinner-container"><mat-spinner diameter="48"></mat-spinner></div>
        } @else {

          <!-- Özet kartlar -->
          <div class="summary-row">
            <mat-card class="stat-card">
              <mat-card-content>
                <div class="stat-value">{{ rows().length }}</div>
                <div class="stat-label">Toplam Yayın</div>
              </mat-card-content>
            </mat-card>
            <mat-card class="stat-card">
              <mat-card-content>
                <div class="stat-value">{{ totalMinutes() | number:'1.0-0' }} dk</div>
                <div class="stat-label">Toplam Süre</div>
              </mat-card-content>
            </mat-card>
            <mat-card class="stat-card">
              <mat-card-content>
                <div class="stat-value">{{ avgMinutes() | number:'1.0-0' }} dk</div>
                <div class="stat-label">Ortalama Süre</div>
              </mat-card-content>
            </mat-card>
          </div>

          <!-- Tablo -->
          <mat-table [dataSource]="rows()" class="report-table">
            <ng-container matColumnDef="startTime">
              <mat-header-cell *matHeaderCellDef>Başlangıç</mat-header-cell>
              <mat-cell *matCellDef="let r">{{ r.schedule.startTime | date:'HH:mm' }}</mat-cell>
            </ng-container>

            <ng-container matColumnDef="endTime">
              <mat-header-cell *matHeaderCellDef>Bitiş</mat-header-cell>
              <mat-cell *matCellDef="let r">{{ r.schedule.endTime | date:'HH:mm' }}</mat-cell>
            </ng-container>

            <ng-container matColumnDef="duration">
              <mat-header-cell *matHeaderCellDef>Süre</mat-header-cell>
              <mat-cell *matCellDef="let r" class="mono-cell">{{ r.durationMin | number:'1.0-0' }} dk</mat-cell>
            </ng-container>

            <ng-container matColumnDef="houseNumber">
              <mat-header-cell *matHeaderCellDef>House No</mat-header-cell>
              <mat-cell *matCellDef="let r" class="mono-cell">{{ r.schedule.metadata?.houseNumber ?? '—' }}</mat-cell>
            </ng-container>

            <ng-container matColumnDef="contentName">
              <mat-header-cell *matHeaderCellDef>İçerik Adı</mat-header-cell>
              <mat-cell *matCellDef="let r">
                <div class="title-cell">
                  <span class="content-name">{{ r.schedule.metadata?.contentName || r.schedule.title }}</span>
                  @if (r.schedule.metadata?.description) {
                    <span class="content-desc">{{ r.schedule.metadata.description }}</span>
                  }
                </div>
              </mat-cell>
            </ng-container>

            <ng-container matColumnDef="title">
              <mat-header-cell *matHeaderCellDef>Başlık</mat-header-cell>
              <mat-cell *matCellDef="let r">{{ r.schedule.title }}</mat-cell>
            </ng-container>

            <mat-header-row *matHeaderRowDef="columns"></mat-header-row>
            <mat-row *matRowDef="let row; columns: columns"></mat-row>
            <tr class="mat-row" *matNoDataRow>
              <td class="mat-cell no-data" [attr.colspan]="columns.length">Bu tarih için kayıt bulunamadı</td>
            </tr>
          </mat-table>
        }
      }
    </div>
  `,
  styles: [`
    .page-header    { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
    .header-actions { display:flex; gap:8px; }
    .filter-card    { margin-bottom:16px; }
    .filters-row    { display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
    .channel-field  { min-width:240px; }
    .no-channel {
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      padding:64px 24px; color:#616161; gap:12px;
    }
    .no-channel mat-icon { font-size:48px; width:48px; height:48px; opacity:.4; }
    .no-channel p { font-size:1rem; margin:0; }
    .spinner-container { display:flex; justify-content:center; padding:48px; }
    .summary-row { display:flex; gap:16px; margin-bottom:16px; flex-wrap:wrap; }
    .stat-card   { flex:1; min-width:140px; }
    .stat-value  { font-size:1.8rem; font-weight:700; color:#7c4dff; }
    .stat-label  { font-size:0.82rem; color:#9e9e9e; margin-top:4px; }
    .report-table { width:100%; }
    .no-data { padding:24px; text-align:center; color:#777; }
    .mono-cell    { font-family:monospace; font-size:0.82rem; color:#90a4ae; }
    .title-cell   { display:flex; flex-direction:column; gap:2px; padding:4px 0; }
    .content-name { font-size:0.9rem; font-weight:500; }
    .content-desc { font-size:0.78rem; color:#90a4ae; }
  `],
})
export class DailyReportComponent implements OnInit {
  columns = ['startTime', 'endTime', 'duration', 'houseNumber', 'contentName', 'title'];

  channels      = signal<Channel[]>([]);
  rows          = signal<ReportRow[]>([]);
  loading       = signal(false);
  exporting     = signal(false);

  selectedChannelId: number | null = null;
  selectedDate = new Date().toISOString().slice(0, 10);

  totalMinutes = () => this.rows().reduce((s, r) => s + r.durationMin, 0);
  avgMinutes   = () => this.rows().length ? this.totalMinutes() / this.rows().length : 0;

  constructor(private api: ApiService, private snack: MatSnackBar) {}

  ngOnInit() {
    this.api.get<Channel[]>('/channels').subscribe({
      next: (res) => this.channels.set(Array.isArray(res) ? res : []),
    });
  }

  load() {
    if (!this.selectedChannelId || !this.selectedDate) return;
    this.loading.set(true);

    const from = new Date(`${this.selectedDate}T00:00:00+03:00`).toISOString();
    const to   = new Date(`${this.selectedDate}T23:59:59+03:00`).toISOString();

    this.api.get<{ data: Schedule[]; total: number }>('/schedules', {
      channel:  String(this.selectedChannelId),
      from,
      to,
      page:     '1',
      pageSize: '500',
    }).subscribe({
      next: (res) => {
        const schedules: Schedule[] = Array.isArray(res) ? res : (res.data ?? []);
        this.rows.set(schedules.map(s => ({
          schedule: s,
          durationMin: (new Date(s.endTime).getTime() - new Date(s.startTime).getTime()) / 60000,
        })));
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  clearFilter() {
    this.selectedDate = new Date().toISOString().slice(0, 10);
    this.rows.set([]);
    if (this.selectedChannelId) this.load();
  }

  exportExcel() {
    if (!this.selectedChannelId) return;
    this.exporting.set(true);

    const from = new Date(`${this.selectedDate}T00:00:00+03:00`).toISOString();
    const to   = new Date(`${this.selectedDate}T23:59:59+03:00`).toISOString();

    this.api.getBlob('/schedules/export', { channel: String(this.selectedChannelId), from, to }).subscribe({
      next: (blob) => {
        const url    = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href  = url;
        anchor.download = `gunluk-rapor_${this.selectedDate}.xlsx`;
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
}
