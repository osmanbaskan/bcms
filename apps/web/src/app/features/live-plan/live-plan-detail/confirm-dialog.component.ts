import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

export interface ConfirmDialogData {
  title:        string;
  message:      string;
  confirmText?: string;
  cancelText?:  string;
  confirmColor?: 'warn' | 'primary';
}

/**
 * Madde 5 M5-B10a — Confirm dialog (admin-lookups M5-B6 paritesi).
 * Reusable; ileride core/shared'a taşınabilir (ortak refactor).
 */
@Component({
  selector: 'app-segment-confirm-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content style="min-width:320px">
      <p style="margin:0">{{ data.message }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button [mat-dialog-close]="false">{{ data.cancelText ?? 'İptal' }}</button>
      <button mat-raised-button
              [color]="data.confirmColor ?? 'warn'"
              [mat-dialog-close]="true"
              cdkFocusInitial>
        {{ data.confirmText ?? 'Onayla' }}
      </button>
    </mat-dialog-actions>
  `,
})
export class SegmentConfirmDialogComponent {
  data      = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
  dialogRef = inject(MatDialogRef<SegmentConfirmDialogComponent>);
}
