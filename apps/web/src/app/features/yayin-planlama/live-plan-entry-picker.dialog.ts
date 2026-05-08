import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ApiService } from '../../core/services/api.service';
import {
  LIVE_PLAN_STATUS_LABELS,
  type LivePlanEntry,
  type LivePlanListResponse,
  type LivePlanStatus,
  livePlanEndpoint,
} from '../live-plan/live-plan.types';

/**
 * SCHED-B4 (Y4-6): Live-plan entry picker dialog.
 *
 * Yayın Planlama formunda `selectedLivePlanEntryId` zorunlu (K-B3.20).
 * Dialog explicit confirmation pattern'i sağlar; autocomplete tek başına
 * yanlış event seçimi riskine karşı yetersiz.
 *
 * Filtre + tablo:
 *   - Text search: title / team / optaMatchId
 *   - Status filter: PLANNED / READY / IN_PROGRESS (skipped: COMPLETED, CANCELLED)
 *   - Tarih range (eventStartTime YYYY-MM-DD)
 *   - Tablo kolonları: title, team_1 vs team_2, eventStartTime, status,
 *     eventKey, sourceType (OPTA/MANUAL)
 *   - Çift tıkla seç + "Seç" butonu (afterClosed: LivePlanEntry | undefined)
 *   - Boş durum + sayfalama (server pagination GET /api/v1/live-plan).
 */

const PICKER_PAGE_SIZE = 50;

@Component({
  selector: 'app-live-plan-entry-picker',
  standalone: true,
  imports: [
    CommonModule, FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule,
    MatSelectModule, MatIconModule, MatButtonModule, MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title>Canlı Yayın Plan Seç</h2>
    <mat-dialog-content class="picker-content">
      <div class="filters">
        <mat-form-field appearance="outline" class="search-field">
          <mat-label>Ara (başlık / takım / OPTA id)</mat-label>
          <input matInput [(ngModel)]="search" name="search" />
          @if (search()) {
            <button matSuffix mat-icon-button (click)="search.set('')" type="button">
              <mat-icon>close</mat-icon>
            </button>
          }
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Durum</mat-label>
          <mat-select [(ngModel)]="statusFilter" name="status">
            <mat-option [value]="null">(hepsi)</mat-option>
            @for (s of allowedStatuses; track s) {
              <mat-option [value]="s">{{ statusLabels[s] }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Başlangıç (YYYY-MM-DD)</mat-label>
          <input matInput type="date" [(ngModel)]="dateFrom" name="dateFrom" />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Bitiş (YYYY-MM-DD)</mat-label>
          <input matInput type="date" [(ngModel)]="dateTo" name="dateTo" />
        </mat-form-field>
      </div>

      @if (loading()) {
        <div class="state state-loading">
          <mat-progress-spinner mode="indeterminate" diameter="32"></mat-progress-spinner>
          <span>Yükleniyor…</span>
        </div>
      } @else if (error()) {
        <div class="state state-error">
          <mat-icon>error_outline</mat-icon>
          <span>{{ error() }}</span>
          <button mat-stroked-button (click)="reload()">Tekrar dene</button>
        </div>
      } @else if (filteredEntries().length === 0) {
        <div class="state state-empty">
          <mat-icon>search_off</mat-icon>
          <span>Eşleşen canlı yayın plan bulunamadı.</span>
        </div>
      } @else {
        <div class="table-wrapper">
          <table class="picker-table">
            <thead>
              <tr>
                <th>Başlık</th>
                <th>Takım</th>
                <th>Başlangıç</th>
                <th>Durum</th>
                <th>Event Key</th>
                <th>Kaynak</th>
              </tr>
            </thead>
            <tbody>
              @for (e of filteredEntries(); track e.id) {
                <tr
                  [class.selected]="selected()?.id === e.id"
                  (click)="selected.set(e)"
                  (dblclick)="confirm()"
                >
                  <td>{{ e.title }}</td>
                  <td>
                    @if (e.team1Name && e.team2Name) {
                      {{ e.team1Name }} vs {{ e.team2Name }}
                    } @else {
                      —
                    }
                  </td>
                  <td>{{ e.eventStartTime | date:'short' }}</td>
                  <td>{{ statusLabels[e.status] }}</td>
                  <td class="event-key">{{ e.eventKey || '—' }}</td>
                  <td>{{ e.sourceType || '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="close()" type="button">İptal</button>
      <button mat-raised-button color="primary"
              [disabled]="!selected()"
              (click)="confirm()" type="button">
        Seç
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .picker-content { min-width: 720px; max-height: 70vh; }
    .filters { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 12px; }
    .search-field { grid-column: span 1; }
    .state { display: flex; align-items: center; gap: 12px; padding: 24px; justify-content: center; color: var(--mat-sys-on-surface-variant); }
    .state-error { color: var(--mat-sys-error); }
    .table-wrapper { max-height: 50vh; overflow: auto; border: 1px solid var(--mat-sys-outline-variant); border-radius: 4px; }
    .picker-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .picker-table thead th {
      position: sticky; top: 0; background: var(--mat-sys-surface-container);
      text-align: left; padding: 8px; font-weight: 600;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .picker-table tbody td { padding: 8px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .picker-table tbody tr { cursor: pointer; }
    .picker-table tbody tr:hover { background: var(--mat-sys-surface-container-low); }
    .picker-table tbody tr.selected { background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); }
    .event-key { font-family: monospace; font-size: 12px; }
  `],
})
export class LivePlanEntryPickerDialog implements OnInit {
  private api    = inject(ApiService);
  private dialog = inject(MatDialogRef<LivePlanEntryPickerDialog, LivePlanEntry | undefined>);

  // KO14 paritesi (B3c): cascade-able statüler. COMPLETED/CANCELLED listeden hariç.
  protected readonly allowedStatuses: LivePlanStatus[] = ['PLANNED', 'READY', 'IN_PROGRESS'];
  protected readonly statusLabels = LIVE_PLAN_STATUS_LABELS;

  protected entries     = signal<LivePlanEntry[]>([]);
  protected loading     = signal<boolean>(false);
  protected error       = signal<string | null>(null);
  protected selected    = signal<LivePlanEntry | null>(null);
  protected search      = signal<string>('');
  protected statusFilter = signal<LivePlanStatus | null>(null);
  protected dateFrom    = signal<string>('');
  protected dateTo      = signal<string>('');

  protected filteredEntries = computed<LivePlanEntry[]>(() => {
    const q       = this.search().trim().toLowerCase();
    const status  = this.statusFilter();
    const from    = this.dateFrom();
    const to      = this.dateTo();
    return this.entries().filter((e) => {
      if (!this.allowedStatuses.includes(e.status)) return false;
      if (status && e.status !== status) return false;
      if (q) {
        const hay = [
          e.title.toLowerCase(),
          e.team1Name?.toLowerCase() ?? '',
          e.team2Name?.toLowerCase() ?? '',
          e.optaMatchId?.toLowerCase() ?? '',
        ].join(' ');
        if (!hay.includes(q)) return false;
      }
      if (from) {
        const eventDate = e.eventStartTime.slice(0, 10); // YYYY-MM-DD
        if (eventDate < from) return false;
      }
      if (to) {
        const eventDate = e.eventStartTime.slice(0, 10);
        if (eventDate > to) return false;
      }
      return true;
    });
  });

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api
      .get<LivePlanListResponse>(livePlanEndpoint.list(), { pageSize: PICKER_PAGE_SIZE })
      .subscribe({
        next: (res) => {
          this.entries.set(res.items);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(err?.error?.message ?? 'Liste yüklenemedi.');
          this.loading.set(false);
        },
      });
  }

  confirm(): void {
    const sel = this.selected();
    if (sel) this.dialog.close(sel);
  }

  close(): void {
    this.dialog.close(undefined);
  }
}
