import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { MatButtonToggleModule, type MatButtonToggleChange } from '@angular/material/button-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';
import { KeycloakService } from 'keycloak-angular';
import { ApiService } from '../../core/services/api.service';
import {
  GROUP,
  PROVYS_CATEGORIES,
  PROVYS_CATEGORY_STYLES,
  type AvidAsset,
  type ProvysCategory,
  type RestoreJobDto,
  type RestoreJobStatus,
  type SearchJobDto,
  type SearchJobStatus,
  type TransferJobDto,
  type TransferJobStatus,
} from '@bcms/shared';
import type { BcmsTokenParsed } from '../../core/types/auth';
import { isSkipAuthAllowed } from '../../core/auth/skip-auth';
import { ConfirmDialogComponent, type ConfirmDialogData } from '../live-plan/admin-lookups/confirm-dialog.component';
import { AvidAssetSelectionDialogComponent, type AvidAssetSelectionData } from './avid-asset-selection-dialog.component';
import { SearchService } from '../search/search.service';
import { RestoreService } from './restore.service';
import { TransferService } from '../transfer/transfer.service';

/**
 * 2026-05-28: Restore V2 — Üç kademeli Avid Interplay iş akışı.
 *
 *  Section 1 — Eksik Materyaller (V1 listesi). Her satıra 3 buton:
 *    [Ara]      (kademe 1: Avid arşivinde arama + operatör seçim)
 *    [Restore]  (kademe 2: arşivden Interplay workspace'e)
 *    [Transfer] (kademe 3: Interplay'den production storage'a)
 *
 *  Section 2 — Arama İşleri (provys_search_jobs).
 *  Section 3 — Restore İşleri (provys_restore_jobs).
 *  Section 4 — Transfer İşleri (provys_transfer_jobs).
 *
 *  Buton state machine:
 *   - Ara butonu: idle/NOT_FOUND/FAILED → enable; AWAITING_SELECTION → "Seçim
 *     Bekliyor" tıklanabilir (selection dialog açar); SELECTED → disable.
 *   - Restore: search SELECTED iken enable; sonra QUEUED/RUNNING/DONE/FAILED state'lerine göre label/disable.
 *   - Transfer: restore DONE iken enable; aynı state machine.
 *
 *  RBAC: yalnız Admin + SystemEng tetikleyebilir.
 *  Polling: 5sn `document.visibilityState='visible'` guard'ı ile 3 endpoint.
 */

interface RestoreRow {
  channelSlug: string;
  channelDisplayName: string;
  scheduleDate: string;
  startTimecode: string | null;
  startAt: string;
  dcCode: string;
  title: string;
  seriesName: string | null;
  durationTimecode: string | null;
  category: string;
  rawKind: string | null;
  eventId: string;
  ssdbStatus: string;
  ssdbLabel: string;
  /** SSDB cache satirinin son kontrol zamani (ISO). UI 'Son kontrol: X dk once'
   *  alt-yazisi icin; null ise henuz hicbir worker tick'i bu DC'yi sormamis. */
  lastCheckedAt: string | null;
}

interface RestoreResponse {
  date: string;
  rows: RestoreRow[];
}

type JobTone = 'idle' | 'queued' | 'running' | 'awaiting' | 'done' | 'failed' | 'not_found';

@Component({
  selector: 'app-restore',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonToggleModule, MatSnackBarModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="page-header">
        <div>
          <h1>Restore — Avid Interplay 3 Kademeli İş Akışı</h1>
          <p class="subtitle">
            Bugün ve gelecek eksik materyaller · Ara (K1) + Restore (K2) + Transfer (K3)
          </p>
        </div>
        <div class="actions">
          <button type="button" class="refresh" (click)="reload()" [disabled]="loading()">
            <span class="icon">↻</span> Yenile
          </button>
        </div>
      </header>

      <!-- Section 1 — Eksik Materyaller -->
      <section class="section">
        <h2 class="section-title">
          Eksik Materyaller
          <span class="section-count" *ngIf="!loading() && !errorMsg()">
            {{ visibleRows().length }}<span class="section-count-total" *ngIf="visibleRows().length !== rows().length"> / {{ rows().length }}</span>
          </span>
          <button
            type="button"
            class="bulk-refresh-btn"
            [class.spinning]="bulkRefreshing()"
            [disabled]="!canBulkRefresh()"
            [title]="bulkTooltip()"
            (click)="onBulkRefreshClick()"
            *ngIf="!loading() && !errorMsg() && rows().length > 0">
            <mat-icon class="material-icons-outlined">refresh</mat-icon>
            <span class="bulk-refresh-label">SSDB Toplu Yenile</span>
          </button>
        </h2>

        <!-- Kategori filtresi (Provys panel paritesi) -->
        <div class="cat-filter" *ngIf="!loading() && !errorMsg() && rows().length > 0">
          <mat-button-toggle-group
            multiple
            class="cat-toggle"
            [value]="selectedCategoryArray()"
            (change)="onCategoryToggle($event)"
            hideSingleSelectionIndicator="true"
            aria-label="Kategori filtresi"
          >
            @for (cat of categories; track cat) {
              <mat-button-toggle [value]="cat" [class]="'cat-toggle-btn cat-toggle--' + cat.toLowerCase()">
                <span class="cat-swatch" [style.background]="swatchColor(cat)"></span>
                <span class="cat-toggle-label">{{ categoryLabel(cat) }}</span>
              </mat-button-toggle>
            }
          </mat-button-toggle-group>
        </div>

        <div class="state" *ngIf="loading()">Yükleniyor…</div>
        <div class="state error" *ngIf="errorMsg()">{{ errorMsg() }}</div>

        <div class="state empty" *ngIf="!loading() && !errorMsg() && rows().length === 0">
          Bugün ve gelecek için SSDB'de eksik materyal yok.
        </div>

        <div class="state empty" *ngIf="!loading() && !errorMsg() && rows().length > 0 && visibleRows().length === 0">
          Seçili kategori filtreleriyle gösterilecek satır yok.
        </div>

        <div class="table-wrap" *ngIf="!loading() && !errorMsg() && visibleRows().length > 0">
        <table class="restore-list" role="grid" aria-label="Eksik materyal listesi">
          <thead>
            <tr>
              <th class="col-day">Gün</th>
              <th class="col-time">Saat</th>
              <th class="col-ch">Kanal</th>
              <th class="col-dc">DC Kod</th>
              <th class="col-title">Başlık</th>
              <th class="col-dur">Süre</th>
              <th class="col-cat">Kategori</th>
              <th class="col-ssdb">SSDB</th>
              <th class="col-action">Ara</th>
              <th class="col-action">Restore</th>
              <th class="col-action">Transfer</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let r of visibleRows(); trackBy: trackByEventId" class="row" [attr.data-channel]="r.channelSlug">
              <td class="col-day mono">{{ formatDay(r.scheduleDate) }}</td>
              <td class="col-time mono">{{ formatTime(r) }}</td>
              <td class="col-ch">
                <span class="ch-chip" [class]="'ch-chip ch-chip--' + r.channelSlug">{{ r.channelDisplayName }}</span>
              </td>
              <td class="col-dc mono">{{ r.dcCode }}</td>
              <td class="col-title" [title]="r.title">
                <div class="title-series" *ngIf="r.seriesName">{{ r.seriesName }}</div>
                <div class="title-text">{{ r.title }}</div>
              </td>
              <td class="col-dur mono">{{ r.durationTimecode ?? '—' }}</td>
              <td class="col-cat">{{ categoryLabel(r.category) }}</td>
              <td class="col-ssdb">
                <div class="ssdb-cell">
                  <span class="ssdb-badge ssdb-badge--missing">{{ r.ssdbLabel }}</span>
                  <button
                    type="button"
                    class="ssdb-refresh-btn"
                    [class.spinning]="isRefreshing(r)"
                    [disabled]="isRefreshing(r) || !canRefreshFor(r)"
                    [title]="canRefreshFor(r) ? (isRefreshing(r) ? 'Yenileniyor…' : 'SSDB cache yenile') : 'Yetki yok'"
                    [attr.aria-label]="'SSDB cache yenile: ' + r.dcCode"
                    (click)="onRefreshClick(r)">
                    <mat-icon class="material-icons-outlined">refresh</mat-icon>
                  </button>
                </div>
                <div class="last-checked" [title]="r.lastCheckedAt ?? ''">{{ formatLastChecked(r.lastCheckedAt) }}</div>
              </td>
              <td class="col-action">
                <button
                  type="button"
                  class="job-btn"
                  [class]="'job-btn job-btn--' + searchToneFor(r)"
                  [disabled]="!canClickSearchFor(r)"
                  [title]="searchTooltipFor(r)"
                  (click)="onSearchClick(r)"
                >{{ searchLabelFor(r) }}</button>
              </td>
              <td class="col-action">
                <button
                  type="button"
                  class="job-btn"
                  [class]="'job-btn job-btn--' + restoreToneFor(r)"
                  [disabled]="!canClickRestoreFor(r)"
                  [title]="restoreTooltipFor(r)"
                  (click)="onRestoreClick(r)"
                >{{ restoreLabelFor(r) }}</button>
              </td>
              <td class="col-action">
                <button
                  type="button"
                  class="job-btn"
                  [class]="'job-btn job-btn--' + transferToneFor(r)"
                  [disabled]="!canClickTransferFor(r)"
                  [title]="transferTooltipFor(r)"
                  (click)="onTransferClick(r)"
                >{{ transferLabelFor(r) }}</button>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </section>

      <!-- Section 2 — Arama İşleri -->
      <section class="section">
        <h2 class="section-title">
          Arama İşleri <span class="phase-chip">Kademe 1</span>
          <span class="section-count">{{ searchJobs().length }}</span>
        </h2>
        <div class="state empty" *ngIf="searchJobs().length === 0">Bugün ve gelecek için arama işi yok.</div>
        <div class="table-wrap" *ngIf="searchJobs().length > 0">
        <table class="job-list" role="grid" aria-label="Arama işleri">
          <thead>
            <tr>
              <th class="job-col-day">Gün</th>
              <th class="job-col-created">Oluşturuldu</th>
              <th class="job-col-dc">DC Kod</th>
              <th class="job-col-ch">Kanal</th>
              <th class="job-col-status">Durum</th>
              <th class="job-col-count">Sonuç</th>
              <th class="job-col-asset">Seçilen Asset</th>
              <th class="job-col-time">Başladı</th>
              <th class="job-col-time">Bitti</th>
              <th class="job-col-err">Hata</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let j of searchJobs(); trackBy: trackByJobId">
              <td class="mono">{{ formatDay(j.scheduleDate) }}</td>
              <td class="mono">{{ formatTs(j.createdAt) }}</td>
              <td class="mono">{{ j.dcCode }}</td>
              <td>{{ j.channelSlug }}</td>
              <td><span class="status-badge" [class]="'status-badge status-badge--' + searchToneForStatus(j.status)">{{ searchStatusLabel(j.status) }}</span></td>
              <td class="mono">{{ j.avidAssets?.length ?? '—' }}</td>
              <td [title]="j.selectedAssetId ?? ''">
                {{ j.selectedAssetName ?? '—' }}
                @if (j.selectedAssetOnline !== null) {
                  <span class="online-badge" [class.online-badge--on]="j.selectedAssetOnline" [class.online-badge--off]="!j.selectedAssetOnline">{{ j.selectedAssetOnline ? 'Online' : 'Offline' }}</span>
                }
              </td>
              <td class="mono">{{ formatTs(j.startedAt) }}</td>
              <td class="mono">{{ formatTs(j.finishedAt) }}</td>
              <td class="job-col-err" [title]="j.errorMsg ?? ''">{{ j.errorMsg ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
        </div>
      </section>

      <!-- Section 3 — Restore İşleri -->
      <section class="section">
        <h2 class="section-title">
          Restore İşleri <span class="phase-chip">Kademe 2</span>
          <span class="section-count">{{ restoreJobs().length }}</span>
        </h2>
        <div class="state empty" *ngIf="restoreJobs().length === 0">Bugün ve gelecek için restore işi yok.</div>
        <div class="table-wrap" *ngIf="restoreJobs().length > 0">
        <table class="job-list" role="grid" aria-label="Restore işleri">
          <thead>
            <tr>
              <th class="job-col-day">Gün</th>
              <th class="job-col-created">Oluşturuldu</th>
              <th class="job-col-dc">DC Kod</th>
              <th class="job-col-ch">Kanal</th>
              <th class="job-col-status">Durum</th>
              <th class="job-col-asset">Asset</th>
              <th class="job-col-att">Deneme</th>
              <th class="job-col-time">Başladı</th>
              <th class="job-col-time">Bitti</th>
              <th class="job-col-err">Hata</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let j of restoreJobs(); trackBy: trackByJobId">
              <td class="mono">{{ formatDay(j.scheduleDate) }}</td>
              <td class="mono">{{ formatTs(j.createdAt) }}</td>
              <td class="mono">{{ j.dcCode }}</td>
              <td>{{ j.channelSlug }}</td>
              <td><span class="status-badge" [class]="'status-badge status-badge--' + restoreToneForStatus(j.status)">{{ restoreStatusLabel(j.status) }}</span></td>
              <td [title]="j.avidAssetId ?? ''">
                {{ j.avidAssetName ?? '—' }}
                @if (j.avidAssetOnline !== null) {
                  <span class="online-badge" [class.online-badge--on]="j.avidAssetOnline" [class.online-badge--off]="!j.avidAssetOnline">{{ j.avidAssetOnline ? 'Online' : 'Offline' }}</span>
                }
              </td>
              <td class="mono">{{ j.attemptCount }}/{{ j.maxAttempts }}</td>
              <td class="mono">{{ formatTs(j.startedAt) }}</td>
              <td class="mono">{{ formatTs(j.finishedAt) }}</td>
              <td class="job-col-err" [title]="j.errorMsg ?? ''">{{ j.errorMsg ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
        </div>
      </section>

      <!-- Section 4 — Transfer İşleri -->
      <section class="section">
        <h2 class="section-title">
          Transfer İşleri <span class="phase-chip">Kademe 3</span>
          <span class="section-count">{{ transferJobs().length }}</span>
        </h2>
        <div class="state empty" *ngIf="transferJobs().length === 0">Bugün ve gelecek için transfer işi yok.</div>
        <div class="table-wrap" *ngIf="transferJobs().length > 0">
        <table class="job-list" role="grid" aria-label="Transfer işleri">
          <thead>
            <tr>
              <th class="job-col-day">Gün</th>
              <th class="job-col-created">Oluşturuldu</th>
              <th class="job-col-dc">DC Kod</th>
              <th class="job-col-ch">Kanal</th>
              <th class="job-col-status">Durum</th>
              <th class="job-col-asset">Asset</th>
              <th class="job-col-att">Deneme</th>
              <th class="job-col-time">Başladı</th>
              <th class="job-col-time">Bitti</th>
              <th class="job-col-err">Hata</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let j of transferJobs(); trackBy: trackByJobId">
              <td class="mono">{{ formatDay(j.scheduleDate) }}</td>
              <td class="mono">{{ formatTs(j.createdAt) }}</td>
              <td class="mono">{{ j.dcCode }}</td>
              <td>{{ j.channelSlug }}</td>
              <td><span class="status-badge" [class]="'status-badge status-badge--' + transferToneForStatus(j.status)">{{ transferStatusLabel(j.status) }}</span></td>
              <td [title]="j.avidAssetId ?? ''">
                {{ j.avidAssetName ?? '—' }}
                @if (j.avidAssetOnline !== null) {
                  <span class="online-badge" [class.online-badge--on]="j.avidAssetOnline" [class.online-badge--off]="!j.avidAssetOnline">{{ j.avidAssetOnline ? 'Online' : 'Offline' }}</span>
                }
              </td>
              <td class="mono">{{ j.attemptCount }}/{{ j.maxAttempts }}</td>
              <td class="mono">{{ formatTs(j.startedAt) }}</td>
              <td class="mono">{{ formatTs(j.finishedAt) }}</td>
              <td class="job-col-err" [title]="j.errorMsg ?? ''">{{ j.errorMsg ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
        </div>
      </section>
    </section>
  `,
  styles: [`
    :host { display: block; color: var(--bp-fg-1); }
    .page { display: flex; flex-direction: column; gap: 18px; padding: 16px 18px; }
    .page-header {
      display: flex; align-items: flex-end; justify-content: space-between;
      gap: 16px; flex-wrap: wrap;
    }
    .page-header h1 { margin: 0; font-size: 22px; font-weight: 600; }
    .subtitle { margin: 4px 0 0; color: var(--bp-fg-3); font-size: 12px; }
    .actions { display: flex; align-items: center; gap: 12px; }
    .refresh {
      padding: 6px 12px; background: rgba(124, 58, 237, 0.18); color: var(--bp-acc-purple);
      border: 1px solid rgba(124, 58, 237, 0.40); border-radius: 5px;
      font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    }
    .refresh:hover { background: rgba(124, 58, 237, 0.30); }
    .refresh:disabled { opacity: 0.6; cursor: not-allowed; }
    .refresh .icon { font-size: 14px; }

    .section { display: flex; flex-direction: column; gap: 8px; }
    .section-title {
      margin: 0; font-size: 14px; font-weight: 600; color: var(--bp-fg-2);
      display: flex; align-items: center; gap: 10px;
    }
    .section-count {
      font-size: 11px; font-weight: 600; padding: 1px 8px;
      border-radius: var(--bp-r-pill, 999px);
      background: rgba(99, 102, 241, 0.18); color: var(--bp-acc-indigo);
      border: 1px solid rgba(99, 102, 241, 0.35);
    }
    .section-count-total { color: var(--bp-fg-3); font-weight: 500; }

    /* Sira 6 — Toplu SSDB yenile butonu (section basligi sagina pus) */
    .bulk-refresh-btn {
      margin-left: auto;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px;
      background: rgba(99, 102, 241, 0.12);
      border: 1px solid rgba(99, 102, 241, 0.32);
      border-radius: 6px;
      color: var(--bp-acc-indigo);
      font: inherit; font-size: 11.5px; font-weight: 600;
      cursor: pointer;
      transition: background-color 120ms, border-color 120ms, color 120ms;
    }
    .bulk-refresh-btn:hover:not(:disabled) {
      background: rgba(99, 102, 241, 0.22);
      border-color: rgba(99, 102, 241, 0.55);
      color: #c7d2fe;
    }
    .bulk-refresh-btn:disabled {
      opacity: 0.45; cursor: not-allowed;
    }
    .bulk-refresh-btn mat-icon {
      font-size: 16px; width: 16px; height: 16px; line-height: 16px;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .bulk-refresh-btn.spinning mat-icon {
      animation: ssdb-spin 900ms linear infinite;
    }
    .bulk-refresh-label { letter-spacing: 0.02em; }
    @media (max-width: 720px) {
      .bulk-refresh-label { display: none; }
      .bulk-refresh-btn { padding: 4px 8px; }
    }

    /* Kategori filtresi — Provys panel paritesi */
    .cat-filter { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .cat-toggle {
      display: inline-flex; flex-wrap: wrap; gap: 4px;
      background: transparent; border: none;
    }
    .cat-toggle ::ng-deep .mat-button-toggle {
      background: var(--bp-bg-2); color: var(--bp-fg-2);
      border: 1px solid var(--bp-line-2); border-radius: var(--bp-r-pill, 999px);
      font-size: 11.5px; font-weight: 600; line-height: 1.4;
      padding: 0 2px;
    }
    .cat-toggle ::ng-deep .mat-button-toggle-button { padding: 0 6px; }
    .cat-toggle ::ng-deep .mat-button-toggle-label-content {
      display: inline-flex; align-items: center; gap: 6px;
      line-height: 26px; padding: 0 6px;
    }
    .cat-toggle ::ng-deep .mat-button-toggle.mat-button-toggle-checked {
      background: rgba(124, 58, 237, 0.20); color: #ddd6fe;
      border-color: rgba(124, 58, 237, 0.55);
    }
    :host-context(html[data-theme="light"]) .cat-toggle ::ng-deep .mat-button-toggle.mat-button-toggle-checked {
      background: rgba(124, 58, 237, 0.14); color: #4c1d95; border-color: #7c3aed;
    }
    .cat-swatch {
      display: inline-block; width: 10px; height: 10px; border-radius: 50%;
      flex-shrink: 0;
    }
    .cat-toggle-label { white-space: nowrap; }

    .phase-chip {
      font-size: 10.5px; font-weight: 600; padding: 1px 7px;
      border-radius: var(--bp-r-pill, 999px);
      background: rgba(124, 58, 237, 0.15); color: var(--bp-acc-purple);
      border: 1px solid rgba(124, 58, 237, 0.35);
      letter-spacing: 0.04em;
    }

    .state {
      padding: 24px; text-align: center; color: var(--bp-fg-3); font-size: 13px;
      border: 1px solid var(--bp-line-2); border-radius: 6px; background: var(--bp-bg-2);
    }
    .state.error { color: #fca5a5; border-color: rgba(239, 68, 68, 0.40); background: rgba(239, 68, 68, 0.08); }
    .state.empty { color: var(--bp-fg-4); padding: 16px; }

    /* Tablo wrapper: dar viewport'ta yatay scroll (sayfa shift olmasın) */
    .table-wrap {
      width: 100%; overflow-x: auto;
      border: 1px solid var(--bp-line-2); border-radius: 6px;
      background: var(--bp-bg-2);
    }
    table.restore-list, table.job-list {
      width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12.5px;
      background: var(--bp-bg-2);
      min-width: 1240px; /* tüm kolonlar sığsın; dar viewport'ta wrap yatay scroll */
    }
    thead th {
      position: sticky; top: 0; z-index: 1; background: var(--bp-bg-3);
      color: var(--bp-fg-2); font-weight: 600; text-align: left;
      padding: 8px 10px; border-bottom: 1px solid var(--bp-line);
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em;
    }
    tbody td {
      padding: 6px 10px; border-bottom: 1px solid var(--bp-line-2);
      line-height: 1.35; color: var(--bp-fg-1);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .mono { font-family: var(--bp-font-mono, ui-monospace, 'JetBrains Mono', Menlo, monospace); font-variant-numeric: tabular-nums; }

    /* Section 1 — Eksik Materyaller kolon genişlikleri (today-future scope) */
    .col-day  { width: 98px;  color: var(--bp-fg-2); }
    .col-time { width: 76px; }
    .col-ch   { width: 110px; }
    .col-dc   { width: 110px; color: var(--bp-fg-2); }
    .col-title { white-space: normal; }
    .col-title .title-series { font-size: 10.5px; color: var(--bp-fg-3); letter-spacing: 0.04em; margin-bottom: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .col-title .title-text { color: var(--bp-fg-1); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .col-dur  { width: 114px; color: var(--bp-fg-2); }
    .col-cat  { width: 100px; color: var(--bp-fg-2); }
    .col-ssdb { width: 132px; }
    .col-action { width: 100px; text-align: center; padding: 4px 4px; }

    /* Job tabloları */
    .job-col-day     { width: 98px;  color: var(--bp-fg-2); }
    .job-col-created { width: 130px; }
    .job-col-dc      { width: 100px; color: var(--bp-fg-2); }
    .job-col-ch      { width: 100px; color: var(--bp-fg-2); }
    .job-col-status  { width: 130px; }
    .job-col-count   { width: 70px;  color: var(--bp-fg-3); }
    .job-col-asset   { white-space: normal; color: var(--bp-fg-2); font-size: 11.5px; }
    .job-col-att     { width: 70px;  color: var(--bp-fg-3); }
    .job-col-time    { width: 130px; color: var(--bp-fg-3); }
    .job-col-err     { white-space: normal; color: #fca5a5; font-size: 11.5px; }

    .ch-chip {
      display: inline-block; padding: 2px 8px; border-radius: var(--bp-r-pill, 999px);
      font-size: 11px; font-weight: 600; line-height: 1.4;
      background: rgba(99, 102, 241, 0.16); color: var(--bp-acc-indigo);
      border: 1px solid rgba(99, 102, 241, 0.35);
    }
    .ssdb-badge {
      display: inline-block; padding: 1px 8px; border-radius: var(--bp-r-pill, 999px);
      font-size: 11px; font-weight: 600; line-height: 1.5;
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      border: 1px solid transparent;
    }
    .ssdb-badge--missing {
      background: rgba(239, 68, 68, 0.20); color: #fca5a5; border-color: rgba(239, 68, 68, 0.45);
    }
    .last-checked {
      margin-top: 3px;
      font-size: 10.5px;
      color: var(--bp-fg-3);
      letter-spacing: 0.02em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* Manuel SSDB cache yenile butonu — badge yanı, kompakt ikon */
    .ssdb-cell {
      display: flex; align-items: center; gap: 6px;
    }
    .ssdb-refresh-btn {
      flex: 0 0 auto;
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; padding: 0;
      background: transparent; border: 1px solid rgba(148, 163, 184, 0.25);
      border-radius: 50%;
      color: var(--bp-fg-3); cursor: pointer;
      transition: background-color 120ms, color 120ms, border-color 120ms;
    }
    .ssdb-refresh-btn:hover:not(:disabled) {
      background: rgba(148, 163, 184, 0.15);
      color: var(--bp-fg-1);
      border-color: rgba(148, 163, 184, 0.55);
    }
    .ssdb-refresh-btn:disabled {
      opacity: 0.45; cursor: not-allowed;
    }
    .ssdb-refresh-btn mat-icon {
      font-size: 16px; width: 16px; height: 16px;
      line-height: 16px;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .ssdb-refresh-btn.spinning mat-icon {
      animation: ssdb-spin 900ms linear infinite;
    }
    @keyframes ssdb-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }

    /* Status badge */
    .status-badge {
      display: inline-block; padding: 1px 8px; border-radius: var(--bp-r-pill, 999px);
      font-size: 11px; font-weight: 600; line-height: 1.5; border: 1px solid transparent;
    }
    .status-badge--queued    { background: rgba(156, 163, 175, 0.18); color: #d1d5db; border-color: rgba(156, 163, 175, 0.40); font-style: italic; }
    .status-badge--running   { background: rgba(245, 158, 11, 0.20);  color: #fcd34d; border-color: rgba(245, 158, 11, 0.50); }
    .status-badge--awaiting  { background: rgba(168, 85, 247, 0.22);  color: #d8b4fe; border-color: rgba(168, 85, 247, 0.55); }
    .status-badge--done      { background: rgba(16, 185, 129, 0.20);  color: var(--bp-acc-green); border-color: rgba(16, 185, 129, 0.50); }
    .status-badge--failed    { background: rgba(239, 68, 68, 0.22);   color: #fca5a5; border-color: rgba(239, 68, 68, 0.55); }
    .status-badge--not_found { background: rgba(249, 115, 22, 0.22);  color: #fdba74; border-color: rgba(249, 115, 22, 0.55); }
    .status-badge--idle      { background: rgba(107, 114, 128, 0.14); color: #9ca3af; border-color: rgba(107, 114, 128, 0.30); }

    /* Avid asset online/offline rozeti — selection dialog + job tablolarında ortak */
    .online-badge {
      display: inline-block; margin-left: 6px;
      padding: 1px 6px; border-radius: var(--bp-r-pill, 999px);
      font-size: 10px; font-weight: 600; line-height: 1.4;
      border: 1px solid transparent; letter-spacing: 0.04em;
      vertical-align: middle;
    }
    .online-badge--on  { background: rgba(16, 185, 129, 0.20); color: var(--bp-acc-green); border-color: rgba(16, 185, 129, 0.50); }
    .online-badge--off { background: rgba(249, 115, 22, 0.22); color: #fdba74; border-color: rgba(249, 115, 22, 0.55); }
    :host-context(html[data-theme="light"]) .online-badge--on  { background: rgba(16, 185, 129, 0.18); color: #065f46; border-color: #059669; }
    :host-context(html[data-theme="light"]) .online-badge--off { background: rgba(249, 115, 22, 0.18); color: #9a3412; border-color: #ea580c; }

    /* Buton — 3 kademe action sütunları */
    .job-btn {
      display: inline-block; width: 100%;
      padding: 3px 8px;
      font-size: 11px; font-weight: 600; line-height: 1.4;
      border-radius: var(--bp-r-pill, 999px);
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 100ms linear, opacity 100ms linear;
      background: rgba(124, 58, 237, 0.18); color: var(--bp-acc-purple); border-color: rgba(124, 58, 237, 0.45);
    }
    .job-btn:hover:not(:disabled) { background: rgba(124, 58, 237, 0.30); }
    .job-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .job-btn--queued    { background: rgba(156, 163, 175, 0.18); color: #d1d5db; border-color: rgba(156, 163, 175, 0.40); font-style: italic; }
    .job-btn--running   { background: rgba(245, 158, 11, 0.20); color: #fcd34d; border-color: rgba(245, 158, 11, 0.55); }
    .job-btn--awaiting  { background: rgba(168, 85, 247, 0.25); color: #d8b4fe; border-color: rgba(168, 85, 247, 0.60); }
    .job-btn--done      { background: rgba(16, 185, 129, 0.18); color: var(--bp-acc-green); border-color: rgba(16, 185, 129, 0.50); }
    .job-btn--failed    { background: rgba(239, 68, 68, 0.22); color: #fca5a5; border-color: rgba(239, 68, 68, 0.55); }
    .job-btn--not_found { background: rgba(249, 115, 22, 0.22); color: #fdba74; border-color: rgba(249, 115, 22, 0.55); }

    /* Light theme override */
    :host-context(html[data-theme="light"]) thead th {
      background: rgba(124, 58, 237, 0.08); color: #4c1d95;
      border-bottom-color: rgba(124, 58, 237, 0.30);
    }
    :host-context(html[data-theme="light"]) tbody td {
      border-bottom-color: rgba(76, 29, 149, 0.22); color: #1f2937;
    }
    :host-context(html[data-theme="light"]) .ch-chip {
      background: rgba(99, 102, 241, 0.18); color: #3730a3; border-color: rgba(79, 70, 229, 0.50);
    }
    :host-context(html[data-theme="light"]) .ssdb-badge--missing {
      background: rgba(239, 68, 68, 0.16); color: #991b1b; border-color: rgba(220, 38, 38, 0.55);
    }
    :host-context(html[data-theme="light"]) .status-badge--queued    { background: rgba(156, 163, 175, 0.22); color: #374151; border-color: #6b7280; }
    :host-context(html[data-theme="light"]) .status-badge--running   { background: rgba(245, 158, 11, 0.22); color: #92400e; border-color: #d97706; }
    :host-context(html[data-theme="light"]) .status-badge--awaiting  { background: rgba(168, 85, 247, 0.22); color: #581c87; border-color: #7c3aed; }
    :host-context(html[data-theme="light"]) .status-badge--done      { background: rgba(16, 185, 129, 0.20); color: #065f46; border-color: #059669; }
    :host-context(html[data-theme="light"]) .status-badge--failed    { background: rgba(239, 68, 68, 0.20); color: #991b1b; border-color: #dc2626; }
    :host-context(html[data-theme="light"]) .status-badge--not_found { background: rgba(249, 115, 22, 0.18); color: #9a3412; border-color: #ea580c; }
    :host-context(html[data-theme="light"]) .job-btn            { background: rgba(124, 58, 237, 0.16); color: #4c1d95; border-color: #6d28d9; }
    :host-context(html[data-theme="light"]) .job-btn--queued    { background: rgba(156, 163, 175, 0.22); color: #374151; border-color: #6b7280; }
    :host-context(html[data-theme="light"]) .job-btn--running   { background: rgba(245, 158, 11, 0.22); color: #92400e; border-color: #d97706; }
    :host-context(html[data-theme="light"]) .job-btn--awaiting  { background: rgba(168, 85, 247, 0.22); color: #581c87; border-color: #7c3aed; }
    :host-context(html[data-theme="light"]) .job-btn--done      { background: rgba(16, 185, 129, 0.20); color: #065f46; border-color: #059669; }
    :host-context(html[data-theme="light"]) .job-btn--failed    { background: rgba(239, 68, 68, 0.20); color: #991b1b; border-color: #dc2626; }
    :host-context(html[data-theme="light"]) .job-btn--not_found { background: rgba(249, 115, 22, 0.18); color: #9a3412; border-color: #ea580c; }
  `],
})
export class RestoreComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly keycloak = inject(KeycloakService);
  private readonly snack = inject(MatSnackBar);
  readonly searchService = inject(SearchService);
  readonly restoreService = inject(RestoreService);
  readonly transferService = inject(TransferService);

  /** Manuel SSDB cache refresh sırasında spinner gösterilecek DC kodları.
   *  Read-only Set; her değişikte yeni Set ile signal güncellenir. */
  readonly refreshingDcCodes = signal<ReadonlySet<string>>(new Set());

  /** Bulk SSDB refresh (Sira 6) calisirken page-bazli spinner + buton disable. */
  readonly bulkRefreshing = signal<boolean>(false);

  /** Backend bulk endpoint max DC sayisi — UI'da overflow uyarisi icin. */
  private readonly BULK_REFRESH_MAX = 100;

  /**
   * 2026-05-28 PROGRAM-only kuralı: Avid Interplay yalnız PROGRAM kategorisindeki
   * materyalleri tutar. Ara/Restore/Transfer akışı sadece bu satırlar için aktif.
   * REKLAM/KAMU_SPOTU/TANITIM/DIGER satırlarında 3 buton disabled + tooltip.
   * (CANLI satırlar zaten /provys/restore-missing backend filter'ında dışarda.)
   */
  private readonly NON_PROGRAM_TOOLTIP =
    'Sadece PROGRAM kategorisindeki materyaller için restore akışı uygulanır (Interplay yalnız programları içerir).';

  private isProgramCategory(row: RestoreRow): boolean {
    return row.category === 'PROGRAM';
  }

  readonly rows = signal<RestoreRow[]>([]);
  readonly loading = signal<boolean>(false);
  readonly errorMsg = signal<string>('');

  /**
   * 2026-05-28 Kategori filtresi — UI-only. Provys panel paritesi
   * (`mat-button-toggle-group multiple`). Default: tüm kategoriler seçili.
   * CANLI backend tarafında zaten filtreli; toggle UI'da seçili bile olsa
   * rows'da CANLI satır yok → no-op.
   */
  readonly categories = PROVYS_CATEGORIES;
  readonly selectedCategories = signal<ReadonlySet<ProvysCategory>>(new Set(PROVYS_CATEGORIES));
  readonly selectedCategoryArray = computed<ProvysCategory[]>(() => {
    const set = this.selectedCategories();
    return this.categories.filter((c) => set.has(c));
  });

  /** Filtre uygulanmış görünür satırlar — eksik materyal tablosu bunu render eder. */
  readonly visibleRows = computed<RestoreRow[]>(() => {
    const allowed = this.selectedCategories();
    if (allowed.size === this.categories.length) return this.rows();
    return this.rows().filter((r) => allowed.has(r.category as ProvysCategory));
  });

  onCategoryToggle(ev: MatButtonToggleChange): void {
    this.selectedCategories.set(new Set(ev.value as ProvysCategory[]));
  }

  categoryLabel(category: ProvysCategory | string): string {
    return PROVYS_CATEGORY_STYLES[category as ProvysCategory]?.label ?? category;
  }
  swatchColor(category: ProvysCategory): string {
    return PROVYS_CATEGORY_STYLES[category]?.border ?? '#9ca3af';
  }

  /** Job tabloları: scheduleDate asc → id desc (aynı gün içinde en yeni üstte). */
  readonly searchJobs = computed<SearchJobDto[]>(() => {
    return Array.from(this.searchService.jobsByDcDate().values())
      .sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate) || b.id - a.id);
  });
  readonly restoreJobs = computed<RestoreJobDto[]>(() => {
    return Array.from(this.restoreService.jobsByDcDate().values())
      .sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate) || b.id - a.id);
  });
  readonly transferJobs = computed<TransferJobDto[]>(() => {
    return Array.from(this.transferService.jobsByDcDate().values())
      .sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate) || b.id - a.id);
  });

  /** Admin auto-bypass + SystemEng explicit. */
  readonly canExecute = computed<boolean>(() => {
    if (isSkipAuthAllowed()) return true;
    const kc = this.keycloak.getKeycloakInstance();
    const parsed = kc?.tokenParsed as BcmsTokenParsed | undefined;
    const groups = parsed?.groups ?? [];
    return groups.includes(GROUP.Admin) || groups.includes(GROUP.SystemEng);
  });

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  /** Sira 7: sayfa acilis otomatik SSDB bulk tetigi — debounce timer.
   *  ngOnInit'te fetchAll sonrasi 1 sn beklenir; ngOnDestroy'da iptal. */
  private bulkAutoRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sira 7: sadece "X dakikadan eski" cache satirlarini otomatik tetikle.
   *  Taze cache'leri yeniden sormak SSDB'yi gereksiz yorar. */
  private readonly BULK_AUTO_THRESHOLD_MS = 5 * 60_000;

  async ngOnInit(): Promise<void> {
    await this.fetchAll();
    this.pollHandle = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void this.pollJobs();
    }, 5_000);
    // Sira 7: sayfa acilis otomatik bulk SSDB tetigi (sessiz, 1 sn gecikme).
    this.bulkAutoRefreshTimer = setTimeout(() => {
      this.bulkAutoRefreshTimer = null;
      void this.triggerInitialBulkRefresh();
    }, 1_000);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = null;
    if (this.bulkAutoRefreshTimer) {
      clearTimeout(this.bulkAutoRefreshTimer);
      this.bulkAutoRefreshTimer = null;
    }
  }

  async reload(): Promise<void> {
    await this.fetchAll();
  }

  trackByEventId(_i: number, row: RestoreRow): string { return row.eventId; }
  trackByJobId(_i: number, j: { id: number }): number { return j.id; }

  /** `YYYY-MM-DD` → kullanıcıya `DD.MM (Pzt/Sal/...)` formatında tarih + kısa gün adı. */
  formatDay(date: string): string {
    try {
      const dt = new Date(`${date}T00:00:00.000Z`);
      const dm = new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit',
      }).format(dt);
      const wd = new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul', weekday: 'short',
      }).format(dt);
      return `${dm} ${wd}`;
    } catch { return date; }
  }

  formatTime(r: RestoreRow): string {
    if (r.startTimecode) return r.startTimecode.slice(0, 5);
    try {
      return new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(r.startAt));
    } catch { return '—'; }
  }

  formatTs(iso: string | null): string {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(new Date(iso));
    } catch { return '—'; }
  }

  /** SSDB cache satirinin son kontrol zamanini operator-dostu Turkce string'e
   *  cevirir. UI 'Son kontrol: X dk once' alt-yazisinda kullanilir.
   *  null  -> 'kontrol edilmedi' (worker bu DC'yi henuz hic sormamis)
   *  <60sn -> 'Son kontrol: az once'
   *  <60dk -> 'Son kontrol: N dk once'
   *  <24sa -> 'Son kontrol: N sa once'
   *  <7gn  -> 'Son kontrol: N gun once'
   *  diger -> 'Son kontrol: dd.MM.yyyy' (Europe/Istanbul) */
  formatLastChecked(iso: string | null): string {
    if (!iso) return 'kontrol edilmedi';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return 'kontrol edilmedi';
    const diffMs = Date.now() - t;
    if (diffMs < 0) return 'Son kontrol: az önce';
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60)            return 'Son kontrol: az önce';
    const min = Math.floor(sec / 60);
    if (min < 60)            return `Son kontrol: ${min} dk önce`;
    const hr  = Math.floor(min / 60);
    if (hr  < 24)            return `Son kontrol: ${hr} sa önce`;
    const day = Math.floor(hr / 24);
    if (day < 7)             return `Son kontrol: ${day} gün önce`;
    try {
      return 'Son kontrol: ' + new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul',
        day: '2-digit', month: '2-digit', year: 'numeric',
      }).format(new Date(t));
    } catch { return 'kontrol edilmedi'; }
  }

  /** Belirli bir DC icin SSDB cache refresh halen calisiyor mu? */
  isRefreshing(r: RestoreRow): boolean {
    return this.refreshingDcCodes().has(r.dcCode);
  }

  /** Bu kullanici manuel cache refresh yetkisine sahip mi?
   *  `/api/v1/ssdb/cache/refresh` endpoint'i PERMISSIONS.ssdb.admin altinda;
   *  Admin + SystemEng auto-bypass — `canExecute` ile ayni grup seti. */
  canRefreshFor(_r: RestoreRow): boolean {
    return this.canExecute();
  }

  /** Tum gorunur satirlarin DC'lerini topluca SSDB'ye sor.
   *  - visibleRows()'tan distinct dcCode listesi (Set ile dedup).
   *  - Backend max 100 -> ilk 100 DC; geri kalan icin SnackBar uyarisi.
   *  - Her DC icin per-row spinner aktif olur (tutarli UX).
   *  - Response sonrasi in-memory satir guncelle/cikar. */
  canBulkRefresh(): boolean {
    return this.canExecute()
      && !this.bulkRefreshing()
      && this.visibleRows().length > 0;
  }

  /** Bulk butonu tooltip metni — template apostrof parser sorunundan kaçınmak
   *  için TS-side helper. */
  bulkTooltip(): string {
    if (!this.canExecute()) return 'Yetki yok';
    if (this.bulkRefreshing()) return 'SSDB yenileniyor…';
    return 'Görünür satırları SSDB ile toplu doğrula';
  }

  async onBulkRefreshClick(): Promise<void> {
    if (!this.canBulkRefresh()) return;

    // visibleRows'tan distinct DC kodu (max 100).
    const seen = new Set<string>();
    const dcCodes: string[] = [];
    for (const r of this.visibleRows()) {
      if (seen.has(r.dcCode)) continue;
      seen.add(r.dcCode);
      dcCodes.push(r.dcCode);
      if (dcCodes.length >= this.BULK_REFRESH_MAX) break;
    }
    if (dcCodes.length === 0) return;

    const totalDistinct = new Set(this.visibleRows().map((r) => r.dcCode)).size;
    const overflow = totalDistinct > this.BULK_REFRESH_MAX;

    // Page-bazli + per-row spinner state
    this.bulkRefreshing.set(true);
    const startSet = new Set(this.refreshingDcCodes());
    for (const dc of dcCodes) startSet.add(dc);
    this.refreshingDcCodes.set(startSet);

    try {
      const resp = await firstValueFrom(
        this.api.post<{
          results: Array<{
            dcCode: string;
            lookupStatus: string;
            mediaGuid: string | null;
            matchMethod: string | null;
            ssdbDurationFrames: number | null;
            ssdbDurationTimecode: string | null;
            changed: boolean;
          }>;
          notified: number;
        }>('/ssdb/cache/refresh/bulk', { dcCodes }),
      );

      const nowIso = new Date().toISOString();
      const foundSet = new Set(
        resp.results.filter((x) => x.lookupStatus === 'found').map((x) => x.dcCode),
      );
      const statusMap = new Map(resp.results.map((x) => [x.dcCode, x.lookupStatus]));

      // foundSet'teki satirlari liste'den cikar; digerleri lastCheckedAt + status guncelle
      this.rows.update((arr) =>
        arr
          .filter((x) => !foundSet.has(x.dcCode))
          .map((x) =>
            statusMap.has(x.dcCode)
              ? { ...x, lastCheckedAt: nowIso, ssdbStatus: statusMap.get(x.dcCode)! }
              : x,
          ),
      );

      const droppedCount = foundSet.size;
      const refreshedCount = resp.results.length;
      let msg = `${refreshedCount} materyal SSDB'den yenilendi.`;
      if (droppedCount > 0) msg += ` ${droppedCount} materyal listeden düştü.`;
      if (overflow) {
        msg += ` İlk ${this.BULK_REFRESH_MAX} işlendi, ${totalDistinct - this.BULK_REFRESH_MAX} materyal kaldı — tekrar tıklayın.`;
      }
      this.snack.open(msg, 'Tamam', { duration: 3_500 });
    } catch (err) {
      this.snack.open(
        `Toplu yenile başarısız: ${this.errMsg(err)}`,
        'Kapat',
        { duration: 4_000 },
      );
    } finally {
      this.bulkRefreshing.set(false);
      const finalSet = new Set(this.refreshingDcCodes());
      for (const dc of dcCodes) finalSet.delete(dc);
      this.refreshingDcCodes.set(finalSet);
    }
  }

  /** Sira 7: sayfa acilis sessiz arka plan bulk SSDB tetigi.
   *  - Yalniz visibleRows()'tan `lastCheckedAt > BULK_AUTO_THRESHOLD_MS eski`
   *    (veya null) olan distinct DC'ler — max 100.
   *  - Tetik yok ise (hepsi taze) -> hicbir backend cagrisi yapilmaz.
   *  - Spinner gosterilmez (kullanici bilincte degildir; pasif fayda).
   *  - Hata sessizdir — manuel buton ile retry mumkun. */
  private async triggerInitialBulkRefresh(): Promise<void> {
    if (!this.canExecute()) return;

    const thresholdMs = Date.now() - this.BULK_AUTO_THRESHOLD_MS;
    const seen = new Set<string>();
    const dcCodes: string[] = [];
    for (const r of this.visibleRows()) {
      if (seen.has(r.dcCode)) continue;
      // Cache zamani bilinmiyor (null) veya esik altinda mi?
      const lc = r.lastCheckedAt ? Date.parse(r.lastCheckedAt) : null;
      if (lc !== null && Number.isFinite(lc) && lc > thresholdMs) continue; // taze, atla
      seen.add(r.dcCode);
      dcCodes.push(r.dcCode);
      if (dcCodes.length >= this.BULK_REFRESH_MAX) break;
    }
    if (dcCodes.length === 0) return; // hicbir eski yok

    try {
      const resp = await firstValueFrom(
        this.api.post<{
          results: Array<{
            dcCode: string;
            lookupStatus: string;
            mediaGuid: string | null;
            matchMethod: string | null;
            ssdbDurationFrames: number | null;
            ssdbDurationTimecode: string | null;
            changed: boolean;
          }>;
          notified: number;
        }>('/ssdb/cache/refresh/bulk', { dcCodes }),
      );

      const nowIso = new Date().toISOString();
      const foundSet = new Set(
        resp.results.filter((x) => x.lookupStatus === 'found').map((x) => x.dcCode),
      );
      const statusMap = new Map(resp.results.map((x) => [x.dcCode, x.lookupStatus]));

      this.rows.update((arr) =>
        arr
          .filter((x) => !foundSet.has(x.dcCode))
          .map((x) =>
            statusMap.has(x.dcCode)
              ? { ...x, lastCheckedAt: nowIso, ssdbStatus: statusMap.get(x.dcCode)! }
              : x,
          ),
      );
    } catch {
      // Sessiz: kullaniciya bildirim yok. Manuel tetik var.
    }
  }

  /** Manuel SSDB cache refresh — tek DC icin POST /ssdb/cache/refresh.
   *  Sistemi yormama icin tum tabloyu yeniden fetch ETMEZ; response'a gore
   *  yalniz ilgili satiri in-memory gunceller veya listeden cikarir.
   *  - lookupStatus='found' -> satir artik eksik degil, listeden cikar.
   *  - Aksi -> satirin lastCheckedAt'i 'simdi' olarak guncellenir + status
   *    response'tan gelir.
   *  Hata: MatSnackBar (3sn). */
  async onRefreshClick(r: RestoreRow): Promise<void> {
    if (!this.canRefreshFor(r)) return;
    if (this.isRefreshing(r)) return;

    const next = new Set(this.refreshingDcCodes());
    next.add(r.dcCode);
    this.refreshingDcCodes.set(next);

    try {
      const resp = await firstValueFrom(
        this.api.post<{
          dcCode: string;
          lookupStatus: string;
          mediaGuid: string | null;
          matchMethod: string | null;
          ssdbDurationFrames: number | null;
          ssdbDurationTimecode: string | null;
          changed: boolean;
        }>('/ssdb/cache/refresh', { dcCode: r.dcCode }),
      );

      const nowIso = new Date().toISOString();
      if (resp.lookupStatus === 'found') {
        // Artik eksik degil -> listeden cikar.
        this.rows.update((arr) => arr.filter((x) => x.eventId !== r.eventId));
        this.snack.open(`${r.dcCode}: SSDB'de bulundu.`, 'Tamam', { duration: 2_500 });
      } else {
        // Hala eksik -> lastCheckedAt'i guncelle (status ayni kalir,
        // backend label'i UI'da tek tek hesaplamiyoruz; bir sonraki ngOnInit
        // veya manuel reload'da label senkronize olur).
        this.rows.update((arr) =>
          arr.map((x) =>
            x.eventId === r.eventId
              ? { ...x, lastCheckedAt: nowIso, ssdbStatus: resp.lookupStatus }
              : x,
          ),
        );
        this.snack.open(`${r.dcCode}: hala eksik (${resp.lookupStatus}).`, 'Tamam', { duration: 2_500 });
      }
    } catch (err) {
      this.snack.open(`${r.dcCode}: yenilenemedi — ${this.errMsg(err)}`, 'Kapat', { duration: 4_000 });
    } finally {
      const finalSet = new Set(this.refreshingDcCodes());
      finalSet.delete(r.dcCode);
      this.refreshingDcCodes.set(finalSet);
    }
  }

  // ============================================================
  // Search (kademe 1) — buton state
  // ============================================================
  private searchJobOf(r: RestoreRow): SearchJobDto | undefined {
    return this.searchService.jobFor(r.dcCode, r.scheduleDate);
  }
  searchToneFor(r: RestoreRow): JobTone {
    const s = this.searchJobOf(r)?.status;
    return this.searchToneForStatus(s);
  }
  searchToneForStatus(status: SearchJobStatus | undefined): JobTone {
    if (!status) return 'idle';
    if (status === 'QUEUED')             return 'queued';
    if (status === 'RUNNING')            return 'running';
    if (status === 'AWAITING_SELECTION') return 'awaiting';
    if (status === 'SELECTED')           return 'done';
    if (status === 'NOT_FOUND')          return 'not_found';
    return 'failed';
  }
  searchStatusLabel(status: SearchJobStatus): string {
    switch (status) {
      case 'QUEUED':             return 'Sırada';
      case 'RUNNING':            return 'Aranıyor';
      case 'AWAITING_SELECTION': return 'Seçim Bekliyor';
      case 'SELECTED':           return 'Seçildi';
      case 'NOT_FOUND':          return 'Bulunamadı';
      case 'FAILED':             return 'Başarısız';
      case 'CANCELLED':          return 'İptal';
      default: return status;
    }
  }
  searchLabelFor(r: RestoreRow): string {
    const s = this.searchJobOf(r)?.status;
    if (!s) return 'Ara';
    if (s === 'QUEUED')             return 'Sırada';
    if (s === 'RUNNING')            return 'Aranıyor…';
    if (s === 'AWAITING_SELECTION') return 'Seçim Bekliyor';
    if (s === 'SELECTED')           return 'Seçildi';
    if (s === 'NOT_FOUND')          return 'Tekrar Ara';
    if (s === 'FAILED')             return 'Tekrar Ara';
    return 'Ara';
  }
  canClickSearchFor(r: RestoreRow): boolean {
    if (!this.isProgramCategory(r)) return false;
    if (!this.canExecute()) return false;
    const s = this.searchJobOf(r)?.status;
    if (s === 'QUEUED' || s === 'RUNNING') return false;
    if (s === 'SELECTED') return false;
    return true; // idle, AWAITING_SELECTION (dialog), NOT_FOUND, FAILED → tıklanabilir
  }
  searchTooltipFor(r: RestoreRow): string {
    if (!this.isProgramCategory(r)) return this.NON_PROGRAM_TOOLTIP;
    if (!this.canExecute()) return 'Arama yetkin yok.';
    const j = this.searchJobOf(r);
    if (!j) return 'Avid arşivinde DC kod ile ara.';
    if (j.status === 'AWAITING_SELECTION') return 'Sonuçlardan asset seçimi gerekli (tıklayın).';
    if (j.status === 'SELECTED') return `Seçildi: ${j.selectedAssetName ?? ''}`;
    if (j.status === 'NOT_FOUND') return 'Avid\'de bulunamadı; tekrar deneyebilirsin.';
    if (j.status === 'FAILED') return `Hata: ${j.errorMsg ?? 'bilinmiyor'} — tekrar dene.`;
    return `Durum: ${j.status}`;
  }
  async onSearchClick(r: RestoreRow): Promise<void> {
    if (!this.canClickSearchFor(r)) return;
    const job = this.searchJobOf(r);
    if (job?.status === 'AWAITING_SELECTION' && job.avidAssets && job.avidAssets.length > 0) {
      // Selection dialog → PATCH select
      const picked = await this.openAssetSelectionDialog(r.dcCode, job.avidAssets);
      if (!picked) return;
      try {
        await this.searchService.selectAsset(job.id, { avidAssetId: picked.id, avidAssetName: picked.name });
        await this.pollJobs();
      } catch (err) {
        this.errorMsg.set(`Asset seçimi başarısız: ${this.errMsg(err)}`);
      }
      return;
    }

    // Yeni search enqueue
    const ok = await this.confirmDialog({
      title: 'Avid Arama (Kademe 1)',
      message: `${r.dcCode} Avid arşivinde aranacak. Sonuçlar gelince seçim yapacaksınız.`,
      confirmText: 'Ara',
      confirmColor: 'primary',
    });
    if (!ok) return;
    try {
      await this.searchService.enqueue({
        channelSlug:  r.channelSlug,
        scheduleDate: r.scheduleDate,
        dcCode:       r.dcCode,
      });
      await this.pollJobs();
    } catch (err) {
      this.errorMsg.set(`Arama tetiklenemedi: ${this.errMsg(err)}`);
    }
  }

  // ============================================================
  // Restore (kademe 2) — buton state
  // ============================================================
  private restoreJobOf(r: RestoreRow): RestoreJobDto | undefined {
    return this.restoreService.jobFor(r.dcCode, r.scheduleDate);
  }
  restoreToneFor(r: RestoreRow): JobTone {
    return this.restoreToneForStatus(this.restoreJobOf(r)?.status);
  }
  restoreToneForStatus(status: RestoreJobStatus | undefined): JobTone {
    if (!status) return 'idle';
    if (status === 'QUEUED')  return 'queued';
    if (status === 'RUNNING') return 'running';
    if (status === 'DONE')    return 'done';
    return 'failed';
  }
  restoreStatusLabel(status: RestoreJobStatus): string {
    switch (status) {
      case 'QUEUED':    return 'Sırada';
      case 'RUNNING':   return 'Çalışıyor';
      case 'DONE':      return 'Tamamlandı';
      case 'FAILED':    return 'Başarısız';
      case 'CANCELLED': return 'İptal';
      default: return status;
    }
  }
  restoreLabelFor(r: RestoreRow): string {
    const s = this.restoreJobOf(r)?.status;
    if (!s) return 'Restore';
    if (s === 'QUEUED')  return 'Sırada';
    if (s === 'RUNNING') return 'Çalışıyor…';
    if (s === 'DONE')    return 'Tamamlandı';
    if (s === 'FAILED')  return 'Tekrar Dene';
    return 'Restore';
  }
  canClickRestoreFor(r: RestoreRow): boolean {
    if (!this.isProgramCategory(r)) return false;
    if (!this.canExecute()) return false;
    const search = this.searchJobOf(r);
    if (!search || search.status !== 'SELECTED') return false; // search SELECTED zorunlu
    const restoreStatus = this.restoreJobOf(r)?.status;
    if (restoreStatus === 'QUEUED' || restoreStatus === 'RUNNING' || restoreStatus === 'DONE') return false;
    return true;
  }
  restoreTooltipFor(r: RestoreRow): string {
    if (!this.isProgramCategory(r)) return this.NON_PROGRAM_TOOLTIP;
    if (!this.canExecute()) return 'Restore başlatma yetkin yok.';
    const search = this.searchJobOf(r);
    if (!search || search.status !== 'SELECTED') return 'Önce arama tamamlanmalı (SELECTED).';
    const j = this.restoreJobOf(r);
    const onlineNote = search.selectedAssetOnline === true
      ? 'Interplay\'de zaten online (kısa sürer)'
      : search.selectedAssetOnline === false
        ? 'DIVA\'dan Avid\'e getirilecek'
        : 'DIVA\'dan Avid\'e getir';
    if (!j) return `Asset: ${search.selectedAssetName ?? ''} · ${onlineNote}`;
    if (j.status === 'DONE') return 'Tamamlandı — Transfer ile devam edebilirsin.';
    if (j.status === 'FAILED') return `Hata: ${j.errorMsg ?? 'bilinmiyor'} — tekrar dene.`;
    return `Durum: ${j.status} (${j.attemptCount}/${j.maxAttempts})`;
  }
  async onRestoreClick(r: RestoreRow): Promise<void> {
    if (!this.canClickRestoreFor(r)) return;
    const search = this.searchJobOf(r);
    if (!search) return;
    const onlineNote = search.selectedAssetOnline === true
      ? '\nAsset Interplay\'de zaten online — Restore kısa sürecek.'
      : search.selectedAssetOnline === false
        ? '\nAsset DIVA arşivinde — restore DIVA → Avid binary indirir.'
        : '';
    const ok = await this.confirmDialog({
      title: 'Restore Başlat (Kademe 2)',
      message: `Asset: ${search.selectedAssetName ?? ''}${onlineNote}`,
      confirmText: 'Restore Başlat',
      confirmColor: 'primary',
    });
    if (!ok) return;
    try {
      await this.restoreService.enqueue({ searchJobId: search.id });
      await this.pollJobs();
    } catch (err) {
      this.errorMsg.set(`Restore tetiklenemedi: ${this.errMsg(err)}`);
    }
  }

  // ============================================================
  // Transfer (kademe 3) — buton state
  // ============================================================
  transferToneFor(r: RestoreRow): JobTone {
    return this.transferToneForStatus(this.transferService.jobFor(r.dcCode, r.scheduleDate)?.status);
  }
  transferToneForStatus(status: TransferJobStatus | undefined): JobTone {
    if (!status) return 'idle';
    if (status === 'QUEUED')  return 'queued';
    if (status === 'RUNNING') return 'running';
    if (status === 'DONE')    return 'done';
    return 'failed';
  }
  transferStatusLabel(status: TransferJobStatus): string {
    switch (status) {
      case 'QUEUED':    return 'Sırada';
      case 'RUNNING':   return 'Çalışıyor';
      case 'DONE':      return 'Tamamlandı';
      case 'FAILED':    return 'Başarısız';
      case 'CANCELLED': return 'İptal';
      default: return status;
    }
  }
  transferLabelFor(r: RestoreRow): string {
    const s = this.transferService.jobFor(r.dcCode, r.scheduleDate)?.status;
    if (!s) return 'Transfer';
    if (s === 'QUEUED')  return 'Sırada';
    if (s === 'RUNNING') return 'Çalışıyor…';
    if (s === 'DONE')    return 'Tamamlandı';
    if (s === 'FAILED')  return 'Tekrar Dene';
    return 'Transfer';
  }
  canClickTransferFor(r: RestoreRow): boolean {
    if (!this.isProgramCategory(r)) return false;
    if (!this.canExecute()) return false;
    const restore = this.restoreJobOf(r);
    if (!restore || restore.status !== 'DONE') return false;
    const transferStatus = this.transferService.jobFor(r.dcCode, r.scheduleDate)?.status;
    if (transferStatus === 'QUEUED' || transferStatus === 'RUNNING' || transferStatus === 'DONE') return false;
    return true;
  }
  transferTooltipFor(r: RestoreRow): string {
    if (!this.isProgramCategory(r)) return this.NON_PROGRAM_TOOLTIP;
    if (!this.canExecute()) return 'Transfer başlatma yetkin yok.';
    const restore = this.restoreJobOf(r);
    if (!restore || restore.status !== 'DONE') return 'Önce Restore tamamlanmalı.';
    const j = this.transferService.jobFor(r.dcCode, r.scheduleDate);
    if (!j) return `Asset: ${restore.avidAssetName ?? ''} — Interplay'den production storage'a aktar.`;
    if (j.status === 'DONE') return 'Tamamlandı — materyal production storage\'da.';
    if (j.status === 'FAILED') return `Hata: ${j.errorMsg ?? 'bilinmiyor'} — tekrar dene.`;
    return `Durum: ${j.status} (${j.attemptCount}/${j.maxAttempts})`;
  }
  async onTransferClick(r: RestoreRow): Promise<void> {
    if (!this.canClickTransferFor(r)) return;
    const restore = this.restoreJobOf(r);
    if (!restore) return;
    const ok = await this.confirmDialog({
      title: 'Transfer Başlat (Kademe 3)',
      message: `Asset: ${restore.avidAssetName ?? ''}\nInterplay'den production storage'a aktarılacak.`,
      confirmText: 'Transfer Başlat',
      confirmColor: 'primary',
    });
    if (!ok) return;
    try {
      await this.transferService.enqueue({ restoreJobId: restore.id });
      await this.pollJobs();
    } catch (err) {
      this.errorMsg.set(`Transfer tetiklenemedi: ${this.errMsg(err)}`);
    }
  }

  // ============================================================
  // Helpers
  // ============================================================
  private async confirmDialog(data: ConfirmDialogData): Promise<boolean> {
    const ref = this.dialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(
      ConfirmDialogComponent, { data },
    );
    return (await firstValueFrom(ref.afterClosed())) === true;
  }

  private async openAssetSelectionDialog(dcCode: string, assets: AvidAsset[]): Promise<AvidAsset | null> {
    const ref = this.dialog.open<AvidAssetSelectionDialogComponent, AvidAssetSelectionData, AvidAsset | null>(
      AvidAssetSelectionDialogComponent,
      { data: { dcCode, assets } },
    );
    return (await firstValueFrom(ref.afterClosed())) ?? null;
  }

  private errMsg(err: unknown): string {
    return err instanceof Error && err.message ? err.message : 'Bilinmeyen hata';
  }

  // ============================================================
  // Data fetching — today-future scope (2026-05-28)
  // Backend `date` parametresi yoksa scheduleDate >= today döner.
  // ============================================================
  private async fetchAll(): Promise<void> {
    this.loading.set(true);
    this.errorMsg.set('');
    try {
      const resp = await firstValueFrom(this.api.get<RestoreResponse>('/provys/restore-missing'));
      this.rows.set(resp.rows ?? []);
      await this.pollJobs();
    } catch (err) {
      this.errorMsg.set(`Liste yüklenemedi (${this.errMsg(err)}).`);
      this.rows.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  private async pollJobs(): Promise<void> {
    try {
      await Promise.all([
        this.searchService.fetchJobs(),
        this.restoreService.fetchJobs(),
        this.transferService.fetchJobs(),
      ]);
    } catch {
      // Polling hatası UI'yı bozmasın
    }
  }
}
