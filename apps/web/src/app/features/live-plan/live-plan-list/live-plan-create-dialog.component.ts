import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { ApiService } from '../../../core/services/api.service';
import {
  LIVE_PLAN_STATUS_LABELS,
  livePlanEndpoint,
  type CreateLivePlanBody, type LivePlanEntry, type LivePlanStatus,
} from '../live-plan.types';

/**
 * Madde 5 M5-B10a — minimal Live-Plan Entry create dialog.
 *
 * 6 mat-tab full form M5-B10b'de gelir. Bu PR'da sadece:
 *   - title
 *   - eventStartTime (UTC datetime-local)
 *   - eventEndTime
 *   - status (default PLANNED)
 *
 * Backend: M5-B2 POST /api/v1/live-plan, K9 If-Match (PATCH/DELETE'te).
 */
@Component({
  selector: 'app-live-plan-create-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule, MatDialogModule, MatButtonModule,
    MatFormFieldModule, MatInputModule, MatSelectModule, MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title>Yeni Canlı Yayın Plan</h2>
    <mat-dialog-content style="min-width:380px">
      <div style="display:flex;flex-direction:column;gap:4px">
        <mat-form-field>
          <mat-label>Başlık *</mat-label>
          <input matInput [(ngModel)]="form.title" name="title" maxlength="500">
        </mat-form-field>

        <div style="display:flex;gap:12px">
          <mat-form-field style="flex:1">
            <mat-label>Başlangıç (UTC) *</mat-label>
            <input matInput type="datetime-local" [(ngModel)]="form.startLocal" name="startLocal">
          </mat-form-field>
          <mat-form-field style="flex:1">
            <mat-label>Bitiş (UTC) *</mat-label>
            <input matInput type="datetime-local" [(ngModel)]="form.endLocal" name="endLocal">
          </mat-form-field>
        </div>

        <mat-form-field>
          <mat-label>Durum</mat-label>
          <mat-select [(ngModel)]="form.status" name="status">
            @for (s of statuses; track s) {
              <mat-option [value]="s">{{ statusLabel(s) }} ({{ s }})</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </div>

      @if (errorMsg()) {
        <p style="color:#f44336;font-size:12px;margin:8px 0 0">{{ errorMsg() }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close [disabled]="saving()">İptal</button>
      <button mat-raised-button color="primary"
              [disabled]="saving() || !canSave()"
              (click)="save()">
        {{ saving() ? 'Kaydediliyor…' : 'Kaydet' }}
      </button>
    </mat-dialog-actions>
  `,
})
export class LivePlanCreateDialogComponent {
  dialogRef = inject(MatDialogRef<LivePlanCreateDialogComponent>);
  private api = inject(ApiService);

  statuses: LivePlanStatus[] = ['PLANNED', 'READY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
  statusLabel = (s: LivePlanStatus) => LIVE_PLAN_STATUS_LABELS[s];

  saving   = signal(false);
  errorMsg = signal('');

  form = {
    title:      '',
    startLocal: '',
    endLocal:   '',
    status:     'PLANNED' as LivePlanStatus,
  };

  canSave(): boolean {
    if (!this.form.title.trim()) return false;
    if (!this.form.startLocal || !this.form.endLocal) return false;
    const s = new Date(`${this.form.startLocal}:00Z`).getTime();
    const e = new Date(`${this.form.endLocal}:00Z`).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return false;
    return true;
  }

  save() {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.errorMsg.set('');

    const body: CreateLivePlanBody = {
      title:          this.form.title.trim(),
      eventStartTime: `${this.form.startLocal}:00Z`,
      eventEndTime:   `${this.form.endLocal}:00Z`,
      status:         this.form.status,
    };
    this.api.post<LivePlanEntry>(livePlanEndpoint.list(), body).subscribe({
      next: (entry) => { this.saving.set(false); this.dialogRef.close(entry); },
      error: (err: { error?: { message?: string }; message?: string }) => {
        this.saving.set(false);
        this.errorMsg.set(err?.error?.message ?? err?.message ?? 'Oluşturulamadı');
      },
    });
  }
}
