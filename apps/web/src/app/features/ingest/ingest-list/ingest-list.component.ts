import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatChipsModule } from '@angular/material/chips';
import { interval, Subscription } from 'rxjs';
import { switchMap } from 'rxjs/operators';

import { ApiService } from '../../../core/services/api.service';
import type {
  IngestJob,
  IngestPlanItem,
  IngestPlanStatus,
  PaginatedResponse,
  Schedule,
  StudioPlan,
  StudioPlanSlot,
} from '@bcms/shared';

interface Channel {
  id: number;
  name: string;
  type: string;
}

interface IngestPlanRow {
  id: string;
  source: 'live-plan' | 'studio-plan';
  sourceLabel: string;
  sourceKey: string;
  day: string;
  sortMinute: number;
  startTime: string;
  endTime: string;
  title: string;
  location: string;
  note: string;
  sourcePath: string;
  status: IngestPlanStatus;
  jobId?: number | null;
  scheduleId?: number;
}

const ACTIVE_STATUSES = new Set(['PENDING', 'PROCESSING', 'PROXY_GEN', 'QC']);

const STATUS_TABS: Array<{ label: string; value: string | null }> = [
  { label: 'Tümü',       value: null },
  { label: 'Aktif',      value: 'ACTIVE' },
  { label: 'Tamamlandı', value: 'COMPLETED' },
  { label: 'Başarısız',  value: 'FAILED' },
];

const PLAN_STATUS_OPTIONS: Array<{ label: string; value: IngestPlanStatus }> = [
  { label: 'Bekliyor', value: 'WAITING' },
  { label: 'Alındı', value: 'RECEIVED' },
  { label: 'Ingest Başladı', value: 'INGEST_STARTED' },
  { label: 'Tamamlandı', value: 'COMPLETED' },
  { label: 'Sorunlu', value: 'ISSUE' },
];


@Component({
  selector: 'app-ingest-list',
  standalone: true,
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
    MatExpansionModule,
    MatProgressBarModule,
    MatSnackBarModule,
    MatChipsModule,
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

      <div class="planning-board">
        <div class="planning-board-header">
          <div>
            <h2>Ingest Planı</h2>
            <p>Canlı yayın planı ve stüdyo planı kayıtları</p>
          </div>
          <span>{{ planningRows().length }} kayıt</span>
        </div>

        <div class="live-plan-tools planning-tools">
          <mat-form-field>
            <mat-label>Tarih</mat-label>
            <input matInput type="date" [(ngModel)]="livePlanDate" (change)="loadLivePlanCandidates()" />
          </mat-form-field>

          <mat-form-field>
            <mat-label>Kanal</mat-label>
            <mat-select [(ngModel)]="livePlanChannelId" (selectionChange)="loadLivePlanCandidates()">
              <mat-option [value]="null">Tüm kanallar</mat-option>
              @for (channel of channels(); track channel.id) {
                <mat-option [value]="channel.id">{{ channel.name }}</mat-option>
              }
            </mat-select>
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

        @if (planningRows().length > 0) {
          <div class="planning-table-wrap">
            <div class="planning-table">
              <div class="planning-head">
                <span>Kaynak</span>
                <span>Saat</span>
                <span>İçerik</span>
                <span>Kanal / Stüdyo</span>
                <span>Kaynak Dosya</span>
                <span>Durum</span>
                <span>Not</span>
                <span>İşlem</span>
              </div>

              @for (row of planningRows(); track row.id) {
                <div class="planning-row">
                  <span class="source-pill" [class.studio]="row.source === 'studio-plan'">{{ row.sourceLabel }}</span>
                  <strong class="time-range">{{ row.startTime }} - {{ row.endTime }}</strong>
                  <span>{{ row.title }}</span>
                  <span>{{ row.location }}</span>
                  <mat-form-field class="inline-field" appearance="outline">
                    <input matInput [(ngModel)]="row.sourcePath" placeholder="Kaynak dosya yolu" autocomplete="off" />
                  </mat-form-field>
                  <mat-form-field class="inline-status" appearance="outline">
                    <mat-select [(ngModel)]="row.status" (selectionChange)="savePlanRow(row)">
                      @for (option of planStatusOptions; track option.value) {
                        <mat-option [value]="option.value">{{ option.label }}</mat-option>
                      }
                    </mat-select>
                  </mat-form-field>
                  <span>{{ row.note }}</span>
                  <button mat-stroked-button class="row-save-button" (click)="savePlanRow(row)" [disabled]="isSavingPlanRow(row.sourceKey)">
                    <mat-icon>save</mat-icon>
                    Kaydet
                  </button>
                </div>
              }
            </div>
          </div>
        }
      </div>

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

      <mat-expansion-panel class="trigger-panel">
        <mat-expansion-panel-header>
          <mat-panel-title>
            <mat-icon>event_available</mat-icon>&nbsp;Canlı Yayın Planından Ingest Başlat
          </mat-panel-title>
        </mat-expansion-panel-header>

        <div class="trigger-form">
          <mat-form-field class="schedule-field">
            <mat-label>Canlı Yayın Planı Kaydı</mat-label>
            <mat-select [(ngModel)]="selectedScheduleId" [disabled]="livePlanLoading()">
              <mat-option [value]="null">— Seçin —</mat-option>
              @for (schedule of livePlanCandidates(); track schedule.id) {
                <mat-option [value]="schedule.id">
                  {{ schedule.startTime | date:'HH:mm' }} - {{ schedule.metadata?.['contentName'] || schedule.title }} · {{ schedule.channel?.name || '-' }}
                </mat-option>
              }
            </mat-select>
          </mat-form-field>

          <mat-form-field appearance="outline" class="path-field">
            <mat-label>Kaynak Dosya Yolu</mat-label>
            <input matInput [(ngModel)]="livePlanSourcePath" placeholder="/mnt/nas/video.mp4" />
          </mat-form-field>

          <button mat-flat-button color="primary"
                  [disabled]="!selectedScheduleId || !livePlanSourcePath.trim() || triggering()"
                  (click)="triggerLivePlanJob()">
            <mat-icon>cloud_upload</mat-icon>
            {{ triggering() ? 'Başlatılıyor…' : 'Başlat' }}
          </button>
        </div>

        @if (livePlanLoading()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        @if (!livePlanLoading() && livePlanCandidates().length === 0) {
          <p class="empty-live-plan">Seçili tarih için canlı yayın planı kaydı bulunamadı.</p>
        }
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
    </div>
  `,
  styles: [`
    .page-container  { max-width: 1380px; margin: 0 auto; }
    .page-header     { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .page-header h1  { margin-bottom: 2px; }
    .page-subtitle   { margin: 0; color: #9aa2b3; font-size: 0.9rem; }
    .header-actions  { display: flex; align-items: center; gap: 12px; }
    .auto-refresh-label { display: flex; align-items: center; gap: 4px; font-size: 0.85rem; opacity: 0.7; }
    .status-tabs     { margin-bottom: 16px; }
    .trigger-panel   { margin-bottom: 16px; }
    .trigger-form    { display: flex; align-items: center; gap: 16px; padding-top: 8px; }
    .path-field      { flex: 1; }
    .schedule-field  { flex: 1.4; min-width: 280px; }
    .live-plan-tools { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 8px; }
    .empty-live-plan { margin: 6px 0 0; color: #9aa2b3; font-size: 0.85rem; }
    .planning-board { margin: 14px 0 18px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.03); border-radius: 8px; overflow: hidden; }
    .planning-board-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.1); }
    .planning-board-header h2 { margin: 0; font-size: 1rem; }
    .planning-board-header p { margin: 2px 0 0; color: #9aa2b3; font-size: 0.82rem; }
    .planning-board-header span { color: #c8d3e5; font-size: 0.85rem; font-weight: 700; }
    .planning-tools { padding: 12px 14px 0; }
    .planning-table-wrap { overflow-x: auto; }
    .planning-table { min-width: 1120px; }
    .planning-head,
    .planning-row { display: grid; grid-template-columns: 126px 104px minmax(180px, 1fr) 120px minmax(210px, 1.05fr) 144px minmax(104px, 0.55fr) 104px; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .planning-head { color: #9aa2b3; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; }
    .planning-row { font-size: 0.86rem; }
    .planning-row:nth-child(odd) { background: rgba(255,255,255,0.025); }
    .source-pill { display: inline-flex; justify-content: center; padding: 4px 8px; border-radius: 999px; color: #04233d; background: #9bd3ff; font-size: 0.72rem; font-weight: 800; }
    .source-pill.studio { color: #2b1700; background: #ffd166; }
    .time-range { font-variant-numeric: tabular-nums; }
    .inline-field, .inline-status { width: 100%; }
    .inline-field ::ng-deep .mat-mdc-form-field-subscript-wrapper,
    .inline-status ::ng-deep .mat-mdc-form-field-subscript-wrapper { display: none; }
    .inline-field ::ng-deep .mat-mdc-text-field-wrapper,
    .inline-status ::ng-deep .mat-mdc-text-field-wrapper { height: 40px; }
    .inline-field ::ng-deep .mat-mdc-form-field-infix,
    .inline-status ::ng-deep .mat-mdc-form-field-infix { min-height: 40px; padding-top: 8px; padding-bottom: 8px; }
    .row-save-button { min-width: 96px; }
    .mono            { font-family: monospace; font-size: 0.8rem; }
    .inline-progress { width: 80px; margin-left: 8px; }
    .total-label     { margin-top: 8px; font-size: 0.85rem; opacity: 0.7; }
    .job-row         { cursor: default; }

    .status-badge {
      padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600;
    }
    .status-badge.PENDING    { background: #37474f; color: #cfd8dc; }
    .status-badge.PROCESSING { background: #1565c0; color: #fff; }
    .status-badge.PROXY_GEN  { background: #6a1b9a; color: #fff; }
    .status-badge.QC         { background: #e65100; color: #fff; }
    .status-badge.COMPLETED  { background: #2e7d32; color: #fff; }
    .status-badge.FAILED     { background: #b71c1c; color: #fff; }

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
  columns     = ['id', 'sourcePath', 'status', 'plan', 'qc', 'createdAt', 'expand'];
  statusTabs  = STATUS_TABS;
  planStatusOptions = PLAN_STATUS_OPTIONS;

  jobs        = signal<IngestJob[]>([]);
  channels    = signal<Channel[]>([]);
  livePlanCandidates = signal<Schedule[]>([]);
  studioPlanSlots = signal<StudioPlanSlot[]>([]);
  ingestPlanItems = signal<IngestPlanItem[]>([]);
  savingPlanKeys = signal<Set<string>>(new Set());
  total       = signal(0);
  selectedTab = signal(0);
  expandedId  = signal<number | null>(null);
  triggering  = signal(false);
  livePlanLoading = signal(false);
  studioPlanLoading = signal(false);
  triggerPath = '';
  livePlanDate = new Date().toISOString().slice(0, 10);
  livePlanChannelId: number | null = null;
  selectedScheduleId: number | null = null;
  livePlanSourcePath = '';

  filteredJobs = computed(() => {
    const tab = STATUS_TABS[this.selectedTab()];
    if (!tab?.value) return this.jobs();
    if (tab.value === 'ACTIVE') return this.jobs().filter((j) => ACTIVE_STATUSES.has(j.status));
    return this.jobs().filter((j) => j.status === tab.value);
  });

  planningRows = computed<IngestPlanRow[]>(() => {
    const planItemMap = new Map(this.ingestPlanItems().map((item) => [item.sourceKey, item]));
    const liveRows = this.livePlanCandidates().map((schedule) => ({
      id: `live-${schedule.id}`,
      source: 'live-plan' as const,
      sourceLabel: 'Canlı Yayın',
      sourceKey: `live:${schedule.id}`,
      day: this.livePlanDate,
      sortMinute: this.sortMinuteFromDate(schedule.startTime),
      startTime: this.formatTime(schedule.startTime),
      endTime: this.formatTime(schedule.endTime),
      title: this.scheduleTitle(schedule),
      location: schedule.channel?.name ?? '-',
      note: [schedule.reportLeague, schedule.reportSeason, schedule.reportWeekNumber ? `${schedule.reportWeekNumber}. Hafta` : '']
        .filter(Boolean)
        .join(' · ') || '-',
      sourcePath: planItemMap.get(`live:${schedule.id}`)?.sourcePath ?? '',
      status: planItemMap.get(`live:${schedule.id}`)?.status ?? 'WAITING' as IngestPlanStatus,
      jobId: planItemMap.get(`live:${schedule.id}`)?.jobId,
      scheduleId: schedule.id,
    }));

    return [...liveRows, ...this.studioPlanRows()].sort((a, b) => a.sortMinute - b.sortMinute);
  });

  hasActiveJobs = computed(() => this.jobs().some((j) => ACTIVE_STATUSES.has(j.status)));

  private pollSub?: Subscription;

  constructor(private api: ApiService, private snack: MatSnackBar) {}

  ngOnInit() {
    this.api.get<Channel[]>('/channels').subscribe({
      next: (channels) => this.channels.set(Array.isArray(channels) ? channels : []),
      error: () => this.snack.open('Kanal listesi alınamadı', 'Kapat', { duration: 4000 }),
    });
    this.loadLivePlanCandidates();
    this.load();
    // Poll every 5 s when there are active jobs; when no active jobs the computed signal
    // will show false and we skip the update silently (still fires but has no side-effect).
    this.pollSub = interval(5000)
      .pipe(switchMap(() => this.api.get<PaginatedResponse<IngestJob>>('/ingest?pageSize=200')))
      .subscribe((res) => {
        this.jobs.set(res.data);
        this.total.set(res.total);
      });
  }

  ngOnDestroy() {
    this.pollSub?.unsubscribe();
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
    const from = new Date(`${this.livePlanDate}T00:00:00+03:00`).toISOString();
    const to = new Date(`${this.livePlanDate}T23:59:59+03:00`).toISOString();
    const params: Record<string, string | number> = {
      from,
      to,
      page: 1,
      pageSize: 200,
      ...(this.livePlanChannelId ? { channelId: this.livePlanChannelId } : {}),
    };

    this.livePlanLoading.set(true);
    this.loadStudioPlanForDate(this.livePlanDate);
    this.loadIngestPlanItems(this.livePlanDate);
    this.api.get<PaginatedResponse<Schedule>>('/schedules/ingest-candidates', params).subscribe({
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
      rows.push({
        id: `studio-${first.day}-${first.studio}-${first.startMinute}-${first.program}`,
        source: 'studio-plan',
        sourceLabel: 'Stüdyo Planı',
        sourceKey,
        day: first.day,
        sortMinute: first.startMinute,
        startTime: this.minuteToTime(first.startMinute),
        endTime: this.minuteToTime(endMinute),
        title: first.program,
        location: first.studio,
        note: 'Stüdyo programı',
        sourcePath: planItem?.sourcePath ?? '',
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
    return new Intl.DateTimeFormat('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value));
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

  savePlanRow(row: IngestPlanRow) {
    const nextSaving = new Set(this.savingPlanKeys());
    nextSaving.add(row.sourceKey);
    this.savingPlanKeys.set(nextSaving);

    this.api.put<IngestPlanItem>(`/ingest/plan/${encodeURIComponent(row.sourceKey)}`, {
      sourceType: row.source,
      day: row.day,
      sourcePath: row.sourcePath.trim() || null,
      status: row.status,
    }).subscribe({
      next: (item) => {
        this.ingestPlanItems.update((items) => {
          const otherItems = items.filter((current) => current.sourceKey !== item.sourceKey);
          return [...otherItems, item];
        });
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
        this.snack.open(`Ingest plan satırı kaydedilemedi: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }

  triggerLivePlanJob() {
    const sourcePath = this.livePlanSourcePath.trim();
    const schedule = this.livePlanCandidates().find((item) => item.id === this.selectedScheduleId);
    if (!sourcePath || !schedule) return;

    this.triggering.set(true);
    this.api.post<IngestJob>('/ingest', {
      sourcePath,
      targetId: schedule.id,
      metadata: {
        usageScope: 'live-plan',
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
}
