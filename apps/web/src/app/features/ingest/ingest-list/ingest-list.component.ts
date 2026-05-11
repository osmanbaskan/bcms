import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { environment } from '../../../../environments/environment';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { DateAdapter, MAT_DATE_FORMATS, MAT_DATE_LOCALE, MatNativeDateModule, NativeDateAdapter } from '@angular/material/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatChipsModule } from '@angular/material/chips';
import { interval, Subscription, timer } from 'rxjs';
import { switchMap, take } from 'rxjs/operators';

import { ApiService } from '../../../core/services/api.service';
import { formatIstanbulDateTr, formatIstanbulTime, istanbulDayRangeUtc } from '../../../core/time/tz.helpers';
import { LoggerService } from '../../../core/services/logger.service';
import {
  IngestPortBoardColumnView,
  IngestPortBoardComponent,
  IngestPortBoardItemView,
  IngestPortBoardTimeLabel,
} from '../ingest-port-board/ingest-port-board.component';
import type {
  Channel,
  IngestJob,
  IngestPlanItem,
  IngestPlanStatus,
  LivePlanIngestCandidate,
  PaginatedResponse,
  RecordingPort,
  Schedule,
  StudioPlan,
  StudioPlanSlot,
} from '@bcms/shared';

interface IngestPlanRow {
  id: string;
  source: 'live-plan' | 'studio-plan' | 'ingest-plan';
  sourceLabel: string;
  sourceKey: string;
  day: string;
  sortMinute: number;
  endMinute: number;
  startTime: string;
  endTime: string;
  title: string;
  location: string;
  note: string;      // kaynak bilgisi (lig/stüdyo) — salt okunur
  planNote: string;  // operatör notu — düzenlenebilir, ingest_plan_items.note
  recordingPort: string;
  backupRecordingPort: string;
  status: IngestPlanStatus;
  jobId?: number | null;
  scheduleId?: number;
}

type PlanFilter = 'all' | 'today' | 'active' | 'unassigned' | 'issues';
type SourceFilter = 'all' | 'Canlı Yayın' | 'Stüdyo Planı';

const SOURCE_FILTERS: Array<{ label: string; value: SourceFilter }> = [
  { label: 'Tümü',         value: 'all' },
  { label: 'Canlı Yayın',  value: 'Canlı Yayın' },
  { label: 'Stüdyo Planı', value: 'Stüdyo Planı' },
];

const ACTIVE_STATUSES = new Set(['PENDING', 'PROCESSING', 'PROXY_GEN', 'QC']);
const ACTIVE_PLAN_STATUSES = new Set<IngestPlanStatus>(['WAITING', 'RECEIVED', 'INGEST_STARTED']);

const STATUS_TABS: Array<{ label: string; value: string | null }> = [
  { label: 'Tümü',       value: null },
  { label: 'Aktif',      value: 'ACTIVE' },
  { label: 'Tamamlandı', value: 'COMPLETED' },
  { label: 'Başarısız',  value: 'FAILED' },
];

const PLAN_FILTERS: Array<{ label: string; value: PlanFilter }> = [
  { label: 'Tüm Plan', value: 'all' },
  { label: 'Bugünün İşleri', value: 'today' },
  { label: 'Aktif İşler', value: 'active' },
  { label: 'Port Atanmamış', value: 'unassigned' },
  { label: 'Sorunlular', value: 'issues' },
];

const PLAN_STATUS_OPTIONS: Array<{ value: IngestPlanStatus; label: string }> = [
  { value: 'WAITING',        label: 'Bekliyor' },
  { value: 'RECEIVED',       label: 'Alındı' },
  { value: 'INGEST_STARTED', label: 'İşlemde' },
  { value: 'COMPLETED',      label: 'Tamamlandı' },
  { value: 'ISSUE',          label: 'Sorun' },
];

const PORT_BOARD_SLOT_MINUTES = 30;

const TR_DATE_FORMATS = {
  parse: { dateInput: 'dd.MM.yyyy' },
  display: {
    dateInput: 'dd.MM.yyyy',
    monthYearLabel: { month: 'short', year: 'numeric' },
    dateA11yLabel: { day: '2-digit', month: 'long', year: 'numeric' },
    monthYearA11yLabel: { month: 'long', year: 'numeric' },
  },
};

class TrDateAdapter extends NativeDateAdapter {
  override parse(value: string | null, _parseFormat: unknown): Date | null {
    if (!value) return null;
    const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim());
    if (match) {
      const date = new Date(+match[3], +match[2] - 1, +match[1]);
      return isNaN(date.getTime()) ? null : date;
    }
    return super.parse(value, _parseFormat);
  }

  override format(date: Date, displayFormat: unknown): string {
    if (displayFormat === 'dd.MM.yyyy') {
      return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
    }
    return super.format(date, displayFormat as object);
  }
}


@Component({
  selector: 'app-ingest-list',
  standalone: true,
  providers: [
    { provide: MAT_DATE_LOCALE, useValue: 'tr-TR' },
    { provide: MAT_DATE_FORMATS, useValue: TR_DATE_FORMATS },
    { provide: DateAdapter, useClass: TrDateAdapter, deps: [MAT_DATE_LOCALE] },
  ],
  imports: [
    CommonModule,
    FormsModule,
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    MatTabsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatDatepickerModule,
    MatNativeDateModule,
    MatExpansionModule,
    MatProgressBarModule,
    MatSnackBarModule,
    MatChipsModule,
    IngestPortBoardComponent,
  ],
  template: `
    <div class="page-container">
      <div class="page-header">
        <div>
          <h1>Ingest Planlama</h1>
          <p class="page-subtitle">Canlı yayın planı ve stüdyo planı ingest departmanı için tek akışta görünür.</p>
        </div>
        <div class="header-actions">
          <span class="auto-refresh-label" *ngIf="hasActiveJobs()">
            <mat-icon class="spin">sync</mat-icon> Otomatik yenileniyor…
          </span>
          <button mat-stroked-button (click)="load()">
            <mat-icon>refresh</mat-icon> Yenile
          </button>
        </div>
      </div>

      <mat-tab-group class="workspace-tabs" (selectedIndexChange)="onWorkspaceTabChange($event)">
        <mat-tab label="Ingest Planlama">
      <div class="planning-board">
        <div class="planning-board-header">
          <div>
            <h2>Ingest Planı</h2>
            <p>Canlı yayın planı ve stüdyo planı kayıtları</p>
          </div>
          <span>{{ planningRows().length }} kayıt</span>
        </div>

        <div class="plan-filter-bar">
          @for (filter of planFilters; track filter.value) {
            <button
              type="button"
              class="plan-filter-button"
              [class.active]="planFilter() === filter.value"
              (click)="setPlanFilter(filter.value)"
            >
              {{ filter.label }}
              <span>{{ planFilterCount(filter.value) }}</span>
            </button>
          }
        </div>

        <div class="source-filter-bar">
          <span class="source-filter-label">Kaynak:</span>
          @for (sf of sourceFilters; track sf.value) {
            <button
              type="button"
              class="source-filter-button"
              [class.active]="sourceFilter() === sf.value"
              (click)="sourceFilter.set(sf.value)"
            >{{ sf.label }}</button>
          }
        </div>

        <div class="live-plan-tools planning-tools">
          <mat-form-field>
            <mat-label>Tarih</mat-label>
            <input matInput [matDatepicker]="livePlanPicker" [(ngModel)]="livePlanDateValue" (dateChange)="onLivePlanDateChange($event.value)" />
            <mat-datepicker-toggle matIconSuffix [for]="livePlanPicker"></mat-datepicker-toggle>
            <mat-datepicker #livePlanPicker></mat-datepicker>
          </mat-form-field>

          <button mat-stroked-button (click)="loadLivePlanCandidates()" [disabled]="livePlanLoading() || studioPlanLoading()">
            <mat-icon>refresh</mat-icon>
            Planı Yenile
          </button>
        </div>

        @if (livePlanLoading() || studioPlanLoading()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }

        @if (!livePlanLoading() && !studioPlanLoading() && planningRows().length === 0) {
          <p class="empty-live-plan">Seçili tarih için ingest planı kaydı bulunamadı.</p>
        }

        @if (!livePlanLoading() && !studioPlanLoading() && planningRows().length > 0 && filteredPlanningRows().length === 0) {
          <p class="empty-live-plan">Seçili filtre için ingest planı kaydı bulunamadı.</p>
        }

        @if (filteredPlanningRows().length > 0) {
          <div class="planning-table-wrap">
            <div class="planning-table">
              <div class="planning-head">
                <span>Kaynak</span>
                <span>Saat</span>
                <span>İçerik</span>
                <span>Kayıt Portu</span>
                <span>Yedek Kayıt Portu</span>
                <span>Açıklama</span>
              </div>

              @for (row of filteredPlanningRows(); track row.id) {
                <div class="planning-row">
                  <span class="source-pill" [class.studio]="row.source === 'studio-plan' || (row.source === 'ingest-plan' && row.sourceLabel === 'Stüdyo Planı')" [class.ingest-plan]="row.source === 'ingest-plan'">{{ row.sourceLabel }}</span>
                  <div class="time-edit">
                    <input type="time" step="300" class="time-input" [value]="row.startTime" (change)="onStartTimeChange(row, $event)" [disabled]="isSavingPlanRow(row.sourceKey)" />
                    <input type="time" step="300" class="time-input" [value]="row.endTime" (change)="onEndTimeChange(row, $event)" [disabled]="isSavingPlanRow(row.sourceKey)" />
                  </div>
                  <div class="content-cell">
                    <span>{{ row.title }}</span>
                    @if (row.note && row.note !== '-') {
                      <span class="content-meta">{{ row.note }}</span>
                    }
                  </div>
                  <div class="port-cell" [class.assigned]="row.recordingPort">
                    <span class="port-dot"></span>
                    <mat-form-field class="inline-field" appearance="outline">
                      <mat-select [(ngModel)]="row.recordingPort" (selectionChange)="savePlanRow(row)" [disabled]="isSavingPlanRow(row.sourceKey)">
                        <mat-option value="">Port seçilmedi</mat-option>
                        @for (port of activeRecordingPorts(); track port.id) {
                          <mat-option [value]="port.name"
                                      [disabled]="port.name === row.backupRecordingPort
                                               || isPortBusyForRow(row.sourceKey, port.name)"
                                      [class.port-busy]="isPortBusyForRow(row.sourceKey, port.name)">
                            {{ port.name }}@if (isPortBusyForRow(row.sourceKey, port.name)) { <span class="busy-tag"> · meşgul</span> }
                          </mat-option>
                        }
                      </mat-select>
                    </mat-form-field>
                  </div>
                  <div class="port-cell" [class.assigned]="row.backupRecordingPort">
                    <span class="port-dot"></span>
                    <mat-form-field class="inline-field" appearance="outline">
                      <mat-select [(ngModel)]="row.backupRecordingPort" (selectionChange)="savePlanRow(row)" [disabled]="isSavingPlanRow(row.sourceKey) || !row.recordingPort">
                        <mat-option value="">Port seçilmedi</mat-option>
                        @for (port of activeRecordingPorts(); track port.id) {
                          <mat-option [value]="port.name"
                                      [disabled]="port.name === row.recordingPort
                                               || isPortBusyForRow(row.sourceKey, port.name)"
                                      [class.port-busy]="isPortBusyForRow(row.sourceKey, port.name)">
                            {{ port.name }}@if (isPortBusyForRow(row.sourceKey, port.name)) { <span class="busy-tag"> · meşgul</span> }
                          </mat-option>
                        }
                      </mat-select>
                    </mat-form-field>
                  </div>
                  <div class="note-cell">
                    <mat-form-field class="inline-field" appearance="outline">
                      <input matInput [(ngModel)]="row.planNote" placeholder="" maxlength="30" (blur)="savePlanRow(row)" [disabled]="isSavingPlanRow(row.sourceKey)" />
                    </mat-form-field>
                    <button mat-icon-button class="duplicate-btn" (click)="duplicateRow(row)" [disabled]="isSavingPlanRow(row.sourceKey)" title="Satırı çoğalt">
                      <mat-icon>add</mat-icon>
                    </button>
                    @if (row.source === 'ingest-plan' || row.recordingPort || row.planNote) {
                      <button mat-icon-button class="delete-btn" (click)="deleteRow(row)" [disabled]="isSavingPlanRow(row.sourceKey)" [title]="row.source === 'ingest-plan' ? 'Satırı sil' : 'Port / açıklama kaydını temizle'">
                        <mat-icon>{{ row.source === 'ingest-plan' ? 'delete' : 'backspace' }}</mat-icon>
                      </button>
                    }
                  </div>
                </div>
              }
            </div>
          </div>
        }

      </div>
        </mat-tab>

        <mat-tab label="Port Görünümü">
          <ng-template matTabContent>
            <div class="port-board-page">
              <div class="port-board-date-bar">
                <mat-form-field class="port-board-date-picker">
                  <mat-label>Tarih</mat-label>
                  <input matInput [matDatepicker]="portBoardDatePicker"
                         [(ngModel)]="portBoardDateValue"
                         (dateChange)="onPortBoardDateChange($event.value)" />
                  <mat-datepicker-toggle matIconSuffix [for]="portBoardDatePicker"></mat-datepicker-toggle>
                  <mat-datepicker #portBoardDatePicker></mat-datepicker>
                </mat-form-field>
              </div>
              @if (portBoardLoadError()) {
                <div class="port-board-empty">
                  <h2>Yükleme Hatası</h2>
                  <p>{{ portBoardLoadError() }}</p>
                </div>
              } @else if (assignedPortColumns().length === 0) {
                <div class="port-board-empty">
                  <h2>Port Görünümü</h2>
                  <p>Seçili tarih için atanmış port bulunamadı.</p>
                </div>
              } @else {
                <app-ingest-port-board
                  [columns]="assignedPortColumns()"
                  [timeLabels]="portBoardTimeLabels()"
                  [gridTemplateRows]="timeGridTemplate()"
                  [fullPage]="true"
                  [columnMinWidth]="24"
                  [rowCount]="5"
                  (requestPrint)="printPortBoard()"
                  (portOrderChange)="setPortBoardOrder($event)"
                />
              }
            </div>
          </ng-template>
        </mat-tab>

        <mat-tab label="Ingest">
      <!-- Manuel Tetikleme -->
      <mat-expansion-panel class="trigger-panel">
        <mat-expansion-panel-header>
          <mat-panel-title>
            <mat-icon>add_circle_outline</mat-icon>&nbsp;Manuel Ingest Başlat
          </mat-panel-title>
        </mat-expansion-panel-header>

        <div class="trigger-form">
          <mat-form-field appearance="outline" class="path-field">
            <mat-label>Kaynak Dosya Yolu</mat-label>
            <input matInput [(ngModel)]="triggerPath" placeholder="/mnt/nas/video.mp4" />
          </mat-form-field>
          <button mat-flat-button color="primary" [disabled]="!triggerPath.trim() || triggering()"
                  (click)="triggerJob()">
            <mat-icon>cloud_upload</mat-icon>
            {{ triggering() ? 'Başlatılıyor…' : 'Başlat' }}
          </button>
        </div>
      </mat-expansion-panel>

      <!-- SCHED-B5a (Y5-7 + Domain Ownership LOCKED): "Canlı Yayın Planından
           Ingest Başlat" panel devre dışı. Backend ingest schedule coupling
           kaldırıldı (live_plan_entries.id bekler). Yeni canonical akış
           B5a follow-up PR'da live-plan'dan tetiklenecek; geçişte UI panel
           kapalı tutulur (kullanıcı 400 görmez). -->
      <mat-expansion-panel class="trigger-panel" [disabled]="true">
        <mat-expansion-panel-header>
          <mat-panel-title>
            <mat-icon>event_busy</mat-icon>&nbsp;Canlı Yayın Planından Ingest Başlat — geçici devre dışı (B5a)
          </mat-panel-title>
        </mat-expansion-panel-header>

        <p class="empty-live-plan">
          Bu akış canlı yayın plan canonical domain'ine taşınıyor; takip eden PR'da yeniden açılacak.
          Şimdilik manuel ingest tetikleme için yukarıdaki "Manuel Ingest Tetikle" panelini kullanın.
        </p>
      </mat-expansion-panel>

      <!-- Durum Sekmeleri -->
      <mat-tab-group (selectedIndexChange)="onTabChange($event)" class="status-tabs">
        @for (tab of statusTabs; track tab.value) {
          <mat-tab [label]="tab.label"></mat-tab>
        }
      </mat-tab-group>

      <!-- Tablo -->
      <mat-table [dataSource]="filteredJobs()">
        <ng-container matColumnDef="id">
          <mat-header-cell *matHeaderCellDef>#</mat-header-cell>
          <mat-cell *matCellDef="let j">{{ j.id }}</mat-cell>
        </ng-container>

        <ng-container matColumnDef="sourcePath">
          <mat-header-cell *matHeaderCellDef>Kaynak</mat-header-cell>
          <mat-cell *matCellDef="let j" class="mono">{{ j.sourcePath }}</mat-cell>
        </ng-container>

        <ng-container matColumnDef="status">
          <mat-header-cell *matHeaderCellDef>Durum</mat-header-cell>
          <mat-cell *matCellDef="let j">
            <span [class]="'status-badge ' + j.status">{{ j.status }}</span>
            @if (isActive(j.status)) {
              <mat-progress-bar mode="indeterminate" class="inline-progress"></mat-progress-bar>
            }
          </mat-cell>
        </ng-container>

        <ng-container matColumnDef="plan">
          <mat-header-cell *matHeaderCellDef>Plan Kaydı</mat-header-cell>
          <mat-cell *matCellDef="let j">
            @if (j.targetId) {
              <span>{{ j.metadata?.['scheduleTitle'] || ('#' + j.targetId) }}</span>
            } @else {
              <span>—</span>
            }
          </mat-cell>
        </ng-container>

        <ng-container matColumnDef="qc">
          <mat-header-cell *matHeaderCellDef>QC</mat-header-cell>
          <mat-cell *matCellDef="let j">
            @if (j.qcReport) {
              <mat-icon [style.color]="j.qcReport.passed ? '#4caf50' : '#f44336'">
                {{ j.qcReport.passed ? 'check_circle' : 'error' }}
              </mat-icon>
            } @else {
              <span>—</span>
            }
          </mat-cell>
        </ng-container>

        <ng-container matColumnDef="createdAt">
          <mat-header-cell *matHeaderCellDef>Oluşturulma</mat-header-cell>
          <mat-cell *matCellDef="let j">{{ j.createdAt | date:'dd.MM.yyyy HH:mm' }}</mat-cell>
        </ng-container>

        <ng-container matColumnDef="expand">
          <mat-header-cell *matHeaderCellDef></mat-header-cell>
          <mat-cell *matCellDef="let j">
            @if (j.qcReport) {
              <button mat-icon-button (click)="toggleDetail(j.id)">
                <mat-icon>{{ expandedId() === j.id ? 'expand_less' : 'expand_more' }}</mat-icon>
              </button>
            }
          </mat-cell>
        </ng-container>

        <mat-header-row *matHeaderRowDef="columns"></mat-header-row>
        <mat-row *matRowDef="let row; columns: columns" class="job-row"></mat-row>

        <!-- QC Detay Satırı -->
        @for (j of filteredJobs(); track j.id) {
          @if (j.qcReport && expandedId() === j.id) {
            <tr class="detail-row">
              <td [attr.colspan]="columns.length">
                <div class="qc-detail">
                  <div class="qc-grid">
                    <div class="qc-item"><span class="qc-label">Codec</span><span>{{ j.qcReport.codec }}</span></div>
                    <div class="qc-item"><span class="qc-label">Çözünürlük</span><span>{{ j.qcReport.resolution }}</span></div>
                    <div class="qc-item"><span class="qc-label">Süre</span><span>{{ j.qcReport.duration | number:'1.1-1' }}s</span></div>
                    <div class="qc-item"><span class="qc-label">FPS</span><span>{{ j.qcReport.frameRate }}</span></div>
                    <div class="qc-item"><span class="qc-label">Bitrate</span><span>{{ j.qcReport.bitrate }} kbps</span></div>
                    <div class="qc-item"><span class="qc-label">Loudness</span><span>{{ j.qcReport.loudness | number:'1.1-1' }} LUFS</span></div>
                  </div>
                  @if ((j.qcReport.errors?.length ?? 0) > 0) {
                    <div class="qc-errors">
                      <span class="qc-label">Hatalar:</span>
                      @for (e of j.qcReport.errors; track e) {
                        <mat-chip color="warn">{{ e }}</mat-chip>
                      }
                    </div>
                  }
                  @if ((j.qcReport.warnings?.length ?? 0) > 0) {
                    <div class="qc-warnings">
                      <span class="qc-label">Uyarılar:</span>
                      @for (w of j.qcReport.warnings; track w) {
                        <mat-chip>{{ w }}</mat-chip>
                      }
                    </div>
                  }
                  @if (j.proxyPath) {
                    <div class="qc-item"><span class="qc-label">Proxy</span><span class="mono">{{ j.proxyPath }}</span></div>
                  }
                </div>
              </td>
            </tr>
          }
        }
      </mat-table>

      <p class="total-label">Toplam: {{ total() }} iş</p>
        </mat-tab>
      </mat-tab-group>
    </div>
  `,
  styles: [`
    /* beINport UI V2 — page header + status badges + selected selectors restyle */
    .page-container  { padding: var(--bp-sp-6) var(--bp-sp-8) var(--bp-sp-8); }
    .page-header     { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--bp-sp-3); }
    .page-header h1  {
      margin: 0 0 4px;
      font-family: var(--bp-font-display);
      font-size: var(--bp-text-3xl);
      font-weight: var(--bp-fw-semibold);
      letter-spacing: var(--bp-ls-tight);
      color: var(--bp-fg-1);
    }
    .page-subtitle   { margin: 0; color: var(--bp-fg-3); font-size: 12.5px; }
    .header-actions  { display: flex; align-items: center; gap: 12px; }
    .auto-refresh-label { display: flex; align-items: center; gap: 4px; font-size: 0.85rem; opacity: 0.7; }
    .workspace-tabs  { margin-top: 10px; }
    .status-tabs     { margin-bottom: 16px; }
    .trigger-panel   { margin-bottom: 16px; }
    .trigger-form    { display: flex; align-items: center; gap: 16px; padding-top: 8px; }
    .path-field      { flex: 1; }
    .schedule-field  { flex: 1.4; min-width: 280px; }
    .live-plan-tools { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 8px; }
    .empty-live-plan { margin: 6px 0 0; color: var(--bp-fg-3); font-size: 0.85rem; }
    .planning-board { margin: 14px 0 18px; border: 1px solid var(--bp-line-2); background: rgba(255,255,255,0.03); border-radius: 8px; overflow: hidden; }
    .port-board-page { margin-top: 14px; }
    .port-board-date-bar { display: flex; align-items: center; gap: 12px; padding: 0 0 8px; }
    .port-board-date-picker { flex-shrink: 0; }
    .port-board-empty { min-height: calc(100vh - 260px); display: flex; flex-direction: column; justify-content: center; padding: 24px; border: 1px solid var(--bp-line-2); background: rgba(255,255,255,0.03); }
    .port-board-empty h2 { margin: 0 0 8px; }
    .port-board-empty p { margin: 0; color: var(--bp-fg-3); }
    .planning-board-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; border-bottom: 1px solid var(--bp-line-2); }
    .planning-board-header h2 { margin: 0; font-size: 1rem; }
    .planning-board-header p { margin: 2px 0 0; color: var(--bp-fg-3); font-size: 0.82rem; }
    .plan-filter-bar { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 14px 0; }
    .plan-filter-button { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 12px; border: 1px solid var(--bp-line); border-radius: 999px; background: var(--bp-bg-3); color: var(--bp-fg-2); cursor: pointer; transition: border-color var(--bp-dur-fast), background var(--bp-dur-fast); }
    .plan-filter-button:hover { border-color: var(--bp-purple-500); }
    .plan-filter-button span { min-width: 22px; padding: 2px 7px; border-radius: 999px; background: var(--bp-line-2); color: var(--bp-fg-1); font-size: 0.72rem; font-weight: 800; text-align: center; }
    .plan-filter-button.active { border-color: var(--bp-purple-500); background: rgba(124,58,237,0.14); color: var(--bp-fg-1); }
    .plan-filter-button.active span { background: var(--bp-purple-500); color: #fff; }
    .source-filter-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 14px 0; }
    .source-filter-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; color: var(--bp-fg-3); margin-right: 2px; }
    .source-filter-button { height: 28px; padding: 0 10px; border: 1px solid var(--bp-line); border-radius: 999px; background: transparent; color: var(--bp-fg-2); font-size: 0.78rem; cursor: pointer; transition: border-color var(--bp-dur-fast), background var(--bp-dur-fast); }
    .source-filter-button:hover { border-color: var(--bp-purple-500); }
    .source-filter-button.active { border-color: var(--bp-purple-500); background: rgba(124,58,237,0.14); color: var(--bp-fg-1); }
    .planning-tools { padding: 12px 14px 0; }
    .planning-table-wrap { overflow-x: auto; }
    .planning-table { min-width: 920px; }
    .content-cell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .content-meta { font-size: 0.72rem; color: var(--bp-fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .planning-head,
    .planning-row { display: grid; grid-template-columns: 116px 86px minmax(200px,1fr) 170px 170px minmax(170px,0.6fr); align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--bp-line-2); }
    .note-cell { display: flex; align-items: center; gap: 2px; }
    .note-cell .inline-field { flex: 1; }
    .duplicate-btn { flex-shrink: 0; width: 32px; height: 32px; line-height: 32px; color: #9bd3ff; }
    .delete-btn { flex-shrink: 0; width: 32px; height: 32px; line-height: 32px; color: #ef9a9a; }
    .time-edit { display: flex; flex-direction: column; gap: 2px; }
    .time-input { width: 80px; padding: 2px 3px; background: var(--bp-bg-2); border: 1px solid var(--bp-line); border-radius: 4px; color: var(--bp-fg-1); font-size: .8rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    .time-input:disabled { opacity: .45; }
    .source-pill.ingest-plan { color: #0d2b1a; background: #66bb6a; }
    .planning-head { color: var(--bp-fg-3); font-size: 0.72rem; font-weight: 700; text-transform: uppercase; }
    .planning-row { font-size: 0.86rem; }
    .planning-row:nth-child(odd) { background: rgba(255,255,255,0.025); }
    .source-pill { display: inline-flex; justify-content: center; padding: 4px 8px; border-radius: 999px; color: #04233d; background: #9bd3ff; font-size: 0.72rem; font-weight: 800; }
    .source-pill.studio { color: #2b1700; background: #ffd166; }
    .time-range { font-variant-numeric: tabular-nums; }
    .port-cell { display: grid; grid-template-columns: 10px 1fr; align-items: center; gap: 8px; }
    .port-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,0.26); }
    .port-cell.assigned .port-dot { background: #66bb6a; box-shadow: 0 0 0 3px rgba(102,187,106,0.14); }
    /* Aynı saat aralığında başka item'da kullanılan port — kullanıcıyı 409
       hatasından önce görsel olarak uyar (Material disabled grey üzerine
       turuncu vurgu). */
    ::ng-deep .mat-mdc-option.port-busy {
      color: #ff9800 !important;
      opacity: 0.7;
    }
    ::ng-deep .mat-mdc-option.port-busy .busy-tag {
      font-size: 0.72rem;
      color: #ff9800;
      margin-left: 4px;
    }
    .inline-field { width: 100%; }
    .inline-field ::ng-deep .mat-mdc-form-field-subscript-wrapper { display: none; }
    .inline-field ::ng-deep .mat-mdc-text-field-wrapper { height: 40px; }
    .inline-field ::ng-deep .mat-mdc-form-field-infix { min-height: 40px; padding-top: 8px; padding-bottom: 8px; }
    .mono            { font-family: monospace; font-size: 0.8rem; }
    .inline-progress { width: 80px; margin-left: 8px; }
    .total-label     { margin-top: 8px; font-size: 0.85rem; opacity: 0.7; }
    .job-row         { cursor: default; }

    .status-badge {
      padding: 3px 8px;
      border-radius: var(--bp-r-pill);
      font-size: 9.5px;
      font-weight: var(--bp-fw-bold);
      letter-spacing: var(--bp-ls-status);
      text-transform: uppercase;
    }
    .status-badge.PENDING    { background: rgba(107,114,128,0.20); color: var(--bp-fg-3); }
    .status-badge.PROCESSING { background: rgba(124,58,237,0.18); color: var(--bp-purple-300); }
    .status-badge.PROXY_GEN  { background: rgba(167,139,250,0.18); color: var(--bp-purple-300); }
    .status-badge.QC         { background: rgba(245,158,11,0.16); color: #fbbf24; }
    .status-badge.COMPLETED  { background: rgba(16,185,129,0.16); color: #6ee7b7; }
    .status-badge.FAILED     { background: rgba(239,68,68,0.18); color: #fca5a5; }

    .detail-row td   { padding: 0 !important; border: none; }
    .qc-detail       { padding: 12px 24px; background: rgba(255,255,255,0.04); border-radius: 4px; margin: 4px 0; }
    .qc-grid         { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 8px; }
    .qc-item         { display: flex; flex-direction: column; gap: 2px; min-width: 120px; }
    .qc-label        { font-size: 0.72rem; text-transform: uppercase; opacity: 0.55; }
    .qc-errors, .qc-warnings { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }

    .spin { animation: spin 1.2s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  `],
})
export class IngestListComponent implements OnInit, OnDestroy {
  columns          = ['id', 'sourcePath', 'status', 'plan', 'qc', 'createdAt', 'expand'];
  statusTabs       = STATUS_TABS;
  planFilters      = PLAN_FILTERS;
  sourceFilters    = SOURCE_FILTERS;
  planStatusOptions = PLAN_STATUS_OPTIONS;

  jobs        = signal<IngestJob[]>([]);
  livePlanCandidates = signal<Schedule[]>([]);
  /** 2026-05-11: live_plan_entries projeksiyonu (read-only). Tüm günlük
   *  entry'ler — channel/eventKey/schedule/job/planItem filtresi YOK. */
  liveEntryCandidates = signal<LivePlanIngestCandidate[]>([]);
  /** Channel catalog name resolve için. */
  channels = signal<Channel[]>([]);
  studioPlanSlots = signal<StudioPlanSlot[]>([]);
  ingestPlanItems = signal<IngestPlanItem[]>([]);
  recordingPorts = signal<RecordingPort[]>([]);
  portBoardOrder = signal<string[]>([]);
  savingPlanKeys = signal<Set<string>>(new Set());
  total       = signal(0);
  selectedTab = signal(0);
  planFilter   = signal<PlanFilter>('all');
  sourceFilter = signal<SourceFilter>('all');
  expandedId  = signal<number | null>(null);
  triggering  = signal(false);
  livePlanLoading = signal(false);
  studioPlanLoading = signal(false);
  triggerPath = '';
  livePlanDate = this.todayDate();
  livePlanDateValue = new Date(`${this.livePlanDate}T00:00:00`);
  selectedScheduleId: number | null = null;
  livePlanSourcePath = '';

  portBoardDate = signal<string>(this.todayDate());
  portBoardDateValue: Date = new Date(`${this.todayDate()}T00:00:00`);
  portBoardLivePlan = signal<Schedule[]>([]);
  portBoardStudioPlan = signal<StudioPlanSlot[]>([]);
  portBoardIngestItems = signal<IngestPlanItem[]>([]);
  portBoardLoadError = signal<string | null>(null);

  filteredJobs = computed(() => {
    const tab = STATUS_TABS[this.selectedTab()];
    if (!tab?.value) return this.jobs();
    if (tab.value === 'ACTIVE') return this.jobs().filter((j) => ACTIVE_STATUSES.has(j.status));
    return this.jobs().filter((j) => j.status === tab.value);
  });

  activeRecordingPorts = computed(() => this.recordingPorts().filter((port) => port.active));

  /** Her sourceKey için, "bu item dışındaki başka item'larda kullanılan ve
   *  saat aralığı çakışan" port adlarının seti. UI dropdown'larında o portları
   *  disable etmek için kullanılır — server 409'a düşmeden önce uyarı.
   *
   *  Not: ingestPlanItems() saved state. Mid-edit time değişikliğinde set
   *  güncel olmaz; ama time change'de savePlanRow tetiklendiği için bir sonraki
   *  CD cycle'da güncellenir. Live mid-edit feedback istenirse row.sortMinute/
   *  endMinute reactive yapılması gerekir (büyük refactor). */
  busyPortsMapByRow = computed<Map<string, Set<string>>>(() => {
    const items = this.ingestPlanItems();
    const map = new Map<string, Set<string>>();
    for (const target of items) {
      if (target.plannedStartMinute == null || target.plannedEndMinute == null) continue;
      const busy = new Set<string>();
      for (const other of items) {
        if (other.sourceKey === target.sourceKey) continue;
        if (other.dayDate !== target.dayDate) continue;
        if (other.plannedStartMinute == null || other.plannedEndMinute == null) continue;
        const overlap = other.plannedStartMinute < target.plannedEndMinute
                     && other.plannedEndMinute   > target.plannedStartMinute;
        if (!overlap) continue;
        if (other.recordingPort)        busy.add(other.recordingPort);
        if (other.backupRecordingPort)  busy.add(other.backupRecordingPort);
      }
      map.set(target.sourceKey, busy);
    }
    return map;
  });

  /** Bir row için belirli port'un başka item'da çakışıp çakışmadığı.
   *  Template'te [disabled] predicate'i içinde kullanılır. */
  isPortBusyForRow(sourceKey: string, portName: string): boolean {
    return this.busyPortsMapByRow().get(sourceKey)?.has(portName) ?? false;
  }

  planningRows = computed<IngestPlanRow[]>(() => {
    const planItemMap = new Map(this.ingestPlanItems().map((item) => [item.sourceKey, item]));

    // 2026-05-11: birincil kaynak — live_plan_entries doğrudan projeksiyon.
    // Tüm günlük entry'ler kanal/eventKey/job/planItem var-yok ayrımı olmadan
    // listelenir. Channel display: kanal yoksa veya katalogtan ad bulunamazsa
    // '—'.
    const liveEntryRows: IngestPlanRow[] = this.liveEntryCandidates().map((c) => {
      const startMin = this.sortMinuteFromDate(c.eventStartTime);
      const endMin   = this.sortMinuteFromDate(c.eventEndTime);
      const planMin  = c.planItem?.plannedStartMinute ?? startMin;
      const planEnd  = c.planItem?.plannedEndMinute   ?? endMin;
      return {
        id:                  `liveplan-${c.livePlanEntryId}`,
        source:              'live-plan' as const,
        sourceLabel:         'Canlı Yayın',
        sourceKey:           `liveplan:${c.livePlanEntryId}`,
        day:                 this.livePlanDate,
        sortMinute:          planMin,
        endMinute:           planEnd,
        startTime:           this.minuteToTime(planMin),
        endTime:             this.minuteToTime(planEnd),
        title:               c.title,
        location:            this.channelTripletNames(c.channel1Id, c.channel2Id, c.channel3Id),
        note:                c.leagueName ?? '—',
        recordingPort:       c.planItem?.recordingPort ?? '',
        backupRecordingPort: c.planItem?.backupRecordingPort ?? '',
        status: (c.planItem?.status as IngestPlanStatus | undefined)
              ?? (c.ingestJob ? this.deriveStatusFromJob(c.ingestJob.status) : 'WAITING'),
        planNote:            c.planItem?.note ?? '',
        jobId:               c.planItem?.jobId ?? c.ingestJob?.id ?? undefined,
        scheduleId:          c.scheduleId ?? undefined,
      };
    });

    // Mevcut schedule-kaynaklı candidate'lar (eski akış; sourceKey=`live:<scheduleId>`).
    // Duplicate guard: aynı schedule.id liveEntryCandidates.scheduleId'de varsa
    // yine yine (live-plan kaynağı önceliklidir; aynı entry/schedule iki kez görünmesin).
    const dupScheduleIds = new Set(
      this.liveEntryCandidates()
        .map((c) => c.scheduleId)
        .filter((id): id is number => id !== null),
    );
    const liveRows = this.livePlanCandidates()
      .filter((s) => !dupScheduleIds.has(s.id))
      .map((schedule) => {
      const planItem = planItemMap.get(`live:${schedule.id}`);
      const srcStart = this.sortMinuteFromDate(schedule.startTime);
      const srcEnd = this.sortMinuteFromDate(schedule.endTime);
      const startMin = planItem?.plannedStartMinute ?? srcStart;
      const endMin = planItem?.plannedEndMinute ?? srcEnd;
      return {
      id: `live-${schedule.id}`,
      source: 'live-plan' as const,
      sourceLabel: 'Canlı Yayın',
      sourceKey: `live:${schedule.id}`,
      day: this.livePlanDate,
      sortMinute: startMin,
      endMinute: endMin,
      startTime: this.minuteToTime(startMin),
      endTime: this.minuteToTime(endMin),
      title: this.scheduleTitle(schedule),
      location: schedule.channel?.name ?? '-',
      note: [schedule.reportLeague, schedule.reportSeason, schedule.reportWeekNumber ? `${schedule.reportWeekNumber}. Hafta` : '']
        .filter(Boolean)
        .join(' · ') || '-',
      recordingPort: planItem?.recordingPort ?? '',
      backupRecordingPort: planItem?.backupRecordingPort ?? '',
      status: planItem?.status ?? 'WAITING' as IngestPlanStatus,
      planNote: planItem?.note ?? '',
      jobId: planItem?.jobId,
      scheduleId: schedule.id,
      };
    });

    const manualRows: IngestPlanRow[] = this.ingestPlanItems()
      .filter((item) => item.sourceType === 'ingest-plan')
      .map((item) => {
        const parts = (item.sourcePath ?? '').split('\t');
        const srcLabel = parts[0] || 'Ingest Plan';
        const title    = parts.slice(1).join('\t') || 'Kopya';
        return {
          id: `ingest-plan-${item.sourceKey}`,
          source: 'ingest-plan' as const,
          sourceLabel: srcLabel,
          sourceKey: item.sourceKey,
          day: item.dayDate,
          sortMinute: item.plannedStartMinute ?? 0,
          endMinute: item.plannedEndMinute ?? 0,
          startTime: this.minuteToTime(item.plannedStartMinute ?? 0),
          endTime: this.minuteToTime(item.plannedEndMinute ?? 0),
          title,
          location: '',
          note: '',
          planNote: item.note ?? '',
          recordingPort: item.recordingPort ?? '',
          backupRecordingPort: item.backupRecordingPort ?? '',
          status: item.status,
          jobId: item.jobId,
        };
      });

    // 2026-05-11: liveEntryRows birincil; livePlanCandidates (schedule-kaynaklı)
    // duplicate guard sonrası geriye dönük olarak korunur.
    return [...liveEntryRows, ...liveRows, ...this.studioPlanRows(), ...manualRows]
      .sort((a, b) => a.sortMinute - b.sortMinute);
  });

  /** Channel id triplet → name string. Hepsi null/eksikse '—'. */
  private channelTripletNames(c1: number | null, c2: number | null, c3: number | null): string {
    const names = [c1, c2, c3]
      .map((id) => (id == null ? null : this.channels().find((ch) => ch.id === id)?.name ?? null))
      .filter((n): n is string => n !== null && n.length > 0);
    return names.length ? names.join(' / ') : '—';
  }

  /** ingest_jobs.status → IngestPlanStatus map (UI display için). */
  private deriveStatusFromJob(jobStatus: string): IngestPlanStatus {
    switch (jobStatus) {
      case 'PROCESSING': return 'INGEST_STARTED';
      case 'COMPLETED':  return 'COMPLETED';
      case 'FAILED':     return 'ISSUE';
      default:           return 'WAITING';
    }
  }

  filteredPlanningRows = computed<IngestPlanRow[]>(() => {
    let rows = this.planningRows();
    const filter = this.planFilter();

    if (filter === 'today') {
      const today = this.todayDate();
      rows = rows.filter((row) => row.day === today);
    } else if (filter === 'active') {
      rows = rows.filter((row) => ACTIVE_PLAN_STATUSES.has(row.status));
    } else if (filter === 'unassigned') {
      rows = rows.filter((row) => !row.recordingPort);
    } else if (filter === 'issues') {
      rows = rows.filter((row) => row.status === 'ISSUE');
    }

    const srcFilter = this.sourceFilter();
    if (srcFilter !== 'all') {
      rows = rows.filter((row) => row.sourceLabel === srcFilter);
    }

    return rows;
  });

  portBoardAllRows = computed<IngestPlanRow[]>(() => {
    const planItems = this.portBoardIngestItems();
    const planItemMap = new Map(planItems.map((item) => [item.sourceKey, item]));
    const date = this.portBoardDate();

    const liveRows = this.portBoardLivePlan().map((schedule) => {
      const planItem = planItemMap.get(`live:${schedule.id}`);
      const srcStart = this.sortMinuteFromDate(schedule.startTime);
      const srcEnd = this.sortMinuteFromDate(schedule.endTime);
      const startMin = planItem?.plannedStartMinute ?? srcStart;
      const endMin = planItem?.plannedEndMinute ?? srcEnd;
      return {
        id: `live-${schedule.id}`,
        source: 'live-plan' as const,
        sourceLabel: 'Canlı Yayın',
        sourceKey: `live:${schedule.id}`,
        day: date,
        sortMinute: startMin,
        endMinute: endMin,
        startTime: this.minuteToTime(startMin),
        endTime: this.minuteToTime(endMin),
        title: this.scheduleTitle(schedule),
        location: schedule.channel?.name ?? '-',
        note: [schedule.reportLeague, schedule.reportSeason, schedule.reportWeekNumber ? `${schedule.reportWeekNumber}. Hafta` : '']
          .filter(Boolean).join(' · ') || '-',
        recordingPort: planItem?.recordingPort ?? '',
      backupRecordingPort: planItem?.backupRecordingPort ?? '',
        status: planItem?.status ?? 'WAITING' as IngestPlanStatus,
        planNote: planItem?.note ?? '',
        jobId: planItem?.jobId,
        scheduleId: schedule.id,
      };
    });

    const studioSlots = [...this.portBoardStudioPlan()].sort((a, b) =>
      a.studio.localeCompare(b.studio, 'tr') || a.startMinute - b.startMinute || a.program.localeCompare(b.program, 'tr')
    );
    const studioRows: IngestPlanRow[] = [];
    const usedSlots = new Set<number>();
    for (let i = 0; i < studioSlots.length; i++) {
      if (usedSlots.has(i)) continue;
      const first = studioSlots[i];
      let endMinute = first.startMinute + 30;
      usedSlots.add(i);
      for (let j = i + 1; j < studioSlots.length; j++) {
        const next = studioSlots[j];
        if (usedSlots.has(j) || next.studio !== first.studio || next.program !== first.program || next.color !== first.color || next.startMinute !== endMinute) continue;
        endMinute += 30;
        usedSlots.add(j);
      }
      const sourceKey = `studio:${first.day}:${first.studio}:${first.startMinute}:${first.program}`;
      const planItem = planItemMap.get(sourceKey);
      const pbStartMin = planItem?.plannedStartMinute ?? first.startMinute;
      const pbEndMin = planItem?.plannedEndMinute ?? endMinute;
      studioRows.push({
        id: `studio-${first.day}-${first.studio}-${first.startMinute}-${first.program}`,
        source: 'studio-plan', sourceLabel: 'Stüdyo Planı', sourceKey,
        day: first.day, sortMinute: pbStartMin, endMinute: pbEndMin,
        startTime: this.minuteToTime(pbStartMin), endTime: this.minuteToTime(pbEndMin),
        title: first.program, location: first.studio, note: 'Stüdyo programı',
        planNote: planItem?.note ?? '', recordingPort: planItem?.recordingPort ?? '',
        backupRecordingPort: planItem?.backupRecordingPort ?? '',
        status: planItem?.status ?? 'WAITING', jobId: planItem?.jobId,
      });
    }

    const manualRows: IngestPlanRow[] = planItems
      .filter((item) => item.sourceType === 'ingest-plan')
      .map((item) => {
        const parts = (item.sourcePath ?? '').split('\t');
        return {
          id: `ingest-plan-${item.sourceKey}`,
          source: 'ingest-plan' as const, sourceLabel: parts[0] || 'Ingest Plan',
          sourceKey: item.sourceKey, day: item.dayDate,
          sortMinute: item.plannedStartMinute ?? 0, endMinute: item.plannedEndMinute ?? 0,
          startTime: this.minuteToTime(item.plannedStartMinute ?? 0), endTime: this.minuteToTime(item.plannedEndMinute ?? 0),
          title: parts.slice(1).join('\t') || 'Kopya', location: '', note: '',
          planNote: item.note ?? '', recordingPort: item.recordingPort ?? '',
          backupRecordingPort: item.backupRecordingPort ?? '',
          status: item.status, jobId: item.jobId,
        };
      });

    return [...liveRows, ...studioRows, ...manualRows].sort((a, b) => a.sortMinute - b.sortMinute);
  });

  portBoardRows = computed(() => this.portBoardAllRows().filter((row) => !!row.recordingPort));

  portBoardStartMinute = computed(() => {
    const rows = this.portBoardRows();
    if (rows.length === 0) return 8 * 60;
    const earliest = Math.min(...rows.map((row) => row.sortMinute));
    return Math.max(0, Math.floor(earliest / PORT_BOARD_SLOT_MINUTES) * PORT_BOARD_SLOT_MINUTES);
  });

  portBoardEndMinute = computed(() => {
    const rows = this.portBoardRows();
    if (rows.length === 0) return 10 * 60;
    const latest = Math.max(...rows.map((row) => row.endMinute));
    return Math.min(48 * 60, Math.max(this.portBoardStartMinute() + 60, Math.ceil(latest / PORT_BOARD_SLOT_MINUTES) * PORT_BOARD_SLOT_MINUTES));
  });

  portBoardTimeLabels = computed<IngestPortBoardTimeLabel[]>(() => {
    const items: IngestPortBoardTimeLabel[] = [];
    const startMinute = this.portBoardStartMinute();
    const endMinute = this.portBoardEndMinute();
    for (let minute = startMinute; minute < endMinute; minute += PORT_BOARD_SLOT_MINUTES * 2) {
      const rowStart = Math.floor((minute - startMinute) / PORT_BOARD_SLOT_MINUTES) + 1;
      items.push({
        label: this.minuteToTime(minute),
        gridRow: `${rowStart} / span 2`,
      });
    }
    return items;
  });

  assignedPortColumns = computed<IngestPortBoardColumnView[]>(() => {
    const configuredOrder = this.portBoardOrder();
    const defaultOrder = this.activeRecordingPorts().map((port) => port.name);
    const orderedNames = configuredOrder.length ? configuredOrder : defaultOrder;
    const portOrder = new Map(orderedNames.map((name, index) => [name, index]));
    const grouped = new Map<string, IngestPlanRow[]>();

    for (const row of this.portBoardAllRows()) {
      if (!row.recordingPort) continue;
      const rows = grouped.get(row.recordingPort) ?? [];
      rows.push(row);
      grouped.set(row.recordingPort, rows);
    }

    return orderedNames
      .filter((name) => this.activeRecordingPorts().some((port) => port.name === name))
      .filter((name) => !['Metus1', 'Metus2'].includes(name) || (grouped.get(name)?.length ?? 0) > 0)
      .map((port) => {
        const sourceRows = grouped.get(port) ?? [];
        return {
          port,
          items: this.toPortBoardItems(sourceRows),
          order: portOrder.get(port) ?? Number.MAX_SAFE_INTEGER,
        };
      })
      .sort((a, b) => a.order - b.order)
      .map(({ port, items }) => ({
        port,
        items,
      }));
  });

  hasActiveJobs = computed(() => this.jobs().some((j) => ACTIVE_STATUSES.has(j.status)));

  private pollSub?: Subscription;
  private planPollSub?: Subscription;
  private portBoardPollSub?: Subscription;

  constructor(private api: ApiService, private snack: MatSnackBar, private logger: LoggerService) {}

  ngOnInit() {
    // 2026-05-11: channel catalog (channel id → name resolve için).
    this.api.get<Channel[]>('/channels/catalog').subscribe({
      next: (res) => this.channels.set(Array.isArray(res) ? res : []),
    });

    this.loadLivePlanCandidates();
    this.loadRecordingPorts();
    this.load();
    // Poll every 5 s when there are active jobs; when no active jobs the computed signal
    // will show false and we skip the update silently (still fires but has no side-effect).
    this.pollSub = interval(5000)
      .pipe(switchMap(() => this.api.get<PaginatedResponse<IngestJob>>('/ingest?pageSize=200')))
      .subscribe((res) => {
        this.jobs.set(res.data);
        this.total.set(res.total);
      });

    this.planPollSub = interval(10000)
      .pipe(switchMap(() => this.api.get<IngestPlanItem[]>('/ingest/plan', { date: this.livePlanDate })))
      .subscribe({
        next: (items) => {
          const next = Array.isArray(items) ? items : [];
          const current = this.ingestPlanItems();
          if (JSON.stringify(next) !== JSON.stringify(current)) {
            this.ingestPlanItems.set(next);
            if (this.portBoardDate() === this.livePlanDate) {
              this.portBoardIngestItems.set(next);
            }
          }
        },
        error: () => this.portBoardLoadError.set('Ingest port görünümü güncellenemedi'),
      });

    this.loadPortBoardData(this.livePlanDate);
  }

  ngOnDestroy() {
    this.pollSub?.unsubscribe();
    this.planPollSub?.unsubscribe();
    this.portBoardPollSub?.unsubscribe();
  }

  load() {
    this.api.get<PaginatedResponse<IngestJob>>('/ingest?pageSize=200').subscribe((res) => {
      this.jobs.set(res.data);
      this.total.set(res.total);
    });
  }

  onTabChange(index: number) {
    this.selectedTab.set(index);
  }

  toggleDetail(id: number) {
    this.expandedId.set(this.expandedId() === id ? null : id);
  }

  isActive(status: string): boolean {
    return ACTIVE_STATUSES.has(status);
  }

  setPlanFilter(filter: PlanFilter) {
    this.planFilter.set(filter);
    if (filter === 'today') {
      const today = this.todayDate();
      if (this.livePlanDate !== today) {
        this.livePlanDate = today;
        this.livePlanDateValue = new Date(`${today}T00:00:00`);
        this.loadLivePlanCandidates();
      }
    }
  }

  onLivePlanDateChange(value: Date | null) {
    if (!value) return;
    this.livePlanDate = this.dateToInputValue(value);
    this.loadLivePlanCandidates();
  }

  setPortBoardOrder(nextOrder: string[]) {
    this.portBoardOrder.set(nextOrder);
  }

  onWorkspaceTabChange(index: number) {
    if (index === 1) this.startBurstPoll();
  }

  private startBurstPoll() {
    this.portBoardPollSub?.unsubscribe();
    this.portBoardPollSub = timer(0, 10000)
      .pipe(
        take(6),
        switchMap(() => this.api.get<IngestPlanItem[]>('/ingest/plan', { date: this.portBoardDate() })),
      )
      .subscribe({
        next: (items: IngestPlanItem[]) => {
          const next = Array.isArray(items) ? items : [];
          this.portBoardIngestItems.set(next);
        },
        error: (err: unknown) => {
          this.logger.error('Burst poll error', err);
        },
      });
  }

  onPortBoardDateChange(value: Date | null) {
    if (!value) return;
    const dateStr = this.dateToInputValue(value);
    this.portBoardDate.set(dateStr);
    this.portBoardDateValue = value;
    this.loadPortBoardData(dateStr);
  }

  loadPortBoardData(dateValue: string) {
    this.portBoardLoadError.set(null);
    const { from, to } = istanbulDayRangeUtc(dateValue);
    this.api.get<PaginatedResponse<Schedule>>('/schedules/ingest-candidates', { from, to, page: 1, pageSize: 200 }).subscribe({
      next: (res) => this.portBoardLivePlan.set(res.data ?? []),
      error: () => this.portBoardLoadError.set('Canlı yayın planı yüklenemedi'),
    });
    const weekStart = this.mondayFor(dateValue);
    this.api.get<StudioPlan>(`/studio-plans/${weekStart}`).subscribe({
      next: (plan) => this.portBoardStudioPlan.set((plan.slots ?? []).filter((slot) => slot.day === dateValue)),
      error: () => this.portBoardStudioPlan.set([]),
    });
    this.api.get<IngestPlanItem[]>('/ingest/plan', { date: dateValue }).subscribe({
      next: (items) => this.portBoardIngestItems.set(Array.isArray(items) ? items : []),
      error: () => this.portBoardLoadError.set('Ingest plan öğeleri yüklenemedi'),
    });
  }

  planFilterCount(filter: PlanFilter): number {
    const rows = this.planningRows();
    if (filter === 'today') {
      const today = this.todayDate();
      return rows.filter((row) => row.day === today).length;
    }
    if (filter === 'active') {
      return rows.filter((row) => ACTIVE_PLAN_STATUSES.has(row.status)).length;
    }
    if (filter === 'unassigned') {
      return rows.filter((row) => !row.recordingPort).length;
    }
    if (filter === 'issues') {
      return rows.filter((row) => row.status === 'ISSUE').length;
    }
    return rows.length;
  }

  timeGridTemplate(): string {
    return `repeat(${(this.portBoardEndMinute() - this.portBoardStartMinute()) / PORT_BOARD_SLOT_MINUTES}, minmax(28px, auto))`;
  }

  printPortBoard() {
    const columns = this.assignedPortColumns();
    if (columns.length === 0) {
      this.snack.open('Export icin atanmis port bulunamadi', 'Kapat', { duration: 3000 });
      return;
    }

    const times = this.portBoardTimeLabels();
    const columnRows = this.splitPortColumns(columns, 3);
    const gridTemplateRows = this.timeGridTemplate();
    const renderBoardRow = (rowColumns: IngestPortBoardColumnView[]) => {
      const gridTemplateColumns = `96px repeat(${rowColumns.length}, minmax(180px, 1fr))`;
      return `
      <section class="board" style="grid-template-columns:${gridTemplateColumns}">
        <div class="head">Saat</div>
        ${rowColumns.map((column) => `<div class="head">${this.escapeHtml(column.port)}</div>`).join('')}
        <div class="times">
          ${times.map((time) => `<div class="time" style="grid-row:${time.gridRow}">${time.label}</div>`).join('')}
        </div>
        ${rowColumns.map((column) => `
          <div class="col">
            ${times.map((time) => `<div class="line" style="grid-row:${time.gridRow}"></div>`).join('')}
            ${column.items.map((item) => `
              <div class="item ${item.overlap ? 'overlap' : ''}" style="grid-row:${item.gridRow}">
                <div class="t">${item.row.startTime} - ${item.row.endTime}</div>
                <div class="ttl">${this.escapeHtml(item.row.title)}</div>
                ${item.row.planNote ? `<div class="nt">${this.escapeHtml(item.row.planNote)}</div>` : ''}
                ${item.overlap ? '<div class="w">Cakisma</div>' : ''}
              </div>
            `).join('')}
          </div>
        `).join('')}
      </section>`;
    };
    const html = `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="utf-8">
    <title>Ingest Port Gorunumu</title>
    <style>
      @page { size: A3 landscape; margin: 0; }
      * { box-sizing: border-box; }
      body { font-family: Arial, sans-serif; margin: 0; padding: 0; color: #0f2740; }
      .sheet { width: 100%; }
      h1 { margin: 0 0 4px; font-size: 22px; }
      p { margin: 0 0 12px; color: #516579; font-size: 12px; }
      .board { display: grid; border: 1px solid #2c4360; margin-bottom: 8mm; }
      .head { min-height: 34px; display: flex; align-items: center; justify-content: center; padding: 6px; background: #203754; color: #f5d24b; font-weight: 700; border-right: 1px solid #2c4360; border-bottom: 1px solid #2c4360; font-size: 12px; }
      .head:first-child { color: #fff; }
      .times, .col { position: relative; display: grid; grid-template-rows: ${gridTemplateRows}; min-height: 940px; }
      .times { background: #eef3f8; border-right: 1px solid #2c4360; }
      .time { padding: 2px 6px; font-size: 11px; color: #2c4360; border-bottom: 1px solid #d2dde8; }
      .col { background: #f6f9fc; border-right: 1px solid #2c4360; }
      .line { border-bottom: 1px solid #d2dde8; }
      .item { margin: 2px; padding: 6px; border: 1px solid #93aac3; background: #c7d8ec; display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
      .item.studio { background: #dbe6f3; }
      .item.overlap { background: #ffe0e0; border-color: #d94242; }
      .t { font-size: 11px; font-weight: 700; }
      .ttl { font-size: 12px; font-weight: 700; line-height: 1.2; }
      .nt { font-size: 11px; font-weight: 600; color: #2a4a6a; }
      .m { font-size: 11px; }
      .w { font-size: 11px; font-weight: 700; color: #b71c1c; }
    </style>
  </head>
  <body>
    <div class="sheet">
    <h1>Ingest Port Gorunumu</h1>
    <p>${this.formatBoardDateLabel()}</p>
    ${columnRows.map((rowColumns) => renderBoardRow(rowColumns)).join('')}
    </div>
    <script>window.print();</script>
  </body>
</html>`;

    const popup = window.open('', '_blank', 'width=1600,height=900');
    if (!popup) {
      this.snack.open('Yazdirma penceresi acilamadi', 'Kapat', { duration: 4000 });
      return;
    }

    popup.document.open();
    popup.document.write(html);
    popup.document.close();
  }

  triggerJob() {
    const src = this.triggerPath.trim();
    if (!src) return;
    this.triggering.set(true);
    this.api.post<IngestJob>('/ingest', { sourcePath: src }).subscribe({
      next: (job) => {
        this.snack.open(`Ingest #${job.id} kuyruğa eklendi`, 'Kapat', { duration: 3000 });
        this.triggerPath = '';
        this.triggering.set(false);
        this.load();
      },
      error: (err) => {
        this.snack.open(`Hata: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
        this.triggering.set(false);
      },
    });
  }

  loadLivePlanCandidates() {
    const { from, to } = istanbulDayRangeUtc(this.livePlanDate);
    const scheduleParams: Record<string, string | number> = {
      from,
      to,
      page: 1,
      pageSize: 200,
    };

    this.livePlanLoading.set(true);
    this.loadStudioPlanForDate(this.livePlanDate);
    this.loadIngestPlanItems(this.livePlanDate);

    // 2026-05-11: yeni read-only projection — live_plan_entries doğrudan.
    // Tüm günlük entry'ler (channel/eventKey/job/planItem var-yok filtresi YOK).
    this.api.get<LivePlanIngestCandidate[]>('/ingest/live-plan-candidates', { date: this.livePlanDate }).subscribe({
      next: (rows) => this.liveEntryCandidates.set(Array.isArray(rows) ? rows : []),
      error: (err) => {
        this.liveEntryCandidates.set([]);
        this.snack.open(`Canlı yayın planı kayıtları alınamadı: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });

    // Mevcut schedule-kaynaklı candidate'lar (geriye dönük; duplicate guard'la birlikte korunur).
    this.api.get<PaginatedResponse<Schedule>>('/schedules/ingest-candidates', scheduleParams).subscribe({
      next: (res) => {
        this.livePlanCandidates.set(res.data ?? []);
        if (this.selectedScheduleId && !res.data.some((schedule) => schedule.id === this.selectedScheduleId)) {
          this.selectedScheduleId = null;
        }
        this.livePlanLoading.set(false);
      },
      error: (err) => {
        this.livePlanLoading.set(false);
        this.snack.open(`Canlı yayın planı alınamadı: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }

  private loadStudioPlanForDate(dateValue: string) {
    const weekStart = this.mondayFor(dateValue);
    this.studioPlanLoading.set(true);
    this.api.get<StudioPlan>(`/studio-plans/${weekStart}`).subscribe({
      next: (plan) => {
        this.studioPlanSlots.set((plan.slots ?? []).filter((slot) => slot.day === dateValue));
        this.studioPlanLoading.set(false);
      },
      error: (err) => {
        this.studioPlanSlots.set([]);
        this.studioPlanLoading.set(false);
        this.snack.open(`Stüdyo planı alınamadı: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }

  private loadIngestPlanItems(dateValue: string) {
    this.api.get<IngestPlanItem[]>('/ingest/plan', { date: dateValue }).subscribe({
      next: (items) => this.ingestPlanItems.set(Array.isArray(items) ? items : []),
      error: (err) => this.snack.open(`Ingest plan durumları alınamadı: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 }),
    });
  }

  private loadRecordingPorts() {
    this.api.get<RecordingPort[]>('/ingest/recording-ports').subscribe({
      next: (ports) => {
        const nextPorts = Array.isArray(ports) ? ports : [];
        this.recordingPorts.set(nextPorts);
        const validNames = new Set(nextPorts.filter((port) => port.active).map((port) => port.name));
        this.portBoardOrder.update((current) => {
          const preserved = current.filter((name) => validNames.has(name));
          const missing = nextPorts
            .filter((port) => port.active && !preserved.includes(port.name))
            .map((port) => port.name);
          return [...preserved, ...missing];
        });
      },
      error: (err) => this.snack.open(`Kayıt portları alınamadı: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 }),
    });
  }

  private studioPlanRows(): IngestPlanRow[] {
    const planItemMap = new Map(this.ingestPlanItems().map((item) => [item.sourceKey, item]));
    const slots = [...this.studioPlanSlots()].sort((a, b) => (
      a.studio.localeCompare(b.studio, 'tr')
      || a.startMinute - b.startMinute
      || a.program.localeCompare(b.program, 'tr')
    ));

    const rows: IngestPlanRow[] = [];
    const used = new Set<number>();

    for (let index = 0; index < slots.length; index++) {
      if (used.has(index)) continue;
      const first = slots[index];
      let endMinute = first.startMinute + 30;
      used.add(index);

      for (let nextIndex = index + 1; nextIndex < slots.length; nextIndex++) {
        const next = slots[nextIndex];
        if (
          used.has(nextIndex)
          || next.studio !== first.studio
          || next.program !== first.program
          || next.color !== first.color
          || next.startMinute !== endMinute
        ) {
          continue;
        }
        endMinute += 30;
        used.add(nextIndex);
      }

      const sourceKey = `studio:${first.day}:${first.studio}:${first.startMinute}:${first.program}`;
      const planItem = planItemMap.get(sourceKey);
      const startMin = planItem?.plannedStartMinute ?? first.startMinute;
      const endMin = planItem?.plannedEndMinute ?? endMinute;
      rows.push({
        id: `studio-${first.day}-${first.studio}-${first.startMinute}-${first.program}`,
        source: 'studio-plan',
        sourceLabel: 'Stüdyo Planı',
        sourceKey,
        day: first.day,
        sortMinute: startMin,
        endMinute: endMin,
        startTime: this.minuteToTime(startMin),
        endTime: this.minuteToTime(endMin),
        title: first.program,
        location: first.studio,
        note: 'Stüdyo programı',
        planNote: planItem?.note ?? '',
        recordingPort: planItem?.recordingPort ?? '',
      backupRecordingPort: planItem?.backupRecordingPort ?? '',
        status: planItem?.status ?? 'WAITING',
        jobId: planItem?.jobId,
      });
    }

    return rows;
  }

  private scheduleTitle(schedule: Schedule): string {
    const contentName = schedule.metadata?.['contentName'];
    return typeof contentName === 'string' && contentName.trim() ? contentName : schedule.title;
  }

  private formatTime(value: string): string {
    return formatIstanbulTime(value);
  }

  private minuteToTime(value: number): string {
    const hour = Math.floor(value / 60) % 24;
    const minute = value % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  private sortMinuteFromDate(value: string): number {
    const date = new Date(value);
    const minute = date.getHours() * 60 + date.getMinutes();
    return minute < 6 * 60 ? minute + 24 * 60 : minute;
  }

  private todayDate(): string {
    const date = new Date();
    return this.dateToInputValue(date);
  }

  private dateToInputValue(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  private mondayFor(dateValue: string): string {
    const date = new Date(`${dateValue}T00:00:00`);
    const day = date.getDay();
    const distanceFromMonday = day === 0 ? 6 : day - 1;
    date.setDate(date.getDate() - distanceFromMonday);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  isSavingPlanRow(sourceKey: string): boolean {
    return this.savingPlanKeys().has(sourceKey);
  }

  onStartTimeChange(row: IngestPlanRow, event: Event) {
    const value = (event.target as HTMLInputElement).value;
    if (!value) return;
    const [h, m] = value.split(':').map(Number);
    const sortMinute = Math.round((h * 60 + m) / 5) * 5;
    const startTime = this.minuteToTime(sortMinute);
    this.savePlanRow({ ...row, sortMinute, startTime });
  }

  onEndTimeChange(row: IngestPlanRow, event: Event) {
    const value = (event.target as HTMLInputElement).value;
    if (!value) return;
    const [h, m] = value.split(':').map(Number);
    const endMinute = Math.round((h * 60 + m) / 5) * 5;
    const endTime = this.minuteToTime(endMinute);
    this.savePlanRow({ ...row, endMinute, endTime });
  }

  deleteRow(row: IngestPlanRow) {
    this.api.delete<void>(`/ingest/plan/${encodeURIComponent(row.sourceKey)}`).subscribe({
      next: () => {
        this.ingestPlanItems.update((items) => items.filter((item) => item.sourceKey !== row.sourceKey));
        if (this.portBoardDate() === this.livePlanDate) {
          this.portBoardIngestItems.update((items) => items.filter((item) => item.sourceKey !== row.sourceKey));
        }
        const msg = row.source === 'ingest-plan' ? 'Satır silindi' : 'Port / açıklama kaydı temizlendi';
        this.snack.open(msg, 'Kapat', { duration: 2000 });
      },
      error: (err) => {
        this.snack.open(`Silme hatası: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }

  duplicateRow(row: IngestPlanRow) {
    const sourceKey = `ingest-plan:${row.day}:${row.sortMinute}:${row.endMinute}:${Date.now()}`;
    this.api.put<IngestPlanItem>(`/ingest/plan/${encodeURIComponent(sourceKey)}`, {
      sourceType: 'ingest-plan',
      day: row.day,
      sourcePath: `${row.sourceLabel}\t${row.title}`,
      plannedStartMinute: row.sortMinute,
      plannedEndMinute: row.endMinute,
      status: 'WAITING',
    }).subscribe({
      next: (item) => {
        this.ingestPlanItems.update((items) => [...items, item]);
        if (this.portBoardDate() === this.livePlanDate) {
          this.portBoardIngestItems.update((items) => [...items, item]);
        }
        this.startBurstPoll();
        this.snack.open('Satır çoğaltıldı', 'Kapat', { duration: 2000 });
      },
      error: (err) => {
        this.snack.open(`Çoğaltma hatası: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }

  savePlanRow(row: IngestPlanRow) {
    const existing = this.ingestPlanItems().find((item) => item.sourceKey === row.sourceKey);
    const portUnchanged = (existing?.recordingPort ?? '') === (row.recordingPort ?? '');
    const backupPortUnchanged = (existing?.backupRecordingPort ?? '') === (row.backupRecordingPort ?? '');
    const noteUnchanged = (existing?.note ?? '') === (row.planNote ?? '');
    const startUnchanged = existing?.plannedStartMinute != null ? existing.plannedStartMinute === row.sortMinute : false;
    const endUnchanged = existing?.plannedEndMinute != null ? existing.plannedEndMinute === row.endMinute : false;
    if (existing && portUnchanged && backupPortUnchanged && noteUnchanged && startUnchanged && endUnchanged) return;

    // Yedek port var ama ana port boş → backup'ı sıfırla (server'da da reddedilir
    // ama UI tutarlılığı için erken)
    if (!row.recordingPort && row.backupRecordingPort) {
      row.backupRecordingPort = '';
    }

    const nextSaving = new Set(this.savingPlanKeys());
    nextSaving.add(row.sourceKey);
    this.savingPlanKeys.set(nextSaving);

    this.api.put<IngestPlanItem>(`/ingest/plan/${encodeURIComponent(row.sourceKey)}`, {
      sourceType: row.source,
      day: row.day,
      ...(row.source === 'ingest-plan' ? { sourcePath: `${row.sourceLabel}\t${row.title}` } : {}),
      recordingPort: row.recordingPort || null,
      backupRecordingPort: row.backupRecordingPort || null,
      plannedStartMinute: row.sortMinute,
      plannedEndMinute: row.endMinute,
      status: row.status,
      note: row.planNote || null,
    }).subscribe({
      next: (item) => {
        this.ingestPlanItems.update((items) => {
          const otherItems = items.filter((current) => current.sourceKey !== item.sourceKey);
          return [...otherItems, item];
        });
        if (this.portBoardDate() === this.livePlanDate) {
          this.portBoardIngestItems.update((items) => {
            const otherItems = items.filter((current) => current.sourceKey !== item.sourceKey);
            return [...otherItems, item];
          });
        }
        this.startBurstPoll();
        this.savingPlanKeys.update((keys) => {
          const updated = new Set(keys);
          updated.delete(row.sourceKey);
          return updated;
        });
        this.snack.open('Ingest plan satırı kaydedildi', 'Kapat', { duration: 2000 });
      },
      error: (err) => {
        this.savingPlanKeys.update((keys) => {
          const updated = new Set(keys);
          updated.delete(row.sourceKey);
          return updated;
        });
        this.loadIngestPlanItems(row.day);
        this.snack.open(`Ingest plan satırı kaydedilemedi: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }

  triggerLivePlanJob() {
    const sourcePath = this.livePlanSourcePath.trim();
    const schedule = this.livePlanCandidates().find((item) => item.id === this.selectedScheduleId);
    if (!sourcePath || !schedule) return;

    this.triggering.set(true);
    // SCHED-B5a (Y5-7): ingest schedule coupling kaldırıldı; metadata.usageScope
    // ref kaldırılır. Backend ingest.service artık live_plan_entry.id bekler;
    // frontend "live-plan'dan ingest tetikleme" akışı ayrı PR follow-up.
    // Mevcut çağrıda schedule.id geçici olarak gönderilir; backend reddederse
    // operasyonel break (Y5-7 follow-up).
    this.api.post<IngestJob>('/ingest', {
      sourcePath,
      targetId: schedule.id,
      metadata: {
        source: 'live-plan',
        ingestPlanSourceKey: `live:${schedule.id}`,
        scheduleId: schedule.id,
        scheduleTitle: schedule.metadata?.['contentName'] || schedule.title,
        channelName: schedule.channel?.name ?? null,
        startTime: schedule.startTime,
      },
    }).subscribe({
      next: (job) => {
        this.snack.open(`Canlı yayın planı ingest #${job.id} kuyruğa eklendi`, 'Kapat', { duration: 3000 });
        this.livePlanSourcePath = '';
        this.selectedScheduleId = null;
        this.triggering.set(false);
        this.load();
      },
      error: (err) => {
        this.snack.open(`Hata: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
        this.triggering.set(false);
      },
    });
  }

  private toPortBoardItems(rows: IngestPlanRow[]): IngestPortBoardItemView[] {
    const boardStartMinute = this.portBoardStartMinute();
    const boardEndMinute = this.portBoardEndMinute();
    const sorted = [...rows]
      .map((row) => ({
        row,
        start: Math.max(row.sortMinute, boardStartMinute),
        end: Math.max(row.endMinute, row.sortMinute + PORT_BOARD_SLOT_MINUTES),
      }))
      .sort((a, b) => a.start - b.start || a.end - b.end || a.row.title.localeCompare(b.row.title, 'tr'));

    return sorted.map((current, index) => {
      const overlap = sorted.some((candidate, candidateIndex) => {
        if (candidateIndex === index) return false;
        return candidate.start < current.end && candidate.end > current.start;
      });
      const normalizedEnd = Math.min(Math.max(current.end, current.start + PORT_BOARD_SLOT_MINUTES), boardEndMinute);
      const gridRowStart = Math.floor((current.start - boardStartMinute) / PORT_BOARD_SLOT_MINUTES) + 1;
      const gridRowEnd = Math.ceil((normalizedEnd - boardStartMinute) / PORT_BOARD_SLOT_MINUTES) + 1;
      return {
        row: current.row,
        gridRow: `${gridRowStart} / ${Math.max(gridRowEnd, gridRowStart + 1)}`,
        overlap,
      };
    });
  }

  private formatBoardDateLabel(): string {
    // portBoardDate() = "YYYY-MM-DD" Türkiye-naive günü. String split yeter;
    // TZ dönüşümü gereksiz.
    const [y, m, d] = this.portBoardDate().split('-');
    return `${d}.${m}.${y}`;
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  private splitPortColumns(columns: IngestPortBoardColumnView[], rowCount: number): IngestPortBoardColumnView[][] {
    const chunkSize = Math.max(1, Math.ceil(columns.length / rowCount));
    const rows: IngestPortBoardColumnView[][] = [];
    for (let index = 0; index < columns.length; index += chunkSize) rows.push(columns.slice(index, index + chunkSize));
    return rows;
  }
}
