import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatChipsModule } from '@angular/material/chips';
import { interval, Subscription } from 'rxjs';
import { switchMap } from 'rxjs/operators';

import { ApiService } from '../../../core/services/api.service';
import type { IngestJob, PaginatedResponse } from '@bcms/shared';

const ACTIVE_STATUSES = new Set(['PENDING', 'PROCESSING', 'PROXY_GEN', 'QC']);

const STATUS_TABS: Array<{ label: string; value: string | null }> = [
  { label: 'Tümü',       value: null },
  { label: 'Aktif',      value: 'ACTIVE' },
  { label: 'Tamamlandı', value: 'COMPLETED' },
  { label: 'Başarısız',  value: 'FAILED' },
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
    MatExpansionModule,
    MatProgressBarModule,
    MatSnackBarModule,
    MatChipsModule,
  ],
  template: `
    <div class="page-container">
      <div class="page-header">
        <h1>Ingest İşleri</h1>
        <div class="header-actions">
          <span class="auto-refresh-label" *ngIf="hasActiveJobs()">
            <mat-icon class="spin">sync</mat-icon> Otomatik yenileniyor…
          </span>
          <button mat-stroked-button (click)="load()">
            <mat-icon>refresh</mat-icon> Yenile
          </button>
        </div>
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
    .page-container  { max-width: 1100px; margin: 0 auto; }
    .page-header     { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .header-actions  { display: flex; align-items: center; gap: 12px; }
    .auto-refresh-label { display: flex; align-items: center; gap: 4px; font-size: 0.85rem; opacity: 0.7; }
    .status-tabs     { margin-bottom: 16px; }
    .trigger-panel   { margin-bottom: 16px; }
    .trigger-form    { display: flex; align-items: center; gap: 16px; padding-top: 8px; }
    .path-field      { flex: 1; }
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
  columns     = ['id', 'sourcePath', 'status', 'qc', 'createdAt', 'expand'];
  statusTabs  = STATUS_TABS;

  jobs        = signal<IngestJob[]>([]);
  total       = signal(0);
  selectedTab = signal(0);
  expandedId  = signal<number | null>(null);
  triggering  = signal(false);
  triggerPath = '';

  filteredJobs = computed(() => {
    const tab = STATUS_TABS[this.selectedTab()];
    if (!tab?.value) return this.jobs();
    if (tab.value === 'ACTIVE') return this.jobs().filter((j) => ACTIVE_STATUSES.has(j.status));
    return this.jobs().filter((j) => j.status === tab.value);
  });

  hasActiveJobs = computed(() => this.jobs().some((j) => ACTIVE_STATUSES.has(j.status)));

  private pollSub?: Subscription;

  constructor(private api: ApiService, private snack: MatSnackBar) {}

  ngOnInit() {
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
}
