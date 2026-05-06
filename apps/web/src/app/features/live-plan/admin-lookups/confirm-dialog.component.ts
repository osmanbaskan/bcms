import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

export interface ConfirmDialogData {
  title:        string;
  message:      string;
  confirmText?: string;
  cancelText?:  string;
  /** Mat-button color: 'warn' (default) → kırmızı, 'primary' → mavi. */
  confirmColor?: 'warn' | 'primary';
}

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content style="min-width:320px">
      <p style="margin:0">{{ data.message }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button [mat-dialog-close]="false">
        {{ data.cancelText ?? 'İptal' }}
      </button>
      <button mat-raised-button
              [color]="data.confirmColor ?? 'warn'"
              [mat-dialog-close]="true"
              cdkFocusInitial>
        {{ data.confirmText ?? 'Onayla' }}
      </button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDialogComponent {
  data      = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
  dialogRef = inject(MatDialogRef<ConfirmDialogComponent>);
}
