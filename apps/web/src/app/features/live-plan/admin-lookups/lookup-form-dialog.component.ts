import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ApiService } from '../../../core/services/api.service';
import {
  type LookupDefinition,
  type LookupRow,
  type LookupCreateBody,
  type LookupUpdateBody,
  lookupEndpoint,
} from './lookup.types';

export interface LookupFormDialogData {
  definition: LookupDefinition;
  /** Edit'te `row` doludur, create'te yok. */
  row?: LookupRow;
}

@Component({
  selector: 'app-lookup-form-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatDialogModule, MatButtonModule, MatFormFieldModule,
    MatInputModule, MatSelectModule, MatSlideToggleModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title>
      {{ mode() === 'edit' ? 'Düzenle — ' + data.definition.label : 'Yeni — ' + data.definition.label }}
    </h2>
    <mat-dialog-content style="min-width:380px">
      <div style="display:flex;flex-direction:column;gap:4px">
        <mat-form-field>
          <mat-label>Etiket *</mat-label>
          <input matInput [(ngModel)]="form.label" name="label" maxlength="200" autofocus>
        </mat-form-field>

        @if (data.definition.polymorphic) {
          <mat-form-field>
            <mat-label>Tip *</mat-label>
            <mat-select
              [(ngModel)]="form.type"
              name="type"
              [disabled]="mode() === 'edit'">
              @for (t of data.definition.allowedTypes ?? []; track t) {
                <mat-option [value]="t">{{ t }}</mat-option>
              }
            </mat-select>
            @if (mode() === 'edit') {
              <mat-hint>Tip değiştirilemez (kayıt sonrası kilitli).</mat-hint>
            }
          </mat-form-field>
        }

        <mat-form-field>
          <mat-label>Sıra</mat-label>
          <input matInput type="number" [(ngModel)]="form.sortOrder" name="sortOrder" min="0">
        </mat-form-field>

        <mat-slide-toggle [(ngModel)]="form.active" name="active">
          {{ form.active ? 'Aktif' : 'Pasif' }}
        </mat-slide-toggle>
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
export class LookupFormDialogComponent {
  data       = inject<LookupFormDialogData>(MAT_DIALOG_DATA);
  dialogRef  = inject(MatDialogRef<LookupFormDialogComponent>);
  private api = inject(ApiService);

  mode      = computed<'create' | 'edit'>(() => (this.data.row ? 'edit' : 'create'));
  saving    = signal(false);
  errorMsg  = signal('');

  form = {
    label:     this.data.row?.label ?? '',
    active:    this.data.row?.active ?? true,
    sortOrder: this.data.row?.sortOrder ?? 0,
    type:      this.data.row?.type ?? '',
  };

  canSave(): boolean {
    if (!this.form.label.trim()) return false;
    if (this.data.definition.polymorphic && !this.form.type) return false;
    return true;
  }

  save() {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.errorMsg.set('');

    const def = this.data.definition;
    if (this.mode() === 'edit') {
      const body: LookupUpdateBody = {
        label:     this.form.label.trim(),
        active:    this.form.active,
        sortOrder: this.form.sortOrder,
      };
      this.api.patch(lookupEndpoint.detail(def.type, this.data.row!.id), body).subscribe({
        next: () => { this.saving.set(false); this.dialogRef.close(true); },
        error: (err) => this.handleError(err),
      });
    } else {
      const body: LookupCreateBody = {
        label:     this.form.label.trim(),
        active:    this.form.active,
        sortOrder: this.form.sortOrder,
        ...(def.polymorphic ? { type: this.form.type } : {}),
      };
      this.api.post(lookupEndpoint.list(def.type), body).subscribe({
        next: () => { this.saving.set(false); this.dialogRef.close(true); },
        error: (err) => this.handleError(err),
      });
    }
  }

  private handleError(err: { status?: number; error?: { message?: string }; message?: string }) {
    this.saving.set(false);
    if (err?.status === 409) {
      this.errorMsg.set('Aynı etikette başka bir kayıt mevcut.');
    } else {
      this.errorMsg.set(err?.error?.message ?? err?.message ?? 'İşlem başarısız');
    }
  }
}
