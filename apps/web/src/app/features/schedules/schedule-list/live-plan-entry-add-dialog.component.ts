import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { MatDividerModule } from '@angular/material/divider';

import { ScheduleService } from '../../../core/services/schedule.service';
import { composeIstanbulIso } from '../../../core/time/tz.helpers';

/**
 * Mutation restore (2026-05-10): Canlı Yayın Plan "Yeni Ekle" canonical
 * dialog. İki sekme:
 *   - Fikstürden Seç → POST /api/v1/live-plan/from-opta { optaMatchId }
 *   - Manuel        → POST /api/v1/live-plan { title, eventStart/EndTime, ... }
 *
 * JSON/metadata YOK. Channel slot manuel form'da YOK (K-B3.11/12 reverse
 * sync ile broadcast flow'tan beslenir). Status default backend'de PLANNED
 * olduğu için body'de gönderilmez.
 */
@Component({
  selector: 'app-live-plan-entry-add-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatFormFieldModule, MatInputModule,
    MatButtonModule, MatIconModule,
    MatDialogModule, MatProgressSpinnerModule,
    MatSnackBarModule, MatTabsModule, MatDividerModule,
  ],
  template: `
    <h2 mat-dialog-title>Yeni Yayın Kaydı Ekle</h2>
    <mat-dialog-content class="add-dialog-content">
      <mat-tab-group [(selectedIndex)]="activeTab" animationDuration="150ms">

        <!-- ══ Sekme 1: Fikstürden Seç ════════════════════════════════ -->
        <mat-tab label="Fikstürden Seç">
          <div class="tab-body">
            <p class="hint">
              OPTA fikstüründen seçim ile canlı yayın planı oluştur.
              Sistem maç tarih/saat ve takım bilgisini otomatik kopyalar.
            </p>
            <mat-form-field appearance="outline" style="width:100%">
              <mat-label>OPTA Match ID</mat-label>
              <input matInput
                     [(ngModel)]="optaMatchId"
                     [ngModelOptions]="{standalone:true}"
                     placeholder="örn. opta-12345"
                     maxlength="80">
            </mat-form-field>
            @if (errorMsg() && activeTab === 0) {
              <p class="err">{{ errorMsg() }}</p>
            }
          </div>
        </mat-tab>

        <!-- ══ Sekme 2: Manuel ════════════════════════════════════════ -->
        <mat-tab label="Manuel">
          <div class="tab-body">
            <mat-form-field appearance="outline" style="width:100%">
              <mat-label>Yayın Adı</mat-label>
              <input matInput
                     [(ngModel)]="manual.title"
                     [ngModelOptions]="{standalone:true}"
                     maxlength="500"
                     required>
            </mat-form-field>

            <div class="row">
              <mat-form-field appearance="outline" class="half">
                <mat-label>Başlangıç Tarihi</mat-label>
                <input matInput type="date"
                       [(ngModel)]="manual.startDate"
                       [ngModelOptions]="{standalone:true}"
                       required>
              </mat-form-field>
              <mat-form-field appearance="outline" class="half">
                <mat-label>Başlangıç Saati</mat-label>
                <input matInput type="time"
                       [(ngModel)]="manual.startTime"
                       [ngModelOptions]="{standalone:true}"
                       required>
              </mat-form-field>
            </div>

            <div class="row">
              <mat-form-field appearance="outline" class="half">
                <mat-label>Bitiş Tarihi</mat-label>
                <input matInput type="date"
                       [(ngModel)]="manual.endDate"
                       [ngModelOptions]="{standalone:true}"
                       required>
              </mat-form-field>
              <mat-form-field appearance="outline" class="half">
                <mat-label>Bitiş Saati</mat-label>
                <input matInput type="time"
                       [(ngModel)]="manual.endTime"
                       [ngModelOptions]="{standalone:true}"
                       required>
              </mat-form-field>
            </div>

            <div class="row">
              <mat-form-field appearance="outline" class="half">
                <mat-label>Takım 1</mat-label>
                <input matInput
                       [(ngModel)]="manual.team1Name"
                       [ngModelOptions]="{standalone:true}"
                       maxlength="200">
              </mat-form-field>
              <mat-form-field appearance="outline" class="half">
                <mat-label>Takım 2</mat-label>
                <input matInput
                       [(ngModel)]="manual.team2Name"
                       [ngModelOptions]="{standalone:true}"
                       maxlength="200">
              </mat-form-field>
            </div>

            <mat-form-field appearance="outline" style="width:100%">
              <mat-label>Operasyon Notları</mat-label>
              <textarea matInput
                        [(ngModel)]="manual.operationNotes"
                        [ngModelOptions]="{standalone:true}"
                        rows="3"
                        maxlength="8000"></textarea>
            </mat-form-field>

            @if (errorMsg() && activeTab === 1) {
              <p class="err">{{ errorMsg() }}</p>
            }
          </div>
        </mat-tab>

      </mat-tab-group>
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
    .add-dialog-content { min-width: 520px; max-width: 720px; padding: 12px 16px 8px; }
    .tab-body { display: flex; flex-direction: column; gap: 8px; padding: 12px 4px 0; }
    .row { display: flex; gap: 8px; }
    .half { flex: 1 1 0; }
    .hint { color: var(--bp-fg-3); font-size: 12px; line-height: 1.4; margin: 4px 0 12px; }
    .err  { color: #f44336; font-size: 12px; margin: 4px 0 0; }
  `],
})
export class LivePlanEntryAddDialogComponent {
  private dialogRef = inject(MatDialogRef<LivePlanEntryAddDialogComponent>);
  private service   = inject(ScheduleService);
  private snack     = inject(MatSnackBar);

  activeTab = 0;
  saving    = signal(false);
  errorMsg  = signal('');

  optaMatchId = '';

  manual = {
    title:          '',
    startDate:      '',
    startTime:      '',
    endDate:        '',
    endTime:        '',
    team1Name:      '',
    team2Name:      '',
    operationNotes: '',
  };

  canSave(): boolean {
    if (this.activeTab === 0) {
      return this.optaMatchId.trim().length > 0;
    }
    const m = this.manual;
    return !!(m.title.trim() && m.startDate && m.startTime && m.endDate && m.endTime);
  }

  save(): void {
    if (!this.canSave() || this.saving()) return;
    this.saving.set(true);
    this.errorMsg.set('');

    if (this.activeTab === 0) {
      this.service.createLivePlanFromOpta({ optaMatchId: this.optaMatchId.trim() }).subscribe({
        next:  (created) => { this.saving.set(false); this.dialogRef.close(created); },
        error: (e)       => {
          this.saving.set(false);
          const msg = e?.error?.message ?? e?.message ?? 'Yayın oluşturulamadı';
          this.errorMsg.set(msg);
          this.snack.open(msg, 'Kapat', { duration: 4000 });
        },
      });
      return;
    }

    const m = this.manual;
    // Timezone Lock: kullanıcı girdiği saat Türkiye saatidir; UTC instant'a
    // çevirmek için composeIstanbulIso kullan (önceki `T${time}.000Z` pattern
    // 3 saatlik kayma yaratıyordu).
    const startISO = composeIstanbulIso(m.startDate, m.startTime);
    const endISO   = composeIstanbulIso(m.endDate, m.endTime);

    this.service.createLivePlanEntry({
      title:           m.title.trim(),
      eventStartTime:  startISO,
      eventEndTime:    endISO,
      ...(m.team1Name.trim()      ? { team1Name:      m.team1Name.trim() }      : {}),
      ...(m.team2Name.trim()      ? { team2Name:      m.team2Name.trim() }      : {}),
      ...(m.operationNotes.trim() ? { operationNotes: m.operationNotes.trim() } : {}),
    }).subscribe({
      next:  (created) => { this.saving.set(false); this.dialogRef.close(created); },
      error: (e)       => {
        this.saving.set(false);
        const msg = e?.error?.message ?? e?.message ?? 'Yayın oluşturulamadı';
        this.errorMsg.set(msg);
        this.snack.open(msg, 'Kapat', { duration: 4000 });
      },
    });
  }
}
