import { Component, signal, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../core/services/api.service';
import { formatIstanbulDate, istanbulTodayDate } from '../../core/time/tz.helpers';

interface UsageRow {
  program: string;
  color: string;
  slotCount: number;
  totalMinutes: number;
  dayCount: number;
  studios: { studio: string; slotCount: number; totalMinutes: number }[];
}

function todayStr(): string {
  return istanbulTodayDate();
}

function monthsAgoStr(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return formatIstanbulDate(d);
}

function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} sa` : `${h} sa ${m} dk`;
}

@Component({
  selector: 'app-studio-plan-report',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule,
    MatProgressSpinnerModule, MatTooltipModule,
  ],
  template: `
    <div class="report-page">
      <div class="report-header">
        <h2>Stüdyo Kullanım Raporu</h2>
        <p class="subtitle">Program bazında toplam stüdyo süresi</p>
      </div>

      <!-- Filtre -->
      <div class="filter-bar">
        <mat-form-field>
          <mat-label>Başlangıç Tarihi</mat-label>
          <input matInput type="date" [(ngModel)]="from">
        </mat-form-field>

        <mat-form-field>
          <mat-label>Bitiş Tarihi</mat-label>
          <input matInput type="date" [(ngModel)]="to">
        </mat-form-field>

        <button mat-flat-button color="primary" (click)="load()" [disabled]="loading()">
          <mat-icon>search</mat-icon> Sorgula
        </button>

        <div class="quick-btns">
          <button mat-stroked-button (click)="setRange(1)">Son 1 Ay</button>
          <button mat-stroked-button (click)="setRange(3)">Son 3 Ay</button>
          <button mat-stroked-button (click)="setRange(6)">Son 6 Ay</button>
          <button mat-stroked-button (click)="setRange(12)">Son 1 Yıl</button>
        </div>
      </div>

      <!-- Yükleniyor -->
      @if (loading()) {
        <div class="spinner-row"><mat-spinner diameter="32"></mat-spinner></div>
      }

      <!-- Özet -->
      @if (!loading() && rows().length > 0) {
        <div class="summary-bar">
          <span class="summary-chip">
            <strong>{{ rows().length }}</strong> program
          </span>
          <span class="summary-chip">
            <strong>{{ totalMinutes() | number }}</strong> dk toplam
          </span>
          <span class="summary-chip">
            <strong>{{ formatHours(totalMinutes()) }}</strong>
          </span>
        </div>

        <!-- Tablo -->
        <div class="table-wrap">
          <table class="usage-table">
            <thead>
              <tr>
                <th class="th-rank">#</th>
                <th class="th-color">Renk</th>
                <th class="th-program">Program</th>
                <th class="th-num">Slot</th>
                <th class="th-num">Toplam Dk</th>
                <th class="th-num">Toplam Saat</th>
                <th class="th-num">Gün</th>
                <th class="th-studios">Stüdyo Dağılımı</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.program; let i = $index) {
                <tr>
                  <td class="td-rank">{{ i + 1 }}</td>
                  <td class="td-color">
                    <span class="color-swatch" [style.background]="row.color"></span>
                  </td>
                  <td class="td-program">{{ row.program }}</td>
                  <td class="td-num">{{ row.slotCount }}</td>
                  <td class="td-num">{{ row.totalMinutes }}</td>
                  <td class="td-num">{{ formatHours(row.totalMinutes) }}</td>
                  <td class="td-num">{{ row.dayCount }}</td>
                  <td class="td-studios">
                    @for (s of row.studios; track s.studio) {
                      <span class="studio-tag">{{ s.studio }}: {{ s.totalMinutes }} dk</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }

      @if (!loading() && queried() && rows().length === 0) {
        <div class="empty-state">
          <mat-icon>inbox</mat-icon>
          <p>Seçilen tarih aralığında stüdyo plan verisi bulunamadı.</p>
        </div>
      }
    </div>
  `,
  styles: [`
    .report-page { padding: 24px; max-width: 1200px; }

    .report-header { margin-bottom: 20px; }
    .report-header h2 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
    .subtitle { margin: 0; color: rgba(255,255,255,.5); font-size: 13px; }

    .filter-bar {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      margin-bottom: 20px; padding: 16px;
      background: #1a1a2e; border-radius: 8px;
    }
    .filter-bar mat-form-field { width: 160px; }
    .quick-btns { display: flex; gap: 6px; flex-wrap: wrap; }
    .quick-btns button { font-size: 12px; height: 32px; }

    .spinner-row { display: flex; justify-content: center; padding: 40px; }

    .summary-bar {
      display: flex; gap: 16px; margin-bottom: 16px;
    }
    .summary-chip {
      background: #1a1a2e; padding: 6px 14px; border-radius: 20px;
      font-size: 13px; color: var(--bp-line-2);
    }
    .summary-chip strong { color: #90caf9; }

    .table-wrap { overflow-x: auto; }
    .usage-table {
      width: 100%; border-collapse: collapse; font-size: 13px;
    }
    .usage-table th {
      background: #1a1a2e; padding: 10px 12px; text-align: left;
      font-weight: 600; color: var(--bp-line-2);
      border-bottom: 1px solid var(--bp-line-2);
      white-space: nowrap;
    }
    .usage-table td {
      padding: 9px 12px;
      border-bottom: 1px solid var(--bp-line-2);
      vertical-align: middle;
    }
    .usage-table tr:hover td { background: rgba(255,255,255,.03); }

    .th-rank, .td-rank { width: 36px; color: rgba(255,255,255,.4); text-align: center; }
    .th-color, .td-color { width: 48px; text-align: center; }
    .th-num, .td-num { text-align: right; white-space: nowrap; }
    .th-studios { min-width: 200px; }

    .color-swatch {
      display: inline-block; width: 20px; height: 20px;
      border-radius: 4px; border: 1px solid var(--bp-line);
    }

    .studio-tag {
      display: inline-block; margin: 2px 4px 2px 0;
      background: var(--bp-line-2); padding: 2px 8px;
      border-radius: 10px; font-size: 11px; white-space: nowrap;
    }

    .empty-state {
      display: flex; flex-direction: column; align-items: center;
      padding: 60px 20px; color: rgba(255,255,255,.4);
    }
    .empty-state mat-icon { font-size: 48px; width: 48px; height: 48px; margin-bottom: 12px; }
  `],
})
export class StudioPlanReportComponent {
  private api = inject(ApiService);

  from    = monthsAgoStr(3);
  to      = todayStr();
  loading = signal(false);
  queried = signal(false);
  rows    = signal<UsageRow[]>([]);

  readonly formatHours = formatHours;

  // MED-FE-001 fix (2026-05-05): plain method her CD cycle'da recalc; computed
  // sadece rows() değişiminde recompute eder (Angular signals memoize).
  totalMinutes = computed(() => this.rows().reduce((s, r) => s + r.totalMinutes, 0));

  setRange(months: number) {
    this.from = monthsAgoStr(months);
    this.to   = todayStr();
    this.load();
  }

  load() {
    if (!this.from || !this.to) return;
    this.loading.set(true);
    this.api.get<UsageRow[]>(`/studio-plans/reports/usage?from=${this.from}&to=${this.to}`).subscribe({
      next: (data) => { this.rows.set(data); this.loading.set(false); this.queried.set(true); },
      error: ()   => { this.loading.set(false); },
    });
  }
}
