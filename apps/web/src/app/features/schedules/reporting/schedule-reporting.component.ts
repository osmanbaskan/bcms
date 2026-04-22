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

interface FixtureCompetition {
  league: string;
  season: string | null;
  weeks: number[];
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

type FilterMode = 'date-range' | 'league-week';

function todayDisplayDate(): string {
  const date = new Date();
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${date.getFullYear()}`;
}

function parseDisplayDate(value: string): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(value ?? '').trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function displayDateFromIso(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

function maskDisplayDateInput(value: string): string {
  const digits = String(value ?? '').replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
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

        <mat-form-field class="mode-field">
          <mat-label>Filtre Tipi</mat-label>
          <mat-select [(ngModel)]="filterMode" (selectionChange)="load()">
            <mat-option value="date-range">Tarihler Arası</mat-option>
            <mat-option value="league-week">Lig / Hafta</mat-option>
          </mat-select>
        </mat-form-field>

        @if (filterMode === 'date-range') {
          <mat-form-field class="date-field">
            <mat-label>Başlangıç</mat-label>
            <input matInput
                   inputmode="numeric"
                   maxlength="10"
                   placeholder="gg.aa.yyyy"
                   [ngModel]="selectedFromDate"
                   (ngModelChange)="onDateInput('from', $event)"
                   (change)="load()"
                   (keyup.enter)="load()">
          </mat-form-field>

          <mat-form-field class="date-field">
            <mat-label>Bitiş</mat-label>
            <input matInput
                   inputmode="numeric"
                   maxlength="10"
                   placeholder="gg.aa.yyyy"
                   [ngModel]="selectedToDate"
                   (ngModelChange)="onDateInput('to', $event)"
                   (change)="load()"
                   (keyup.enter)="load()">
          </mat-form-field>
        } @else {
          <mat-form-field class="league-field">
            <mat-label>Lig</mat-label>
            <mat-select [(ngModel)]="selectedLeague" (selectionChange)="onLeagueChange($event.value)">
              <mat-option [value]="null">Tüm ligler</mat-option>
              @for (league of leagues(); track league) {
                <mat-option [value]="league">{{ league }}</mat-option>
              }
            </mat-select>
          </mat-form-field>

          <mat-form-field class="season-field">
            <mat-label>Sezon</mat-label>
            <mat-select [(ngModel)]="selectedSeason" (selectionChange)="onSeasonChange($event.value)" [disabled]="!selectedLeague || !seasonsForSelectedLeague().length">
              <mat-option [value]="null">Tüm sezonlar</mat-option>
              @for (season of seasonsForSelectedLeague(); track season) {
                <mat-option [value]="season">{{ season }}</mat-option>
              }
            </mat-select>
          </mat-form-field>

          <mat-form-field class="week-field">
            <mat-label>Hafta</mat-label>
            <mat-select [(ngModel)]="selectedWeek" (selectionChange)="load()" [disabled]="!selectedLeague || !weeksForSelectedFilter().length">
              <mat-option [value]="null">Tüm haftalar</mat-option>
              @for (week of weeksForSelectedFilter(); track week) {
                <mat-option [value]="week">Hafta {{ week }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        }

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
          <span class="summary-value">{{ filterSummary() }}</span>
          <span class="summary-label">Filtre</span>
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
              <td mat-cell *matCellDef="let row">{{ time24(row.schedule.startTime) }}</td>
            </ng-container>

            <ng-container matColumnDef="endTime">
              <th mat-header-cell *matHeaderCellDef>Bitiş</th>
              <td mat-cell *matCellDef="let row">{{ time24(row.schedule.endTime) }}</td>
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
    .mode-field { min-width:180px; }
    .date-field { min-width:180px; }
    .league-field { min-width:240px; }
    .season-field { width:150px; }
    .week-field { width:120px; }
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
      .report-field, .mode-field, .date-field, .league-field, .season-field, .week-field { width:100%; min-width:100%; }
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

  filterEntries = signal<FixtureCompetition[]>([]);
  rows = signal<ReportRow[]>([]);
  loading = signal(false);
  exporting = signal(false);

  selectedReportId = 'live-plan';
  filterMode: FilterMode = 'date-range';
  selectedFromDate = todayDisplayDate();
  selectedToDate = todayDisplayDate();
  selectedLeague: string | null = null;
  selectedSeason: string | null = null;
  selectedWeek: number | null = null;

  selectedReport = computed(() =>
    this.reportDefinitions.find((report) => report.id === this.selectedReportId) ?? this.reportDefinitions[0],
  );

  totalMinutes = computed(() =>
    this.rows().reduce((total, row) => total + row.durationMin, 0),
  );

  leagues = computed(() => (
    [...new Set(this.filterEntries().map((entry) => entry.league))]
      .sort((a, b) => a.localeCompare(b, 'tr'))
  ));

  seasonsForSelectedLeague = computed(() => {
    if (!this.selectedLeague) return [];
    return [...new Set(
      this.filterEntries()
        .filter((entry) => entry.league === this.selectedLeague && entry.season)
        .map((entry) => entry.season as string),
    )].sort((a, b) => b.localeCompare(a, 'tr'));
  });

  weeksForSelectedFilter = computed(() => {
    if (!this.selectedLeague) return [];
    const weeks = new Set<number>();
    for (const entry of this.filterEntries()) {
      if (entry.league !== this.selectedLeague) continue;
      if (this.selectedSeason && entry.season !== this.selectedSeason) continue;
      entry.weeks.forEach((week) => weeks.add(week));
    }
    return [...weeks].sort((a, b) => a - b);
  });

  filterSummary = computed(() => {
    if (this.filterMode === 'date-range') {
      return `${this.selectedFromDate} - ${this.selectedToDate}`;
    }

    const parts = [
      this.selectedLeague || 'Tüm ligler',
      this.selectedSeason || 'Tüm sezonlar',
      this.selectedWeek ? `Hafta ${this.selectedWeek}` : 'Tüm haftalar',
    ].filter(Boolean);
    return parts.join(' · ');
  });

  constructor(private api: ApiService, private snack: MatSnackBar, private datePipe: DatePipe) {}

  ngOnInit(): void {
    this.api.get<FixtureCompetition[]>('/schedules/reports/live-plan/filters').subscribe({
      next: (entries) => this.filterEntries.set(Array.isArray(entries) ? entries : []),
      error: () => this.snack.open('Rapor filtreleri alınamadı', 'Kapat', { duration: 4000 }),
    });
    this.load();
  }

  load(): void {
    const report = this.selectedReport();
    if (!report.enabled) return;

    const params = this.queryParams();
    if (!params) return;

    this.loading.set(true);
    this.api.get<{ data: Schedule[]; total: number }>(report.endpoint, params).subscribe({
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
    const params = this.queryParams();
    if (!params) return;

    this.exporting.set(true);
    this.api.getBlob(report.exportEndpoint, params).subscribe({
      next: (blob) => {
        this.downloadBlob(blob, `${report.id}_${this.exportSuffix()}.xlsx`);
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

  time24(value: string): string {
    return this.datePipe.transform(value, 'HH:mm', '+0300') ?? '';
  }

  onDateInput(field: 'from' | 'to', value: string): void {
    const masked = maskDisplayDateInput(value);
    if (field === 'from') {
      this.selectedFromDate = masked;
    } else {
      this.selectedToDate = masked;
    }
  }

  onLeagueChange(league: string | null): void {
    this.selectedLeague = league;
    this.selectedSeason = null;
    this.selectedWeek = null;
    this.load();
  }

  onSeasonChange(season: string | null): void {
    this.selectedSeason = season;
    this.selectedWeek = null;
    this.load();
  }

  private queryParams(): Record<string, string | number> | null {
    const base = { page: 1, pageSize: 500 };

    if (this.filterMode === 'league-week') {
      return {
        ...base,
        ...(this.selectedLeague ? { league: this.selectedLeague } : {}),
        ...(this.selectedSeason ? { season: this.selectedSeason } : {}),
        ...(this.selectedWeek ? { week: this.selectedWeek } : {}),
      };
    }

    const range = this.normalizedDateRange();
    if (!range) {
      this.snack.open('Tarih formatı gg.aa.yyyy olmalıdır', 'Kapat', { duration: 4000 });
      return null;
    }

    const [fromDate, toDate] = range;
    return {
      ...base,
      from: new Date(`${fromDate}T00:00:00+03:00`).toISOString(),
      to:   new Date(`${toDate}T23:59:59+03:00`).toISOString(),
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
    const title = `${this.selectedReport().label} - ${this.filterSummary()}`;
    const rows = this.rows().map((row) => `
      <tr>
        <td>${this.time24(row.schedule.startTime)}</td>
        <td>${this.time24(row.schedule.endTime)}</td>
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
          <div class="meta">Filtre: ${this.escape(this.filterSummary())} | Kayıt: ${this.rows().length}</div>
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

  private normalizedDateRange(): [string, string] | null {
    const from = parseDisplayDate(this.selectedFromDate);
    const to = parseDisplayDate(this.selectedToDate);
    if (!from || !to) return null;
    if (from <= to) {
      return [from, to];
    }
    return [to, from];
  }

  private exportSuffix(): string {
    if (this.filterMode === 'league-week') {
      const league = (this.selectedLeague || 'tum-ligler').toLocaleLowerCase('tr-TR').replace(/[^a-z0-9ğüşöçıİ-]+/gi, '-');
      const season = (this.selectedSeason || 'tum-sezonlar').toLocaleLowerCase('tr-TR').replace(/[^a-z0-9ğüşöçıİ-]+/gi, '-');
      return `${league}_${season}_${this.selectedWeek ? `hafta-${this.selectedWeek}` : 'tum-haftalar'}`;
    }

    const range = this.normalizedDateRange();
    if (!range) return 'tarih';
    const [from, to] = range.map(displayDateFromIso);
    return from === to ? from : `${from}_${to}`;
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
