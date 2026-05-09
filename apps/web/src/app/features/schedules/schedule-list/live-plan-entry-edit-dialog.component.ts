import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';

import { ScheduleService } from '../../../core/services/schedule.service';
import type { Schedule } from '@bcms/shared';

/**
 * Mutation restore (2026-05-10): Canlı Yayın Plan "Düzenle" canonical dialog.
 * PATCH /api/v1/live-plan/:id + If-Match: <version>. K9 invariant — version
 * mismatch 412 → snack + caller load() ile taze veri çeker.
 *
 * JSON/metadata YOK. Channel slot form'da YOK (K-B3.11/12 reverse sync).
 */
@Component({
  selector: 'app-live-plan-entry-edit-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatFormFieldModule, MatInputModule,
    MatButtonModule, MatIconModule,
    MatDialogModule, MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  template: `
    <h2 mat-dialog-title>Yayın Kaydını Düzenle</h2>
    <mat-dialog-content class="edit-dialog-content">
      <mat-form-field appearance="outline" style="width:100%">
        <mat-label>Yayın Adı</mat-label>
        <input matInput
               [(ngModel)]="form.title"
               [ngModelOptions]="{standalone:true}"
               maxlength="500"
               required>
      </mat-form-field>

      <div class="row">
        <mat-form-field appearance="outline" class="half">
          <mat-label>Başlangıç Tarihi</mat-label>
          <input matInput type="date"
                 [(ngModel)]="form.startDate"
                 [ngModelOptions]="{standalone:true}"
                 required>
        </mat-form-field>
        <mat-form-field appearance="outline" class="half">
          <mat-label>Başlangıç Saati</mat-label>
          <input matInput type="time"
                 [(ngModel)]="form.startTime"
                 [ngModelOptions]="{standalone:true}"
                 required>
        </mat-form-field>
      </div>

      <div class="row">
        <mat-form-field appearance="outline" class="half">
          <mat-label>Bitiş Tarihi</mat-label>
          <input matInput type="date"
                 [(ngModel)]="form.endDate"
                 [ngModelOptions]="{standalone:true}"
                 required>
        </mat-form-field>
        <mat-form-field appearance="outline" class="half">
          <mat-label>Bitiş Saati</mat-label>
          <input matInput type="time"
                 [(ngModel)]="form.endTime"
                 [ngModelOptions]="{standalone:true}"
                 required>
        </mat-form-field>
      </div>

      <div class="row">
        <mat-form-field appearance="outline" class="half">
          <mat-label>Takım 1</mat-label>
          <input matInput
                 [(ngModel)]="form.team1Name"
                 [ngModelOptions]="{standalone:true}"
                 maxlength="200">
        </mat-form-field>
        <mat-form-field appearance="outline" class="half">
          <mat-label>Takım 2</mat-label>
          <input matInput
                 [(ngModel)]="form.team2Name"
                 [ngModelOptions]="{standalone:true}"
                 maxlength="200">
        </mat-form-field>
      </div>

      <mat-form-field appearance="outline" style="width:100%">
        <mat-label>Operasyon Notları</mat-label>
        <textarea matInput
                  [(ngModel)]="form.operationNotes"
                  [ngModelOptions]="{standalone:true}"
                  rows="3"
                  maxlength="8000"></textarea>
      </mat-form-field>

      @if (errorMsg()) {
        <p class="err">{{ errorMsg() }}</p>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>İptal</button>
      <button mat-raised-button color="primary"
              [disabled]="saving() || !canSave()"
              (click)="save()">
        @if (saving()) { <mat-spinner diameter="18" style="display:inline-block"></mat-spinner> }
        @else { Kaydet }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .edit-dialog-content { min-width: 520px; max-width: 720px; padding: 12px 16px 8px; }
    .row { display: flex; gap: 8px; }
    .half { flex: 1 1 0; }
    .err  { color: #f44336; font-size: 12px; margin: 4px 0 0; }
  `],
})
export class LivePlanEntryEditDialogComponent {
  data      = inject<{ schedule: Schedule }>(MAT_DIALOG_DATA);
  private dialogRef = inject(MatDialogRef<LivePlanEntryEditDialogComponent>);
  private service   = inject(ScheduleService);
  private snack     = inject(MatSnackBar);

  saving    = signal(false);
  errorMsg  = signal('');

  form: {
    title:          string;
    startDate:      string;
    startTime:      string;
    endDate:        string;
    endTime:        string;
    team1Name:      string;
    team2Name:      string;
    operationNotes: string;
  };

  constructor() {
    const s = this.data.schedule;
    const start = new Date(s.startTime);
    const end   = new Date(s.endTime);
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateOf = (d: Date) =>
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const timeOf = (d: Date) =>
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

    this.form = {
      title:          s.title ?? '',
      startDate:      dateOf(start),
      startTime:      timeOf(start),
      endDate:        dateOf(end),
      endTime:        timeOf(end),
      team1Name:      s.team1Name ?? '',
      team2Name:      s.team2Name ?? '',
      operationNotes: '',
    };
  }

  canSave(): boolean {
    const f = this.form;
    return !!(f.title.trim() && f.startDate && f.startTime && f.endDate && f.endTime);
  }

  save(): void {
    if (!this.canSave() || this.saving()) return;
    this.saving.set(true);
    this.errorMsg.set('');

    const s = this.data.schedule;
    const f = this.form;
    const startISO = new Date(`${f.startDate}T${f.startTime}:00.000Z`).toISOString();
    const endISO   = new Date(`${f.endDate}T${f.endTime}:00.000Z`).toISOString();

    this.service.updateLivePlanEntry(s.id, {
      title:           f.title.trim(),
      eventStartTime:  startISO,
      eventEndTime:    endISO,
      team1Name:       f.team1Name.trim() || null,
      team2Name:       f.team2Name.trim() || null,
      operationNotes:  f.operationNotes.trim() || null,
    }, s.version).subscribe({
      next:  (updated) => { this.saving.set(false); this.dialogRef.close(updated); },
      error: (e)       => {
        this.saving.set(false);
        const msg = e?.status === 412
          ? 'Kayıt başka biri tarafından güncellendi; lütfen yenileyip tekrar deneyin'
          : (e?.error?.message ?? e?.message ?? 'Güncelleme başarısız');
        this.errorMsg.set(msg);
        this.snack.open(msg, 'Kapat', { duration: 4000 });
        if (e?.status === 412) {
          this.dialogRef.close({ stale: true });
        }
      },
    });
  }
}
