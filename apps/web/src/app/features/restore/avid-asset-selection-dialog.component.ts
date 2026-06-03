import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatRadioModule } from '@angular/material/radio';
import type { AvidAsset } from '@bcms/shared';

/**
 * Avid asset seçim dialog'u — search kademe AWAITING_SELECTION durumunda
 * operatör birden çok asset'ten birini seçer.
 *
 * 1 sonuç olsa bile (kullanıcı kararı 2026-05-28) bu dialog açılır; operatör
 * onayı her zaman alınır. Returns: AvidAsset (Confirm) | null (Cancel).
 */
export interface AvidAssetSelectionData {
  dcCode: string;
  assets: AvidAsset[];
}

@Component({
  selector: 'app-avid-asset-selection-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatDialogModule, MatButtonModule, MatRadioModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Avid Asset Seçimi</h2>
    <mat-dialog-content style="min-width:480px">
      <p class="hint">
        <strong>{{ data.dcCode }}</strong> için Avid arşivinde
        <strong>{{ data.assets.length }}</strong>
        sonuç bulundu. Devam edilecek asset'i seçin.
      </p>
      <mat-radio-group [ngModel]="selectedId()" (ngModelChange)="onSelect($event)" class="asset-list">
        @for (a of data.assets; track a.id) {
          <mat-radio-button [value]="a.id" class="asset-row">
            <div class="asset-meta">
              <div class="asset-name">
                {{ a.name }}
                <span
                  class="online-badge"
                  [class.online-badge--on]="a.online"
                  [class.online-badge--off]="!a.online"
                  [title]="a.online ? 'Interplay\\'de online — Restore kısa sürer' : 'DIVA arşivinde — Restore DIVA\\'dan Avid\\'e getirir'"
                >{{ a.online ? 'Online' : 'Offline' }}</span>
              </div>
              <div class="asset-sub">
                <span class="mono">{{ a.id }}</span>
                <span> · değişiklik: {{ formatDate(a.modifiedAt) }}</span>
                @if (a.durationFrames != null) {
                  <span> · süre: {{ a.durationFrames }} frame</span>
                }
              </div>
            </div>
          </mat-radio-button>
        }
      </mat-radio-group>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button [mat-dialog-close]="null">İptal</button>
      <button
        mat-raised-button
        color="primary"
        [disabled]="!selectedAsset()"
        (click)="confirm()"
      >Seç</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .hint { margin: 0 0 16px; color: var(--bp-fg-2); font-size: 13px; }
    .asset-list { display: flex; flex-direction: column; gap: 8px; }
    .asset-row { padding: 6px 4px; border-radius: 6px; }
    .asset-row:hover { background: var(--bp-bg-3); }
    .asset-meta { display: flex; flex-direction: column; gap: 2px; padding-left: 6px; }
    .asset-name { font-weight: 600; color: var(--bp-fg-1); font-size: 13px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .asset-sub  { font-size: 11px; color: var(--bp-fg-3); }
    .mono { font-family: var(--bp-font-mono, ui-monospace, 'JetBrains Mono', Menlo, monospace); }
    .online-badge {
      display: inline-block; padding: 1px 7px; border-radius: var(--bp-r-pill, 999px);
      font-size: 10.5px; font-weight: 600; line-height: 1.45; border: 1px solid transparent;
      letter-spacing: 0.04em;
    }
    .online-badge--on  { background: rgba(16, 185, 129, 0.20); color: var(--bp-acc-green); border-color: rgba(16, 185, 129, 0.50); }
    .online-badge--off { background: rgba(249, 115, 22, 0.22); color: #fdba74; border-color: rgba(249, 115, 22, 0.55); }
    :host-context(html[data-theme="light"]) .online-badge--on  { background: rgba(16, 185, 129, 0.18); color: #065f46; border-color: #059669; }
    :host-context(html[data-theme="light"]) .online-badge--off { background: rgba(249, 115, 22, 0.18); color: #9a3412; border-color: #ea580c; }
  `],
})
export class AvidAssetSelectionDialogComponent {
  readonly data = inject<AvidAssetSelectionData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<AvidAssetSelectionDialogComponent, AvidAsset | null>);

  readonly selectedId = signal<string | null>(null);

  selectedAsset(): AvidAsset | null {
    const id = this.selectedId();
    return this.data.assets.find((a) => a.id === id) ?? null;
  }

  onSelect(id: string): void {
    this.selectedId.set(id);
  }

  confirm(): void {
    const asset = this.selectedAsset();
    if (!asset) return;
    this.dialogRef.close(asset);
  }

  formatDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul',
        year: '2-digit', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }
}
