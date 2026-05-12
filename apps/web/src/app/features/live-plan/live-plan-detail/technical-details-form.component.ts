import {
  ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, OnInit, Output,
  SimpleChanges, computed, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { HttpErrorResponse } from '@angular/common/http';

import { ApiService } from '../../../core/services/api.service';
import { livePlanEndpoint } from '../live-plan.types';
import { LookupSelectComponent } from './lookup-select.component';
import { SegmentConfirmDialogComponent } from './confirm-dialog.component';
import {
  composeIstanbulIso,
  formatIstanbulDate,
  formatIstanbulTime,
} from '../../../core/time/tz.helpers';
import {
  ALL_FIELDS,
  FIELD_GROUPS,
  type FieldDef,
  type FieldGroupDef,
  type TechnicalDetailsBaseFields,
  type TechnicalDetailsFieldKey,
  type TechnicalDetailsRow,
  type UpdateTechnicalDetailsBody,
} from './technical-details.types';

type FieldValue = string | number | null;
type FormState = Record<TechnicalDetailsFieldKey, FieldValue>;

/**
 * Madde 5 M5-B10b — Live-plan Teknik Detay 73 alan formu (1:1 child).
 *
 * Backend endpoint: /api/v1/live-plan/:entryId/technical-details
 *   GET    → row | null (singleton)
 *   POST   → 201 (boş body; operatör sonradan doldurur)
 *   PATCH  → If-Match version (U7: undefined=no-change, null=clear)
 *   DELETE → If-Match version (soft)
 *
 * Form state: signal-based; dirty tracking original snapshot diff.
 * Datetime alanları (`plannedStartTime`/`plannedEndTime`): Türkiye saati input,
 * tz.helpers.composeIstanbulIso ile UTC ISO'ya çevirilir.
 */
@Component({
  selector: 'app-technical-details-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule,
    MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule,
    MatExpansionModule, MatProgressSpinnerModule, MatSnackBarModule,
    MatDialogModule, MatTooltipModule,
    LookupSelectComponent,
  ],
  template: `
    @if (loading()) {
      <div class="td-loading"><mat-spinner diameter="36"></mat-spinner></div>
    } @else if (!row() && !error()) {
      <div class="td-empty">
        <p>Bu canlı yayın için teknik detay henüz oluşturulmadı.</p>
        @if (canWrite) {
          <button mat-flat-button color="primary"
                  [disabled]="creating()"
                  (click)="create()">
            <mat-icon>add</mat-icon>
            Teknik Detayı Oluştur
          </button>
        } @else {
          <p class="td-hint">Oluşturmak için yazma yetkisi gerekir.</p>
        }
      </div>
    } @else if (error()) {
      <div class="td-empty">
        <p class="td-error">{{ error() }}</p>
        <button mat-stroked-button (click)="reload()">
          <mat-icon>refresh</mat-icon>
          Tekrar dene
        </button>
      </div>
    } @else if (row(); as r) {
      <div class="td-toolbar">
        <span class="td-version">v{{ r.version }}</span>
        @if (lastSaved(); as s) { <span class="td-saved">Son kayıt: {{ s }}</span> }
        <span class="td-spacer"></span>
        @if (canWrite) {
          <button mat-flat-button color="primary"
                  [disabled]="!dirty() || saving()"
                  (click)="save()">
            <mat-icon>save</mat-icon>
            Kaydet
          </button>
          <button mat-stroked-button
                  [disabled]="!dirty() || saving()"
                  (click)="resetToOriginal()">
            <mat-icon>undo</mat-icon>
            Geri Al
          </button>
        }
        @if (canDelete) {
          <button mat-icon-button color="warn" matTooltip="Teknik detayı sil"
                  [disabled]="saving()"
                  (click)="confirmDelete()">
            <mat-icon>delete</mat-icon>
          </button>
        }
      </div>

      <mat-accordion multi class="td-accordion">
        @for (group of groups; track group.id) {
          <mat-expansion-panel [expanded]="group.id === 'yayin-ob'">
            <mat-expansion-panel-header>
              <mat-panel-title>{{ group.title }}</mat-panel-title>
              @if (group.hint) { <mat-panel-description>{{ group.hint }}</mat-panel-description> }
            </mat-expansion-panel-header>

            <div class="td-grid">
              @for (field of group.fields; track field.key) {
                <div class="td-cell">
                  @switch (field.kind) {
                    @case ('fk') {
                      <app-lookup-select
                        [label]="field.label"
                        [lookupType]="field.lookupType"
                        [polymorphicType]="field.polymorphicType"
                        [disabled]="!canWrite || saving()"
                        [value]="numberValue(field.key)"
                        (valueChange)="onChange(field.key, $event)">
                      </app-lookup-select>
                    }
                    @case ('string') {
                      <mat-form-field appearance="outline" subscriptSizing="dynamic">
                        <mat-label>{{ field.label }}</mat-label>
                        <input matInput
                               [ngModel]="stringValue(field.key)"
                               (ngModelChange)="onChangeString(field.key, $event)"
                               [maxlength]="field.maxLength ?? null"
                               [disabled]="!canWrite || saving()"
                               [ngModelOptions]="{standalone:true}" />
                      </mat-form-field>
                    }
                    @case ('int') {
                      <mat-form-field appearance="outline" subscriptSizing="dynamic">
                        <mat-label>{{ field.label }}</mat-label>
                        <input matInput type="number"
                               [ngModel]="numberValue(field.key)"
                               (ngModelChange)="onChangeNumber(field.key, $event)"
                               [min]="field.min ?? null"
                               [max]="field.max ?? null"
                               [disabled]="!canWrite || saving()"
                               [ngModelOptions]="{standalone:true}" />
                      </mat-form-field>
                    }
                    @case ('datetime') {
                      <mat-form-field appearance="outline" subscriptSizing="dynamic">
                        <mat-label>{{ field.label }} (Türkiye)</mat-label>
                        <input matInput type="datetime-local"
                               [ngModel]="datetimeValue(field.key)"
                               (ngModelChange)="onChangeDatetime(field.key, $event)"
                               [disabled]="!canWrite || saving()"
                               [ngModelOptions]="{standalone:true}" />
                      </mat-form-field>
                    }
                  }
                </div>
              }
            </div>
          </mat-expansion-panel>
        }
      </mat-accordion>
    }
  `,
  styles: [`
    :host { display:block; }
    .td-loading { display:flex; justify-content:center; padding:48px; }
    .td-empty { padding:48px; text-align:center; color:#888; display:flex;
                flex-direction:column; gap:12px; align-items:center; }
    .td-empty p { margin: 0; }
    .td-error { color: #c62828; }
    .td-hint { font-size: 12px; }

    .td-toolbar {
      display:flex; align-items:center; gap:8px;
      padding: 8px 0 16px; flex-wrap: wrap;
    }
    .td-version { font-size: 12px; color: #666; background: #f0f0f0;
                  border-radius: 10px; padding: 2px 8px; }
    .td-saved { font-size: 12px; color: #888; }
    .td-spacer { flex: 1; }

    .td-accordion { display:block; }

    .td-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px 16px;
      padding: 12px 0 4px;
    }
    .td-cell { min-width: 0; }
    .td-cell mat-form-field { width: 100%; }
  `],
})
export class TechnicalDetailsFormComponent implements OnInit, OnChanges {
  private api    = inject(ApiService);
  private snack  = inject(MatSnackBar);
  private dialog = inject(MatDialog);

  @Input({ required: true }) entryId!: number;
  @Input() canWrite = false;
  @Input() canDelete = false;

  /**
   * 2026-05-13: Wrapper dialog (LivePlanTechnicalEditDialogComponent) auto-close
   * için. Mevcut page wrapper (LivePlanDetailComponent) bunu bind etmediği için
   * davranışı bozmaz. Emit: create / save / delete success callback'leri.
   */
  @Output() saved = new EventEmitter<void>();

  readonly groups: readonly FieldGroupDef[] = FIELD_GROUPS;

  loading  = signal(true);
  saving   = signal(false);
  creating = signal(false);
  error    = signal<string | null>(null);

  row      = signal<TechnicalDetailsRow | null>(null);
  /** Snapshot of `state` taken on load/save — diff'in temeli. */
  private original: FormState | null = null;
  state    = signal<FormState>(this.emptyState());

  /** Save button enablement — herhangi bir alan original'den farklı mı. */
  dirty = computed(() => {
    if (!this.original) return false;
    const s = this.state();
    for (const f of ALL_FIELDS) {
      if (s[f.key] !== this.original[f.key]) return true;
    }
    return false;
  });

  lastSaved = signal<string | null>(null);

  ngOnInit(): void { this.reload(); }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['entryId'] && !changes['entryId'].firstChange) {
      this.reload();
    }
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.get<TechnicalDetailsRow | null>(
      livePlanEndpoint.technicalDetails(this.entryId),
    ).subscribe({
      next: (r) => { this.applyRow(r); this.loading.set(false); },
      error: (e: HttpErrorResponse) => {
        this.loading.set(false);
        this.error.set(e.status === 403
          ? 'Bu kaydı görüntüleme yetkisi yok.'
          : 'Teknik detay yüklenemedi.');
      },
    });
  }

  create(): void {
    if (this.creating()) return;
    this.creating.set(true);
    this.api.post<TechnicalDetailsRow>(
      livePlanEndpoint.technicalDetails(this.entryId),
      {},
    ).subscribe({
      next: (r) => {
        this.creating.set(false);
        this.applyRow(r);
        this.snack.open('Teknik detay oluşturuldu', 'Kapat', { duration: 3000 });
        this.saved.emit();
      },
      error: (e: HttpErrorResponse) => {
        this.creating.set(false);
        this.snack.open(
          e.status === 409 ? 'Zaten oluşturulmuş — yeniden yükleniyor.' : 'Oluşturulamadı',
          'Kapat',
          { duration: 4000 },
        );
        if (e.status === 409) this.reload();
      },
    });
  }

  save(): void {
    const row = this.row();
    if (!row || this.saving() || !this.dirty()) return;
    const diff = this.buildDiff();
    if (Object.keys(diff).length === 0) return;
    this.saving.set(true);
    this.api.patch<TechnicalDetailsRow>(
      livePlanEndpoint.technicalDetails(this.entryId),
      diff,
      row.version,
    ).subscribe({
      next: (r) => {
        this.saving.set(false);
        this.applyRow(r);
        this.lastSaved.set(formatIstanbulTime(new Date(), true));
        this.snack.open(`Kaydedildi (v${r.version})`, 'Kapat', { duration: 3000 });
        this.saved.emit();
      },
      error: (e: HttpErrorResponse) => {
        this.saving.set(false);
        if (e.status === 412) {
          this.snack.open(
            'Başka bir kullanıcı güncellemiş — son hâl yeniden yükleniyor.',
            'Kapat', { duration: 5000 },
          );
          this.reload();
          return;
        }
        if (e.status === 400 && e.error?.issues) {
          this.snack.open('Doğrulama hatası: alan değerlerini kontrol edin', 'Kapat', { duration: 5000 });
          return;
        }
        this.snack.open('Kaydedilemedi', 'Kapat', { duration: 4000 });
      },
    });
  }

  confirmDelete(): void {
    const row = this.row();
    if (!row) return;
    const ref = this.dialog.open(SegmentConfirmDialogComponent, {
      data: {
        title: 'Teknik Detayı Sil',
        message: 'Bu teknik detay satırı silinecek (soft-delete). Devam edilsin mi?',
        confirmText: 'Sil',
      },
    });
    ref.afterClosed().subscribe((ok) => { if (ok) this.delete(); });
  }

  private delete(): void {
    const row = this.row();
    if (!row || this.saving()) return;
    this.saving.set(true);
    this.api.delete(
      livePlanEndpoint.technicalDetails(this.entryId),
      row.version,
    ).subscribe({
      next: () => {
        this.saving.set(false);
        this.row.set(null);
        this.original = null;
        this.state.set(this.emptyState());
        this.snack.open('Teknik detay silindi', 'Kapat', { duration: 3000 });
        this.saved.emit();
      },
      error: (e: HttpErrorResponse) => {
        this.saving.set(false);
        if (e.status === 412) {
          this.snack.open('Versiyon eskimiş — yeniden yükleniyor', 'Kapat', { duration: 4000 });
          this.reload();
          return;
        }
        this.snack.open('Silinemedi', 'Kapat', { duration: 4000 });
      },
    });
  }

  resetToOriginal(): void {
    if (!this.original) return;
    this.state.set({ ...this.original });
  }

  // ── Field accessors (template'de strict tip için ayrı getter'lar) ───────
  numberValue(key: TechnicalDetailsFieldKey): number | null {
    const v = this.state()[key];
    return typeof v === 'number' ? v : null;
  }
  stringValue(key: TechnicalDetailsFieldKey): string {
    const v = this.state()[key];
    return typeof v === 'string' ? v : '';
  }
  /** datetime-local input shape "YYYY-MM-DDTHH:mm" Türkiye saati. */
  datetimeValue(key: TechnicalDetailsFieldKey): string {
    const v = this.state()[key];
    if (typeof v !== 'string' || !v) return '';
    try {
      return `${formatIstanbulDate(v)}T${formatIstanbulTime(v, false)}`;
    } catch {
      return '';
    }
  }

  onChange(key: TechnicalDetailsFieldKey, value: number | null): void {
    this.patchState(key, value);
  }
  onChangeString(key: TechnicalDetailsFieldKey, raw: string): void {
    const trimmed = raw?.trim() ?? '';
    this.patchState(key, trimmed === '' ? null : trimmed);
  }
  onChangeNumber(key: TechnicalDetailsFieldKey, raw: number | string | null): void {
    if (raw === null || raw === '' || raw === undefined) {
      this.patchState(key, null);
      return;
    }
    const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    this.patchState(key, Number.isFinite(n) ? n : null);
  }
  onChangeDatetime(key: TechnicalDetailsFieldKey, raw: string): void {
    if (!raw) { this.patchState(key, null); return; }
    // raw "YYYY-MM-DDTHH:mm" Türkiye saati; UTC ISO'ya çevir.
    const [date, time] = raw.split('T');
    if (!date || !time) { this.patchState(key, null); return; }
    try {
      this.patchState(key, composeIstanbulIso(date, time));
    } catch {
      // Geçersiz format — alanı değiştirme.
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────
  private patchState(key: TechnicalDetailsFieldKey, value: FieldValue): void {
    this.state.update((s) => ({ ...s, [key]: value }));
  }

  private applyRow(r: TechnicalDetailsRow | null): void {
    if (!r) {
      this.row.set(null);
      this.original = null;
      this.state.set(this.emptyState());
      return;
    }
    this.row.set(r);
    const snapshot = this.rowToState(r);
    this.original = snapshot;
    this.state.set({ ...snapshot });
  }

  private rowToState(r: TechnicalDetailsRow): FormState {
    const out = this.emptyState();
    for (const f of ALL_FIELDS) {
      const raw = (r as unknown as Record<string, unknown>)[f.key];
      if (raw === null || raw === undefined) {
        out[f.key] = null;
      } else if (typeof raw === 'number' || typeof raw === 'string') {
        out[f.key] = raw;
      } else {
        out[f.key] = null;
      }
    }
    return out;
  }

  private emptyState(): FormState {
    const out = {} as FormState;
    for (const f of ALL_FIELDS) out[f.key] = null;
    return out;
  }

  /**
   * PATCH body'sini original snapshot ile karşılaştırıp diff üret.
   * Undefined → no-change; null → clear; value → set (backend U7).
   */
  private buildDiff(): UpdateTechnicalDetailsBody {
    const out: UpdateTechnicalDetailsBody = {};
    if (!this.original) return out;
    const cur = this.state();
    for (const f of ALL_FIELDS) {
      const before = this.original[f.key];
      const after  = cur[f.key];
      if (before === after) continue;
      this.assignDiffField(out, f, after);
    }
    return out;
  }

  /**
   * Tek bir field'ı diff body'sine atar. FieldDef.kind'a göre tip-doğru cast;
   * cast hatasında alanı düşürür (geçersiz girişten silent ignore — backend
   * zaten Zod ile yakalar; UI'da snack ile bildiririz).
   */
  private assignDiffField(
    out: UpdateTechnicalDetailsBody,
    field: FieldDef,
    value: FieldValue,
  ): void {
    const key = field.key as keyof UpdateTechnicalDetailsBody;
    if (value === null) {
      (out as Record<string, unknown>)[key] = null;
      return;
    }
    if (field.kind === 'fk' || field.kind === 'int') {
      if (typeof value === 'number') (out as Record<string, unknown>)[key] = value;
      return;
    }
    if (field.kind === 'string' || field.kind === 'datetime') {
      if (typeof value === 'string' && value.length > 0) {
        (out as Record<string, unknown>)[key] = value;
      }
    }
  }
}
