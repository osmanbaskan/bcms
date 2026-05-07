import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { ApiService } from '../../../core/services/api.service';
import {
  FEED_ROLES, FEED_ROLE_LABELS,
  SEGMENT_KINDS, SEGMENT_KIND_LABELS,
  livePlanEndpoint,
  type CreateSegmentBody, type FeedRole, type SegmentKind,
  type TransmissionSegment, type UpdateSegmentBody,
} from '../live-plan.types';

export interface SegmentFormDialogData {
  entryId: number;
  /** Edit modu için mevcut segment; create modunda undefined. */
  segment?: TransmissionSegment;
}

/**
 * Madde 5 M5-B10a — Segment Create/Edit dialog.
 *
 * U6 explicit POST + PATCH (no PUT upsert).
 * U7 PATCH: undefined=no change, null=clear (description için).
 * version YOK (U3 last-write-wins).
 *
 * Form alanları:
 *   - feedRole (mat-select, FEED_ROLES)
 *   - kind (mat-select, SEGMENT_KINDS)
 *   - startTime (datetime-local input → ISO conversion)
 *   - endTime
 *   - description (textarea, opsiyonel)
 */
@Component({
  selector: 'app-segment-form-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule, MatDialogModule, MatButtonModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title>
      {{ mode() === 'edit' ? 'Segment Düzenle' : 'Yeni Segment' }}
    </h2>
    <mat-dialog-content style="min-width:380px">
      <div style="display:flex;flex-direction:column;gap:4px">
        <mat-form-field>
          <mat-label>Feed *</mat-label>
          <mat-select [(ngModel)]="form.feedRole" name="feedRole">
            @for (r of feedRoles; track r) {
              <mat-option [value]="r">{{ feedRoleLabel(r) }} ({{ r }})</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field>
          <mat-label>Tür *</mat-label>
          <mat-select [(ngModel)]="form.kind" name="kind">
            @for (k of kinds; track k) {
              <mat-option [value]="k">{{ kindLabel(k) }} ({{ k }})</mat-option>
            }
          </mat-select>
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
          <mat-label>Açıklama</mat-label>
          <textarea matInput rows="3" maxlength="20000"
                    [(ngModel)]="form.description" name="description"></textarea>
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
export class SegmentFormDialogComponent {
  data      = inject<SegmentFormDialogData>(MAT_DIALOG_DATA);
  dialogRef = inject(MatDialogRef<SegmentFormDialogComponent>);
  private api = inject(ApiService);

  feedRoles = FEED_ROLES;
  kinds     = SEGMENT_KINDS;
  feedRoleLabel = (r: FeedRole) => FEED_ROLE_LABELS[r];
  kindLabel     = (k: SegmentKind) => SEGMENT_KIND_LABELS[k];

  mode      = computed<'create' | 'edit'>(() => (this.data.segment ? 'edit' : 'create'));
  saving    = signal(false);
  errorMsg  = signal('');

  form = {
    feedRole:    (this.data.segment?.feedRole ?? 'MAIN') as FeedRole,
    kind:        (this.data.segment?.kind     ?? 'PROGRAM') as SegmentKind,
    startLocal:  isoToDatetimeLocal(this.data.segment?.startTime),
    endLocal:    isoToDatetimeLocal(this.data.segment?.endTime),
    description: this.data.segment?.description ?? '',
  };

  canSave(): boolean {
    if (!this.form.feedRole || !this.form.kind) return false;
    if (!this.form.startLocal || !this.form.endLocal) return false;
    const s = new Date(datetimeLocalToIso(this.form.startLocal)).getTime();
    const e = new Date(datetimeLocalToIso(this.form.endLocal)).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
    if (e <= s) return false;
    return true;
  }

  save() {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.errorMsg.set('');

    const startTime = datetimeLocalToIso(this.form.startLocal);
    const endTime   = datetimeLocalToIso(this.form.endLocal);
    const desc      = this.form.description.trim();

    if (this.mode() === 'edit') {
      const segId = this.data.segment!.id;
      const body: UpdateSegmentBody = {
        feedRole:    this.form.feedRole,
        kind:        this.form.kind,
        startTime,
        endTime,
        // U7: boş → null (clear). description nullable.
        description: desc.length > 0 ? desc : null,
      };
      this.api.patch(livePlanEndpoint.segments.detail(this.data.entryId, segId), body)
        .subscribe({
          next: () => { this.saving.set(false); this.dialogRef.close(true); },
          error: (err) => this.handleError(err),
        });
    } else {
      const body: CreateSegmentBody = {
        feedRole:    this.form.feedRole,
        kind:        this.form.kind,
        startTime,
        endTime,
        ...(desc.length > 0 ? { description: desc } : {}),
      };
      this.api.post(livePlanEndpoint.segments.list(this.data.entryId), body)
        .subscribe({
          next: () => { this.saving.set(false); this.dialogRef.close(true); },
          error: (err) => this.handleError(err),
        });
    }
  }

  private handleError(err: { status?: number; error?: { message?: string }; message?: string }) {
    this.saving.set(false);
    this.errorMsg.set(err?.error?.message ?? err?.message ?? 'İşlem başarısız');
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
/**
 * `datetime-local` input formatı: `YYYY-MM-DDTHH:MM`. ISO'ya çevirirken UTC
 * varsayıyoruz (kullanıcı UTC giriyor; M5-B10b'de timezone seçimi opsiyonel).
 */
function datetimeLocalToIso(local: string): string {
  if (!local) return '';
  // datetime-local timezone bilgisi taşımaz; doğrudan `Z` ekleyerek UTC kabul.
  return `${local}:00Z`.replace(/(:\d{2}):00Z$/, '$1Z');
}

function isoToDatetimeLocal(iso: string | undefined | null): string {
  if (!iso) return '';
  // ISO `2026-06-01T19:30:00.000Z` → `2026-06-01T19:30`
  return iso.slice(0, 16);
}
