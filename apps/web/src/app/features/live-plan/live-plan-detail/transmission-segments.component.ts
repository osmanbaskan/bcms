import { Component, Input, OnChanges, SimpleChanges, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { ApiService } from '../../../core/services/api.service';
import {
  FEED_ROLES, FEED_ROLE_LABELS,
  SEGMENT_KINDS, SEGMENT_KIND_LABELS,
  livePlanEndpoint,
  type FeedRole, type SegmentKind, type TransmissionSegment,
} from '../live-plan.types';
import {
  SegmentFormDialogComponent,
  type SegmentFormDialogData,
} from './segment-form-dialog.component';
import {
  SegmentConfirmDialogComponent,
  type ConfirmDialogData,
} from './confirm-dialog.component';

/**
 * Madde 5 M5-B10a — Transmisyon Süreleri tablosu.
 *
 * Endpoint: M5-B9 GET /api/v1/live-plan/:entryId/segments?feedRole=&kind=
 *           POST /api/v1/live-plan/:entryId/segments
 *           PATCH /api/v1/live-plan/:entryId/segments/:segId  (no If-Match V1)
 *           DELETE /api/v1/live-plan/:entryId/segments/:segId  (soft)
 *
 * U6 explicit POST + PATCH (no PUT upsert).
 * U3 segment version YOK V1 (last-write-wins).
 * U10 outbox shadow events: live_plan.segment.created/updated/deleted
 *     (Phase 2 status=published).
 *
 * Yetki: PERMISSIONS.livePlan.read/write/delete (M5-B2 set; Admin auto-bypass).
 */
@Component({
  selector: 'app-transmission-segments',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatTableModule, MatButtonModule, MatIconModule, MatChipsModule,
    MatDialogModule, MatFormFieldModule, MatSelectModule,
    MatSnackBarModule, MatTooltipModule, MatProgressSpinnerModule,
  ],
  template: `
    <div class="header">
      <div class="title">
        <h3>Transmisyon Süreleri</h3>
        <span class="meta">{{ rows().length }} segment</span>
      </div>
      <div class="actions">
        <mat-form-field appearance="outline" class="filter-field">
          <mat-label>Feed</mat-label>
          <mat-select [(ngModel)]="feedRoleFilter" (ngModelChange)="onFilterChange()">
            <mat-option [value]="''">Hepsi</mat-option>
            @for (r of feedRoles; track r) {
              <mat-option [value]="r">{{ feedRoleLabel(r) }} ({{ r }})</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline" class="filter-field">
          <mat-label>Tür</mat-label>
          <mat-select [(ngModel)]="kindFilter" (ngModelChange)="onFilterChange()">
            <mat-option [value]="''">Hepsi</mat-option>
            @for (k of kinds; track k) {
              <mat-option [value]="k">{{ kindLabel(k) }} ({{ k }})</mat-option>
            }
          </mat-select>
        </mat-form-field>

        @if (canWrite) {
          <button mat-raised-button color="primary" (click)="openCreate()">
            <mat-icon>add</mat-icon> Yeni Segment
          </button>
        }
      </div>
    </div>

    @if (loading()) {
      <div class="loading"><mat-spinner diameter="36"></mat-spinner></div>
    } @else if (rows().length === 0) {
      <div class="empty">Bu girişe ait segment yok.</div>
    } @else {
      <table mat-table [dataSource]="rows()" class="seg-table">
        <ng-container matColumnDef="feedRole">
          <th mat-header-cell *matHeaderCellDef>Feed</th>
          <td mat-cell *matCellDef="let s">
            <mat-chip [class.feed-main]="s.feedRole==='MAIN'"
                      [class.feed-backup]="s.feedRole==='BACKUP'"
                      [class.feed-fiber]="s.feedRole==='FIBER'">
              {{ feedRoleLabel(s.feedRole) }}
            </mat-chip>
          </td>
        </ng-container>

        <ng-container matColumnDef="kind">
          <th mat-header-cell *matHeaderCellDef>Tür</th>
          <td mat-cell *matCellDef="let s">{{ kindLabel(s.kind) }}</td>
        </ng-container>

        <ng-container matColumnDef="startTime">
          <th mat-header-cell *matHeaderCellDef>Başlangıç</th>
          <td mat-cell *matCellDef="let s">{{ formatTime(s.startTime) }}</td>
        </ng-container>

        <ng-container matColumnDef="endTime">
          <th mat-header-cell *matHeaderCellDef>Bitiş</th>
          <td mat-cell *matCellDef="let s">{{ formatTime(s.endTime) }}</td>
        </ng-container>

        <ng-container matColumnDef="duration">
          <th mat-header-cell *matHeaderCellDef>Süre</th>
          <td mat-cell *matCellDef="let s">{{ duration(s.startTime, s.endTime) }}</td>
        </ng-container>

        <ng-container matColumnDef="description">
          <th mat-header-cell *matHeaderCellDef>Açıklama</th>
          <td mat-cell *matCellDef="let s" class="desc-cell">
            {{ s.description ?? '—' }}
          </td>
        </ng-container>

        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef></th>
          <td mat-cell *matCellDef="let s">
            @if (canWrite) {
              <button mat-icon-button matTooltip="Düzenle" (click)="openEdit(s)">
                <mat-icon>edit</mat-icon>
              </button>
            }
            @if (canDelete) {
              <button mat-icon-button matTooltip="Sil" (click)="softDelete(s)">
                <mat-icon>delete_outline</mat-icon>
              </button>
            }
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="cols"></tr>
        <tr mat-row *matRowDef="let row; columns: cols;"></tr>
      </table>
    }
  `,
  styles: [`
    .header { display:flex; align-items:center; justify-content:space-between; padding:12px 0; gap:16px; flex-wrap:wrap; }
    .title h3 { margin:0; font-size:16px; font-weight:500; }
    .title .meta { font-size:12px; color:#888; margin-left:8px; }
    .actions { display:flex; align-items:center; gap:12px; }
    .filter-field { width:160px; }
    .seg-table { width:100%; }
    .loading { display:flex; justify-content:center; padding:40px; }
    .empty { padding:32px; text-align:center; color:#888; font-size:14px; }
    .desc-cell { max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    mat-chip.feed-main   { background:#1565c0 !important; color:#fff !important; }
    mat-chip.feed-backup { background:#6a1b9a !important; color:#fff !important; }
    mat-chip.feed-fiber  { background:#2e7d32 !important; color:#fff !important; }
  `],
})
export class TransmissionSegmentsComponent implements OnChanges {
  @Input({ required: true }) entryId!: number;
  @Input() canWrite  = false;
  @Input() canDelete = false;

  private api    = inject(ApiService);
  private dialog = inject(MatDialog);
  private snack  = inject(MatSnackBar);

  feedRoles = FEED_ROLES;
  kinds     = SEGMENT_KINDS;
  feedRoleLabel = (r: FeedRole) => FEED_ROLE_LABELS[r];
  kindLabel     = (k: SegmentKind) => SEGMENT_KIND_LABELS[k];

  rows           = signal<TransmissionSegment[]>([]);
  loading        = signal(false);
  feedRoleFilter: FeedRole | '' = '';
  kindFilter:     SegmentKind | '' = '';

  cols = ['feedRole', 'kind', 'startTime', 'endTime', 'duration', 'description', 'actions'];

  ngOnChanges(changes: SimpleChanges) {
    if (changes['entryId']) this.load();
  }

  onFilterChange() { this.load(); }

  load() {
    if (!this.entryId) return;
    this.loading.set(true);
    const params: Record<string, string | number | boolean> = {};
    if (this.feedRoleFilter) params['feedRole'] = this.feedRoleFilter;
    if (this.kindFilter)     params['kind']     = this.kindFilter;

    this.api.get<TransmissionSegment[]>(livePlanEndpoint.segments.list(this.entryId), params)
      .subscribe({
        next: (segs) => { this.rows.set(segs ?? []); this.loading.set(false); },
        error: () => {
          this.loading.set(false);
          this.rows.set([]);
          this.snack.open('Segment listesi yüklenemedi', 'Kapat', { duration: 4000 });
        },
      });
  }

  openCreate() {
    const data: SegmentFormDialogData = { entryId: this.entryId };
    this.dialog.open(SegmentFormDialogComponent, { data, width: '480px' })
      .afterClosed().subscribe((ok) => {
        if (ok) { this.snack.open('Segment oluşturuldu', 'Kapat', { duration: 2500 }); this.load(); }
      });
  }

  openEdit(seg: TransmissionSegment) {
    const data: SegmentFormDialogData = { entryId: this.entryId, segment: seg };
    this.dialog.open(SegmentFormDialogComponent, { data, width: '480px' })
      .afterClosed().subscribe((ok) => {
        if (ok) { this.snack.open('Segment güncellendi', 'Kapat', { duration: 2500 }); this.load(); }
      });
  }

  softDelete(seg: TransmissionSegment) {
    const data: ConfirmDialogData = {
      title:        'Segment Sil',
      message:      `"${this.feedRoleLabel(seg.feedRole)} / ${this.kindLabel(seg.kind)}" segmenti silinsin mi?`,
      confirmText:  'Sil',
      confirmColor: 'warn',
    };
    this.dialog.open(SegmentConfirmDialogComponent, { data, width: '380px' })
      .afterClosed().subscribe((ok: boolean | undefined) => {
        if (!ok) return;
        this.api.delete(livePlanEndpoint.segments.detail(this.entryId, seg.id)).subscribe({
          next: () => { this.snack.open('Silindi', 'Kapat', { duration: 2500 }); this.load(); },
          error: (err: { error?: { message?: string } }) => {
            this.snack.open(err?.error?.message ?? 'Silme başarısız', 'Kapat', { duration: 4000 });
          },
        });
      });
  }

  formatTime(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  duration(s: string, e: string): string {
    if (!s || !e) return '—';
    const start = new Date(s).getTime();
    const end   = new Date(e).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '—';
    const totalMin = Math.round((end - start) / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}s ${m}dk` : `${m}dk`;
  }
}
