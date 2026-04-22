import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ApiService } from '../../../core/services/api.service';
import type { Schedule } from '@bcms/shared';

interface Channel {
  id: number;
  name: string;
  type: string;
}

interface ReportDefinition {
  id: string;
  label: string;
  endpoint: string;
  exportEndpoint: string;
  enabled: boolean;
}

interface ReportRow {
  schedule: Schedule;
  durationMin: number;
}

@Component({
  selector: 'app-schedule-reporting',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTableModule,
    MatTooltipModule,
  ],
  providers: [DatePipe],
  template: `
    <div class="report-page">
      <header class="page-header">
        <div>
          <h1>Raporlama</h1>
          <p>Canlı yayın planı verilerini Excel ve PDF formatında dışa aktarın.</p>
        </div>

        <div class="header-actions">
          <button mat-stroked-button [disabled]="loading() || exporting() || !rows().length" (click)="exportExcel()">
            <mat-icon>table_view</mat-icon>
            Excel
          </button>
          <button mat-stroked-button [disabled]="loading() || exporting() || !rows().length" (click)="exportPdf()">
            <mat-icon>picture_as_pdf</mat-icon>
            PDF
          </button>
        </div>
      </header>

      <section class="filter-band">
        <mat-form-field class="report-field">
          <mat-label>Rapor</mat-label>
          <mat-select [(ngModel)]="selectedReportId" (selectionChange)="load()">
            @for (report of reportDefinitions; track report.id) {
              <mat-option [value]="report.id" [disabled]="!report.enabled">{{ report.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field>
          <mat-label>Tarih</mat-label>
          <input matInput type="date" [(ngModel)]="selectedDate" (change)="load()">
        </mat-form-field>

        <mat-form-field class="channel-field">
          <mat-label>Kanal</mat-label>
          <mat-select [(ngModel)]="selectedChannelId" (selectionChange)="load()">
            <mat-option [value]="null">Tüm kanallar</mat-option>
            @for (channel of channels(); track channel.id) {
              <mat-option [value]="channel.id">{{ channel.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <button mat-stroked-button (click)="load()">
          <mat-icon>refresh</mat-icon>
          Yenile
        </button>
      </section>

      <section class="summary-grid">
        <div class="summary-item">
          <span class="summary-value">{{ rows().length }}</span>
          <span class="summary-label">Kayıt</span>
        </div>
        <div class="summary-item">
          <span class="summary-value">{{ totalMinutes() | number:'1.0-0' }}</span>
          <span class="summary-label">Dakika</span>
        </div>
        <div class="summary-item">
          <span class="summary-value">{{ selectedChannelName() }}</span>
          <span class="summary-label">Kanal</span>
        </div>
      </section>

      @if (loading()) {
        <div class="loading-state">
          <mat-spinner diameter="44"></mat-spinner>
        </div>
      } @else {
        <div class="table-shell">
          <table mat-table [dataSource]="rows()" class="report-table">
            <ng-container matColumnDef="startTime">
              <th mat-header-cell *matHeaderCellDef>Saat</th>
              <td mat-cell *matCellDef="let row">{{ row.schedule.startTime | date:'HH:mm' }}</td>
            </ng-container>

            <ng-container matColumnDef="endTime">
              <th mat-header-cell *matHeaderCellDef>Bitiş</th>
              <td mat-cell *matCellDef="let row">{{ row.schedule.endTime | date:'HH:mm' }}</td>
            </ng-container>

            <ng-container matColumnDef="channel">
              <th mat-header-cell *matHeaderCellDef>Kanal</th>
              <td mat-cell *matCellDef="let row">{{ row.schedule.channel?.name ?? '-' }}</td>
            </ng-container>

            <ng-container matColumnDef="title">
              <th mat-header-cell *matHeaderCellDef>Yayın</th>
              <td mat-cell *matCellDef="let row">
                <div class="title-cell">
                  <span>{{ text(row.schedule.metadata?.['contentName']) || row.schedule.title }}</span>
                  <small>{{ row.schedule.title }}</small>
                </div>
              </td>
            </ng-container>

            <ng-container matColumnDef="houseNumber">
              <th mat-header-cell *matHeaderCellDef>House No</th>
              <td mat-cell *matCellDef="let row">{{ text(row.schedule.metadata?.['houseNumber']) || '-' }}</td>
            </ng-container>

            <ng-container matColumnDef="duration">
              <th mat-header-cell *matHeaderCellDef>Süre</th>
              <td mat-cell *matCellDef="let row">{{ row.durationMin | number:'1.0-0' }} dk</td>
            </ng-container>

            <tr mat-header-row *matHeaderRowDef="columns"></tr>
            <tr mat-row *matRowDef="let row; columns: columns"></tr>
          </table>

          @if (!rows().length) {
            <div class="empty-state">
              <mat-icon>summarize</mat-icon>
              <span>Seçili filtreler için rapor verisi bulunamadı.</span>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .report-page { display:flex; flex-direction:column; gap:18px; }
    .page-header {
      display:flex; justify-content:space-between; align-items:flex-start; gap:16px;
      padding-bottom:14px; border-bottom:1px solid rgba(255,255,255,.1);
    }
    .page-header h1 { margin:0 0 6px; font-size:1.7rem; font-weight:600; }
    .page-header p { margin:0; color:#a8adba; }
    .header-actions { display:flex; gap:8px; flex-wrap:wrap; }
    .filter-band {
      display:flex; align-items:center; gap:14px; flex-wrap:wrap;
      padding:14px 0; border-bottom:1px solid rgba(255,255,255,.08);
    }
    .report-field { min-width:280px; }
    .channel-field { min-width:220px; }
    .summary-grid {
      display:grid; grid-template-columns:repeat(3, minmax(140px, 1fr)); gap:12px;
    }
    .summary-item {
      min-height:72px; padding:14px 16px; border:1px solid rgba(255,255,255,.1);
      background:#171a21; border-radius:6px; display:flex; flex-direction:column; justify-content:center;
    }
    .summary-value { font-size:1.45rem; font-weight:700; color:#e7ecff; line-height:1.2; }
    .summary-label { margin-top:5px; color:#8f97a8; font-size:.8rem; }
    .loading-state { display:flex; justify-content:center; padding:48px; }
    .table-shell { overflow:auto; border:1px solid rgba(255,255,255,.1); border-radius:6px; }
    .report-table { width:100%; min-width:860px; }
    .title-cell { display:flex; flex-direction:column; gap:2px; padding:5px 0; }
    .title-cell small { color:#8f97a8; }
    .empty-state {
      display:flex; align-items:center; justify-content:center; gap:10px;
      padding:32px; color:#9aa2b3;
    }
    @media (max-width: 760px) {
      .page-header { flex-direction:column; }
      .summary-grid { grid-template-columns:1fr; }
      .report-field, .channel-field { min-width:100%; }
    }
  `],
})
export class ScheduleReportingComponent implements OnInit {
  readonly reportDefinitions: ReportDefinition[] = [
    {
      id: 'live-plan',
      label: 'Canlı Yayın Planı',
      endpoint: '/schedules/reports/live-plan',
      exportEndpoint: '/schedules/reports/live-plan/export',
      enabled: true,
    },
  ];

  readonly columns = ['startTime', 'endTime', 'channel', 'title', 'houseNumber', 'duration'];

  channels = signal<Channel[]>([]);
  rows = signal<ReportRow[]>([]);
  loading = signal(false);
  exporting = signal(false);

  selectedReportId = 'live-plan';
  selectedChannelId: number | null = null;
  selectedDate = new Date().toISOString().slice(0, 10);

  selectedReport = computed(() =>
    this.reportDefinitions.find((report) => report.id === this.selectedReportId) ?? this.reportDefinitions[0],
  );

  totalMinutes = computed(() =>
    this.rows().reduce((total, row) => total + row.durationMin, 0),
  );

  selectedChannelName = computed(() => {
    if (!this.selectedChannelId) return 'Tüm kanallar';
    return this.channels().find((channel) => channel.id === this.selectedChannelId)?.name ?? String(this.selectedChannelId);
  });

  constructor(private api: ApiService, private snack: MatSnackBar, private datePipe: DatePipe) {}

  ngOnInit(): void {
    this.api.get<Channel[]>('/channels').subscribe({
      next: (channels) => this.channels.set(channels),
      error: () => this.snack.open('Kanal listesi alınamadı', 'Kapat', { duration: 4000 }),
    });
    this.load();
  }

  load(): void {
    const report = this.selectedReport();
    if (!report.enabled) return;

    this.loading.set(true);
    this.api.get<{ data: Schedule[]; total: number }>(report.endpoint, this.queryParams()).subscribe({
      next: (result) => {
        const schedules = result.data ?? [];
        this.rows.set(schedules.map((schedule) => ({
          schedule,
          durationMin: Math.max(0, (new Date(schedule.endTime).getTime() - new Date(schedule.startTime).getTime()) / 60000),
        })));
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.snack.open(`Rapor verisi alınamadı: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }

  exportExcel(): void {
    const report = this.selectedReport();
    this.exporting.set(true);
    this.api.getBlob(report.exportEndpoint, this.queryParams()).subscribe({
      next: (blob) => {
        this.downloadBlob(blob, `${report.id}_${this.selectedDate}.xlsx`);
        this.exporting.set(false);
      },
      error: (err) => {
        this.exporting.set(false);
        this.snack.open(`Excel export hatası: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }

  exportPdf(): void {
    const win = window.open('', '_blank', 'width=1200,height=800');
    if (!win) {
      this.snack.open('PDF penceresi açılamadı', 'Kapat', { duration: 4000 });
      return;
    }
    win.opener = null;

    win.document.write(this.buildPrintableHtml());
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
  }

  text(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  private queryParams(): Record<string, string | number> {
    const from = new Date(`${this.selectedDate}T00:00:00+03:00`).toISOString();
    const to = new Date(`${this.selectedDate}T23:59:59+03:00`).toISOString();
    return {
      from,
      to,
      page: 1,
      pageSize: 500,
      ...(this.selectedChannelId ? { channelId: this.selectedChannelId } : {}),
    };
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private buildPrintableHtml(): string {
    const title = `${this.selectedReport().label} - ${this.selectedDate}`;
    const rows = this.rows().map((row) => `
      <tr>
        <td>${this.date(row.schedule.startTime, 'HH:mm')}</td>
        <td>${this.date(row.schedule.endTime, 'HH:mm')}</td>
        <td>${this.escape(row.schedule.channel?.name ?? '-')}</td>
        <td>${this.escape(this.text(row.schedule.metadata?.['contentName']) || row.schedule.title)}</td>
        <td>${this.escape(this.text(row.schedule.metadata?.['houseNumber']) || '-')}</td>
        <td>${Math.round(row.durationMin)} dk</td>
      </tr>
    `).join('');

    return `
      <!doctype html>
      <html lang="tr">
        <head>
          <meta charset="utf-8">
          <title>${this.escape(title)}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
            h1 { font-size: 22px; margin: 0 0 6px; }
            .meta { color: #555; margin-bottom: 18px; }
            table { width: 100%; border-collapse: collapse; font-size: 12px; }
            th, td { border: 1px solid #bbb; padding: 7px 8px; text-align: left; }
            th { background: #eee; }
          </style>
        </head>
        <body>
          <h1>${this.escape(title)}</h1>
          <div class="meta">Kanal: ${this.escape(this.selectedChannelName())} | Kayıt: ${this.rows().length}</div>
          <table>
            <thead>
              <tr><th>Saat</th><th>Bitiş</th><th>Kanal</th><th>Yayın</th><th>House No</th><th>Süre</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </body>
      </html>
    `;
  }

  private date(value: string, format: string): string {
    return this.datePipe.transform(value, format) ?? '';
  }

  private escape(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
