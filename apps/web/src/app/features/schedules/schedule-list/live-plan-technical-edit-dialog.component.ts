import { Component, Inject, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import {
  MatDialogModule, MatDialogRef, MAT_DIALOG_DATA,
} from '@angular/material/dialog';

import { TechnicalDetailsFormComponent } from '../../live-plan/live-plan-detail/technical-details-form.component';

/**
 * Teknik Düzenle dialog wrapper (2026-05-13): schedule-list Teknik butonu
 * artık `/live-plan/:entryId` sayfasına navigate etmek yerine bu dialog'u
 * açar. Mevcut `/live-plan/:entryId` route'u korunur (deeplink).
 *
 * Reuse pattern: `TechnicalDetailsFormComponent` aynı dosya iki yerde
 * kullanılır (page wrapper + bu dialog). Form route-decoupled olduğu için
 * standalone child gibi düşür.
 *
 * Auto-close: form `(saved)` event'inde dialog `'saved'` ile kapanır;
 * schedule-list afterClosed'da `this.load()` reload eder. Kapat/Escape
 * `undefined` ile kapanır, schedule-list reload yapmaz.
 */
export interface LivePlanTechnicalEditDialogData {
  entryId:   number;
  canWrite:  boolean;
  canDelete: boolean;
}

@Component({
  selector: 'app-live-plan-technical-edit-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    TechnicalDetailsFormComponent,
  ],
  template: `
    <h2 mat-dialog-title>Teknik Düzenle</h2>
    <mat-dialog-content class="tech-dialog-content">
      <app-technical-details-form
        [entryId]="data.entryId"
        [canWrite]="data.canWrite"
        [canDelete]="data.canDelete"
        (saved)="onSaved()">
      </app-technical-details-form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onClose()">Kapat</button>
    </mat-dialog-actions>
  `,
  styles: [`
    :host { display:block; }
    .tech-dialog-content {
      min-width: min(1240px, 96vw);
      max-height: 92vh;
      overflow: auto;
      padding: 16px 24px;
    }
  `],
})
export class LivePlanTechnicalEditDialogComponent {
  private dialogRef = inject(MatDialogRef<LivePlanTechnicalEditDialogComponent, 'saved' | undefined>);

  constructor(@Inject(MAT_DIALOG_DATA) public data: LivePlanTechnicalEditDialogData) {}

  onSaved(): void {
    this.dialogRef.close('saved');
  }

  onClose(): void {
    this.dialogRef.close();
  }
}
