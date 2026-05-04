import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatDialog, MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatTableModule } from '@angular/material/table';
import { inject } from '@angular/core';
import { KeycloakService } from 'keycloak-angular';
import { environment } from '../../../../environments/environment';

import { ApiService } from '../../../core/services/api.service';
import { GROUP } from '@bcms/shared';
import type { Booking, BookingStatus, PaginatedResponse } from '@bcms/shared';
import type { BcmsTokenParsed } from '../../../core/types/auth';

interface BookingListResponse extends PaginatedResponse<Booking> {
  groups: string[];
  canAssignGroups: string[];
}

interface AssignableUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  userType: 'staff' | 'supervisor';
}

const STATUS_OPTIONS: Array<{ value: BookingStatus; label: string }> = [
  { value: 'PENDING', label: 'Açık' },
  { value: 'APPROVED', label: 'Tamamlandı' },
  { value: 'REJECTED', label: 'Reddedildi' },
  { value: 'CANCELLED', label: 'İptal' },
];

function dateOnly(value?: string | null): string {
  return value ? String(value).slice(0, 10) : '';
}

function todayDateOnly(): string {
  return new Date().toLocaleDateString('en-CA');
}

@Component({
  selector: 'app-booking-task-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule, MatButtonModule, MatDialogModule, MatFormFieldModule,
    MatInputModule, MatSelectModule, MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ data.booking ? 'İşi Düzenle' : 'Yeni İş' }}</h2>
    <mat-dialog-content class="dialog-content">
      <div class="form-grid">
        <mat-form-field class="wide">
          <mat-label>İş Başlığı</mat-label>
          <input matInput [(ngModel)]="form.taskTitle" [ngModelOptions]="{standalone:true}">
        </mat-form-field>
        <mat-form-field>
          <mat-label>Grup</mat-label>
          <mat-select [(ngModel)]="form.userGroup" [disabled]="!!data.booking" [ngModelOptions]="{standalone:true}" (selectionChange)="onGroupChange()">
            @for (group of data.groups; track group) {
              <mat-option [value]="group">{{ group }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Başlama Tarihi</mat-label>
          <input matInput type="date" [(ngModel)]="form.startDate" [ngModelOptions]="{standalone:true}">
        </mat-form-field>
        <mat-form-field>
          <mat-label>Tamamlanma Tarihi</mat-label>
          <input matInput type="date" [(ngModel)]="form.dueDate" [ngModelOptions]="{standalone:true}">
        </mat-form-field>
        @if (canAssign()) {
          <mat-form-field>
            <mat-label>Sorumlu Kullanıcı</mat-label>
            <mat-select [(ngModel)]="form.assigneeId" [ngModelOptions]="{standalone:true}" (selectionChange)="syncAssigneeName()">
              <mat-option [value]="null">—</mat-option>
              @for (user of assignees(); track user.id) {
                <mat-option [value]="user.id">{{ user.displayName }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        }
        <mat-form-field>
          <mat-label>Durum</mat-label>
          <mat-select [(ngModel)]="form.status" [ngModelOptions]="{standalone:true}">
            @for (status of statuses; track status.value) {
              <mat-option [value]="status.value">{{ status.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field class="wide">
          <mat-label>İş Detayları</mat-label>
          <textarea matInput rows="4" [(ngModel)]="form.taskDetails" [ngModelOptions]="{standalone:true}"></textarea>
        </mat-form-field>
        <mat-form-field class="wide">
          <mat-label>Rapor</mat-label>
          <textarea matInput rows="4" [(ngModel)]="form.taskReport" [ngModelOptions]="{standalone:true}"></textarea>
        </mat-form-field>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>İptal</button>
      <button mat-raised-button color="primary" [disabled]="!canSave() || saving()" (click)="save()">
        @if (saving()) { <mat-spinner diameter="16"></mat-spinner> } @else { Kaydet }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .dialog-content { min-width: min(820px, 94vw); }
    .form-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:12px; }
    .wide { grid-column: 1 / -1; }
    mat-spinner { display:inline-block; margin-right:6px; }
    @media (max-width: 720px) {
      .form-grid { grid-template-columns:1fr; }
    }
  `],
})
export class BookingTaskDialogComponent implements OnInit {
  data = inject<{
    booking?: Booking;
    groups: string[];
    canAssignGroups: string[];
  }>(MAT_DIALOG_DATA);
  dialogRef = inject(MatDialogRef<BookingTaskDialogComponent>);
  api = inject(ApiService);
  snack = inject(MatSnackBar);

  statuses = STATUS_OPTIONS;
  assignees = signal<AssignableUser[]>([]);
  saving = signal(false);

  form = {
    taskTitle: this.data.booking?.taskTitle ?? '',
    userGroup: this.data.booking?.userGroup ?? this.data.groups[0] ?? '',
    taskDetails: this.data.booking?.taskDetails ?? '',
    taskReport: this.data.booking?.taskReport ?? '',
    assigneeId: this.data.booking?.assigneeId ?? null as string | null,
    assigneeName: this.data.booking?.assigneeName ?? null as string | null,
    startDate: dateOnly(this.data.booking?.startDate) || todayDateOnly(),
    dueDate: dateOnly(this.data.booking?.dueDate),
    status: this.data.booking?.status ?? 'PENDING' as BookingStatus,
  };

  ngOnInit(): void {
    this.loadAssignees();
  }

  canAssign(): boolean {
    return this.data.canAssignGroups.includes(this.form.userGroup);
  }

  canSave(): boolean {
    return Boolean(this.form.taskTitle.trim() && this.form.userGroup);
  }

  loadAssignees(): void {
    if (!this.form.userGroup || !this.canAssign()) return;
    this.api.get<AssignableUser[]>('/bookings/assignees', { group: this.form.userGroup }).subscribe({
      next: (users) => this.assignees.set(users),
      error: () => this.assignees.set([]),
    });
  }

  onGroupChange(): void {
    this.form.assigneeId = null;
    this.form.assigneeName = null;
    this.assignees.set([]);
    this.loadAssignees();
  }

  syncAssigneeName(): void {
    const user = this.assignees().find((item) => item.id === this.form.assigneeId);
    this.form.assigneeName = user?.displayName ?? null;
  }

  save(): void {
    if (!this.canSave()) return;
    const payload: Record<string, unknown> = {
      taskTitle: this.form.taskTitle.trim(),
      userGroup: this.form.userGroup,
      status: this.form.status,
    };
    if (this.form.taskDetails) payload['taskDetails'] = this.form.taskDetails;
    if (this.form.taskReport) payload['taskReport'] = this.form.taskReport;
    if (this.form.startDate) payload['startDate'] = this.form.startDate;
    if (this.form.dueDate) payload['dueDate'] = this.form.dueDate;
    if (this.canAssign()) {
      if (this.form.assigneeId) payload['assigneeId'] = this.form.assigneeId;
      if (this.form.assigneeName) payload['assigneeName'] = this.form.assigneeName;
    }
    this.saving.set(true);
    const request = this.data.booking
      ? this.api.patch<Booking>(`/bookings/${this.data.booking.id}`, payload, this.data.booking.version)
      : this.api.post<Booking>('/bookings', payload);
    request.subscribe({
      next: (booking) => { this.saving.set(false); this.dialogRef.close(booking); },
      error: (err) => {
        this.saving.set(false);
        this.snack.open(err?.error?.message ?? 'İş kaydedilemedi', 'Kapat', { duration: 4000 });
      },
    });
  }
}

@Component({
  selector: 'app-booking-list',
  standalone: true,
  imports: [
    CommonModule, FormsModule, MatButtonModule, MatIconModule, MatCardModule,
    MatSnackBarModule, MatTooltipModule, MatProgressSpinnerModule, MatFormFieldModule,
    MatInputModule, MatSelectModule, MatDialogModule, MatTableModule,
  ],
  template: `
    <div class="page">
      <div class="toolbar">
        <div>
          <h1>Ekip iş takip</h1>
          <p>Grup içi iş takip sistemi</p>
        </div>
        <div class="toolbar-actions">
          <mat-form-field appearance="outline">
            <mat-label>Grup</mat-label>
            <mat-select [(ngModel)]="selectedGroup" [ngModelOptions]="{standalone:true}" (selectionChange)="load()">
              <mat-option value="">Tümü</mat-option>
              @for (group of groups(); track group) {
                <mat-option [value]="group">{{ group }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <button mat-raised-button color="primary" (click)="openDialog()">
            <mat-icon>add</mat-icon>
            Yeni İş
          </button>
        </div>
      </div>

      @if (loading()) {
        <div class="spinner"><mat-spinner diameter="40"></mat-spinner></div>
      } @else {
        <div class="table-wrapper">
          <table mat-table [dataSource]="bookings()" class="booking-table">
            <ng-container matColumnDef="taskTitle">
              <th mat-header-cell *matHeaderCellDef>İş Başlığı</th>
              <td mat-cell *matCellDef="let task">{{ task.taskTitle || task.schedule?.title || 'İş Kaydı' }}</td>
            </ng-container>
            <ng-container matColumnDef="userGroup">
              <th mat-header-cell *matHeaderCellDef>Grup</th>
              <td mat-cell *matCellDef="let task">{{ task.userGroup || '—' }}</td>
            </ng-container>
            <ng-container matColumnDef="requestedBy">
              <th mat-header-cell *matHeaderCellDef>Oluşturan</th>
              <td mat-cell *matCellDef="let task">{{ task.requestedByName || task.requestedBy || '—' }}</td>
            </ng-container>
            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef>Durum</th>
              <td mat-cell *matCellDef="let task">
                <span [class]="'status-badge ' + task.status">{{ statusLabel(task.status) }}</span>
              </td>
            </ng-container>
            <ng-container matColumnDef="dates">
              <th mat-header-cell *matHeaderCellDef>Tarih</th>
              <td mat-cell *matCellDef="let task">{{ dateOnly(task.startDate) || '—' }} - {{ dateOnly(task.dueDate) || '—' }}</td>
            </ng-container>
            <ng-container matColumnDef="assignee">
              <th mat-header-cell *matHeaderCellDef>Sorumlu</th>
              <td mat-cell *matCellDef="let task">{{ task.assigneeName || '—' }}</td>
            </ng-container>
            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let task" class="actions-cell">
                <button mat-icon-button matTooltip="Düzenle" (click)="openDialog(task)">
                  <mat-icon>edit</mat-icon>
                </button>
                @if (canDelete(task)) {
                  <button mat-icon-button color="warn" matTooltip="Sil" (click)="deleteTask(task)">
                    <mat-icon>delete</mat-icon>
                  </button>
                }
              </td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
            <tr mat-row *matRowDef="let row; columns: displayedColumns;"></tr>
          </table>
          @if (bookings().length === 0) {
            <div class="empty">Bu grup için iş kaydı yok.</div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    /* beINport UI V2 — Material Table aware deep restyle, HTML/logic untouched */
    .page { padding: var(--bp-sp-6) var(--bp-sp-8) var(--bp-sp-8); display:flex; flex-direction:column; gap: var(--bp-sp-4); }
    .toolbar {
      display:flex; align-items:flex-start; justify-content:space-between; gap: var(--bp-sp-4); flex-wrap:wrap;
      padding-bottom: var(--bp-sp-3); border-bottom: 1px solid var(--bp-line-2);
    }
    h1 { margin:0; font-family: var(--bp-font-display); font-size: var(--bp-text-3xl); font-weight: var(--bp-fw-semibold); letter-spacing: var(--bp-ls-tight); color: var(--bp-fg-1); }
    p { margin: 4px 0 0; color: var(--bp-fg-3); font-size: 12.5px; }
    .toolbar-actions { display:flex; align-items:center; gap: var(--bp-sp-3); flex-wrap:wrap; }
    .toolbar-actions mat-form-field { width: 180px; }

    .table-wrapper {
      overflow-x: auto;
      background: var(--bp-bg-2);
      border: 1px solid var(--bp-line-2);
      border-radius: var(--bp-r-lg);
    }

    /* Material MatTable token override — beINport */
    .booking-table.mat-mdc-table {
      background: transparent;
      width: 100%;
      --mat-table-background-color: transparent;
      --mat-table-header-container-color: var(--bp-bg-3);
      --mat-table-row-item-container-color: transparent;
      --mat-table-header-headline-color: var(--bp-fg-2);
      --mat-table-row-item-label-text-color: var(--bp-fg-1);
      --mat-table-row-item-outline-color: var(--bp-line-2);
    }
    .booking-table .mat-mdc-header-cell {
      background: var(--bp-bg-3);
      color: var(--bp-fg-2);
      font-weight: var(--bp-fw-bold);
      font-size: 9.5px;
      text-transform: uppercase;
      letter-spacing: var(--bp-ls-eyebrow);
      border-bottom: 1px solid var(--bp-line-2);
      padding: 10px 14px;
      white-space: nowrap;
    }
    .booking-table .mat-mdc-cell {
      color: var(--bp-fg-1);
      font-size: 12.5px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--bp-line-2);
    }
    .booking-table .mat-mdc-row:last-child .mat-mdc-cell {
      border-bottom: 0;
    }
    .booking-table .mat-mdc-row:hover .mat-mdc-cell {
      background: rgba(124, 58, 237, 0.06);
    }

    .status-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: var(--bp-r-pill);
      font-size: 9.5px;
      font-weight: var(--bp-fw-bold);
      letter-spacing: var(--bp-ls-status);
      text-transform: uppercase;
    }
    .status-badge.PENDING   { background: var(--bp-status-PENDING-bg);   color: var(--bp-status-PENDING-fg); }
    .status-badge.APPROVED  { background: var(--bp-status-APPROVED-bg);  color: var(--bp-status-APPROVED-fg); }
    .status-badge.REJECTED  { background: var(--bp-status-REJECTED-bg);  color: var(--bp-status-REJECTED-fg); }
    .status-badge.CANCELLED { background: var(--bp-status-CANCELLED-bg); color: var(--bp-status-CANCELLED-fg); }

    .actions-cell { white-space: nowrap; text-align: right; }
    .empty, .spinner {
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 48px;
      color: var(--bp-fg-3);
      font-size: 13px;
      text-align: center;
    }
  `],
})
export class BookingListComponent implements OnInit {
  private api = inject(ApiService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  private keycloak = inject(KeycloakService);

  bookings = signal<Booking[]>([]);
  groups = signal<string[]>([]);
  canAssignGroups = signal<string[]>([]);
  username = signal('');
  userId = signal('');
  isAdmin = signal(false);
  loading = signal(false);
  selectedGroup = '';
  displayedColumns = ['taskTitle', 'userGroup', 'requestedBy', 'status', 'dates', 'assignee', 'actions'];

  readonly visibleGroups = computed(() => this.groups());

  ngOnInit(): void {
    this.loadIdentity();
    this.load();
  }

  load(): void {
    this.loading.set(true);
    const params = this.selectedGroup ? { group: this.selectedGroup } : undefined;
    this.api.get<BookingListResponse>('/bookings', params).subscribe({
      next: (res) => {
        const sorted = [...res.data].sort((a, b) => {
          const aOpen = a.status === 'PENDING' ? 1 : 0;
          const bOpen = b.status === 'PENDING' ? 1 : 0;
          if (aOpen !== bOpen) return bOpen - aOpen;
          const ad = String(a.startDate || '').localeCompare(String(b.startDate || ''));
          return ad;
        });
        this.bookings.set(sorted);
        this.groups.set(res.groups ?? []);
        this.canAssignGroups.set(res.canAssignGroups ?? []);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.showError(err);
      },
    });
  }

  openDialog(booking?: Booking): void {
    const ref = this.dialog.open(BookingTaskDialogComponent, {
      width: '900px',
      maxWidth: '96vw',
      panelClass: 'dark-dialog',
      data: {
        booking,
        groups: this.groups(),
        canAssignGroups: this.canAssignGroups(),
      },
    });
    ref.afterClosed().subscribe((changed) => {
      if (changed) {
        this.snackBar.open('İş kaydedildi', 'Kapat', { duration: 2500 });
        this.load();
      }
    });
  }

  statusLabel(status: string): string {
    return STATUS_OPTIONS.find((item) => item.value === status)?.label ?? status;
  }

  dateOnly = dateOnly;

  canDelete(task: Booking): boolean {
    return this.isAdmin()
      || task.requestedBy === this.username()
      || task.assigneeId === this.userId()
      || task.assigneeName === this.username();
  }

  deleteTask(task: Booking): void {
    if (!confirm(`"${task.taskTitle || 'İş Kaydı'}" silinsin mi?`)) return;
    this.api.delete<void>(`/bookings/${task.id}`).subscribe({
      next: () => {
        this.snackBar.open('İş silindi', 'Kapat', { duration: 2500 });
        this.load();
      },
      error: (err) => this.showError(err),
    });
  }

  private loadIdentity(): void {
    if (environment.skipAuth) {
      this.username.set('dev-admin');
      this.isAdmin.set(true);
      return;
    }
    const parsed = this.keycloak.getKeycloakInstance().tokenParsed as BcmsTokenParsed | undefined;
    const groups: string[] = parsed?.groups ?? [];
    this.username.set(parsed?.preferred_username ?? '');
    this.userId.set(parsed?.sub ?? '');
    // 2026-05-01: SystemEng kaldırıldı — sadece Admin "tüm grupları gör + her atamayı yap"
    // yetkisinde. Backend isAdminUser() ve PERMISSIONS.weeklyShifts.admin=['Admin'] ile hizalı.
    this.isAdmin.set(groups.includes(GROUP.Admin));
  }

  private showError(err: { status?: number; error?: { message?: string } }): void {
    const msg = err.status === 412
      ? 'Versiyon çakışması, liste yenileniyor'
      : (err.error?.message ?? 'Bir hata oluştu');
    this.snackBar.open(msg, 'Kapat', { duration: 4000 });
    if (err.status === 412) this.load();
  }
}
