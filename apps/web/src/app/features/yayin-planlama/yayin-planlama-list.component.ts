import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { KeycloakService } from 'keycloak-angular';
import { GROUP, PERMISSIONS } from '@bcms/shared';
import { isSkipAuthAllowed } from '../../core/auth/skip-auth';
import type { BcmsTokenParsed } from '../../core/types/auth';
import { YayinPlanlamaService } from '../../core/services/yayin-planlama.service';
import type { Schedule } from '@bcms/shared';
import {
  SegmentConfirmDialogComponent,
  type ConfirmDialogData,
} from '../live-plan/live-plan-detail/confirm-dialog.component';

/**
 * SCHED-B4 — Yayın Planlama list (server-side pagination + filter).
 *
 * Backend: GET /api/v1/schedules/broadcast (B4-prep edfda69 + acb8167).
 * Server-side filter: eventKey/selectedLivePlanEntryId/scheduleDate/Time NOT
 * NULL (broadcast-complete row guarantee). Frontend post-filter YOK.
 *
 * Permissions:
 *   - Read: PERMISSIONS.schedules.read = [] (all authenticated)
 *   - Write: PERMISSIONS.schedules.write (Tekyon/Transmisyon/Booking/YayınPlanlama)
 *   - Delete: PERMISSIONS.schedules.delete
 *
 * Confirm dialog: live-plan-detail/SegmentConfirmDialogComponent reuse
 * (kapsam küçük; B5 cleanup turunda shared core/ui'ye lift edilebilir).
 */

const PAGE_SIZE_DEFAULT = 25;

@Component({
  selector: 'app-yayin-planlama-list',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink,
    MatTableModule, MatButtonModule, MatIconModule, MatChipsModule,
    MatFormFieldModule, MatInputModule, MatSelectModule, MatPaginatorModule,
    MatTooltipModule, MatDialogModule, MatSnackBarModule, MatProgressSpinnerModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Yayın Planlama</h2>
        @if (canWrite()) {
          <button mat-raised-button color="primary" routerLink="/yayin-planlama/new">
            <mat-icon>add</mat-icon> Yeni
          </button>
        }
      </div>

      <div class="filter-bar">
        <mat-form-field appearance="outline">
          <mat-label>Event Key</mat-label>
          <input matInput name="eventKey" [(ngModel)]="eventKey"
                 (keyup.enter)="reload()" placeholder="opta:M-1234" />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Başlangıç</mat-label>
          <input matInput type="date" name="from" [(ngModel)]="dateFrom" (change)="reload()" />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Bitiş</mat-label>
          <input matInput type="date" name="to" [(ngModel)]="dateTo" (change)="reload()" />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Durum</mat-label>
          <mat-select [(ngModel)]="status" name="status" (selectionChange)="reload()">
            <mat-option [value]="null">(hepsi)</mat-option>
            <mat-option value="DRAFT">Taslak</mat-option>
            <mat-option value="CONFIRMED">Onaylı</mat-option>
            <mat-option value="COMPLETED">Tamamlandı</mat-option>
            <mat-option value="CANCELLED">İptal</mat-option>
          </mat-select>
        </mat-form-field>
        <button mat-button (click)="reload()">
          <mat-icon>refresh</mat-icon> Yenile
        </button>
      </div>

      @if (loading()) {
        <div class="state state-loading">
          <mat-progress-spinner mode="indeterminate" diameter="32"></mat-progress-spinner>
        </div>
      } @else if (error()) {
        <div class="state state-error">
          <mat-icon>error_outline</mat-icon>
          <span>{{ error() }}</span>
        </div>
      } @else if (rows().length === 0) {
        <div class="state state-empty">
          <mat-icon>event_available</mat-icon>
          <span>Yayın Planlama kaydı bulunamadı.</span>
        </div>
      } @else {
        <table mat-table [dataSource]="rows()" class="yp-table">
          <ng-container matColumnDef="title">
            <th mat-header-cell *matHeaderCellDef>Başlık</th>
            <td mat-cell *matCellDef="let r">{{ r.title }}</td>
          </ng-container>
          <ng-container matColumnDef="teams">
            <th mat-header-cell *matHeaderCellDef>Takım</th>
            <td mat-cell *matCellDef="let r">
              @if (r.team1Name && r.team2Name) {
                {{ r.team1Name }} vs {{ r.team2Name }}
              } @else {
                —
              }
            </td>
          </ng-container>
          <ng-container matColumnDef="date">
            <th mat-header-cell *matHeaderCellDef>Tarih</th>
            <td mat-cell *matCellDef="let r">{{ formatDate(r.scheduleDate) }}</td>
          </ng-container>
          <ng-container matColumnDef="time">
            <th mat-header-cell *matHeaderCellDef>Saat</th>
            <td mat-cell *matCellDef="let r">{{ formatTime(r.scheduleTime) }}</td>
          </ng-container>
          <ng-container matColumnDef="channels">
            <th mat-header-cell *matHeaderCellDef>Kanallar</th>
            <td mat-cell *matCellDef="let r">{{ countChannels(r) }}</td>
          </ng-container>
          <ng-container matColumnDef="status">
            <th mat-header-cell *matHeaderCellDef>Durum</th>
            <td mat-cell *matCellDef="let r"><mat-chip>{{ r.status }}</mat-chip></td>
          </ng-container>
          <ng-container matColumnDef="eventKey">
            <th mat-header-cell *matHeaderCellDef>Event Key</th>
            <td mat-cell *matCellDef="let r" class="event-key">{{ r.eventKey }}</td>
          </ng-container>
          <ng-container matColumnDef="actions">
            <th mat-header-cell *matHeaderCellDef></th>
            <td mat-cell *matCellDef="let r" class="actions-cell">
              @if (canWrite()) {
                <button mat-icon-button [routerLink]="['/yayin-planlama', r.id, 'edit']"
                        matTooltip="Düzenle" type="button">
                  <mat-icon>edit</mat-icon>
                </button>
              }
              @if (canDelete()) {
                <button mat-icon-button color="warn"
                        (click)="confirmDelete(r); $event.stopPropagation()"
                        matTooltip="Sil" type="button">
                  <mat-icon>delete</mat-icon>
                </button>
              }
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="cols"></tr>
          <tr mat-row *matRowDef="let row; columns: cols;"></tr>
        </table>
        <mat-paginator
          [length]="total()"
          [pageSize]="pageSize()"
          [pageIndex]="page() - 1"
          [pageSizeOptions]="[10, 25, 50, 100]"
          (page)="onPage($event)">
        </mat-paginator>
      }
    </div>
  `,
  styles: [`
    .page { padding: 24px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .page-header h2 { margin: 0; font-size: 20px; font-weight: 600; }
    .filter-bar { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 16px; }
    .yp-table { width: 100%; }
    .event-key { font-family: monospace; font-size: 12px; }
    .actions-cell { text-align: right; }
    .state { display: flex; align-items: center; gap: 12px; padding: 48px; justify-content: center; color: var(--mat-sys-on-surface-variant); }
    .state-error { color: var(--mat-sys-error); }
  `],
})
export class YayinPlanlamaListComponent implements OnInit {
  private router  = inject(Router);
  private dialog  = inject(MatDialog);
  private snack   = inject(MatSnackBar);
  private service = inject(YayinPlanlamaService);
  private keycloak = inject(KeycloakService, { optional: true });

  protected cols = ['title', 'teams', 'date', 'time', 'channels', 'status', 'eventKey', 'actions'];

  // Filter state
  protected eventKey  = '';
  protected dateFrom  = '';
  protected dateTo    = '';
  protected status: string | null = null;

  // Page state
  protected rows     = signal<Schedule[]>([]);
  protected total    = signal(0);
  protected page     = signal(1);
  protected pageSize = signal(PAGE_SIZE_DEFAULT);
  protected loading  = signal(false);
  protected error    = signal<string | null>(null);

  protected canWrite = computed<boolean>(() => this.hasGroup(PERMISSIONS.schedules.write));
  protected canDelete = computed<boolean>(() => this.hasGroup(PERMISSIONS.schedules.delete));

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.service.getList({
      eventKey: this.eventKey || undefined,
      from:     this.dateFrom || undefined,
      to:       this.dateTo   || undefined,
      status:   this.status   || undefined,
      page:     this.page(),
      pageSize: this.pageSize(),
    }).subscribe({
      next: (res) => {
        this.rows.set(res.data);
        this.total.set(res.total);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message ?? 'Liste yüklenemedi.');
        this.loading.set(false);
      },
    });
  }

  onPage(ev: PageEvent): void {
    this.page.set(ev.pageIndex + 1);
    this.pageSize.set(ev.pageSize);
    this.reload();
  }

  confirmDelete(row: Schedule): void {
    const data: ConfirmDialogData = {
      title:   'Yayın Planlama Sil',
      message: `"${row.title}" silinecek. Bağlı canlı yayın plan satırlarının kanal slotları boşa çekilir. Devam edilsin mi?`,
      confirmText: 'Sil',
      cancelText:  'İptal',
    };
    const ref = this.dialog.open(SegmentConfirmDialogComponent, { data });
    ref.afterClosed().subscribe((ok: boolean) => {
      if (ok) this.deleteRow(row);
    });
  }

  private deleteRow(row: Schedule): void {
    this.service.delete(row.id).subscribe({
      next: () => {
        this.snack.open('Yayın planlama silindi.', 'Kapat', { duration: 3000 });
        this.reload();
      },
      error: (err) => {
        this.snack.open(err?.error?.message ?? 'Silme başarısız.', 'Kapat', { duration: 5000 });
      },
    });
  }

  protected formatDate(date: string | null | undefined): string {
    if (!date) return '—';
    return date.slice(0, 10);
  }

  protected formatTime(time: string | null | undefined): string {
    if (!time) return '—';
    const m = /T(\d{2}:\d{2})/.exec(time);
    return m?.[1] ?? '—';
  }

  protected countChannels(row: Schedule): number {
    return [row.channel1Id, row.channel2Id, row.channel3Id].filter((v) => v != null).length;
  }

  private hasGroup(allowed: readonly string[]): boolean {
    if (allowed.length === 0) return true; // all authenticated
    if (isSkipAuthAllowed()) return true;
    const groups = (this.keycloak?.getKeycloakInstance()?.tokenParsed as BcmsTokenParsed | undefined)?.groups ?? [];
    if (groups.includes(GROUP.Admin)) return true;
    return groups.some((g) => allowed.includes(g));
  }
}
