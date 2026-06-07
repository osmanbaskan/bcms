import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import type { CreateBulletinDto, NewsBulletin } from '@bcms/shared';
import { hhmmToMinute, minuteToHHMM, secToClock } from './news.service';

/**
 * Bülten seçici (EGS "Günlük Yayın Akışları"). 2026-06-07: açık liste yerine
 * TEK dropdown (select kutusu) ile bülten seçimi + "Yeni Bülten" inline formu +
 * seçili bülteni sil. Sunum bileşeni: seçim/oluştur/sil event'leri shell'e emit.
 */
@Component({
  selector: 'bp-bulletin-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, MatIconModule],
  template: `
    <div class="bl">
      <div class="bl-pick">
        <select class="bl-select" [ngModel]="selectedId" (ngModelChange)="onSelect($event)">
          <option [ngValue]="null">— Bülten seç —</option>
          @for (b of bulletins; track b.id) {
            <option [ngValue]="b.id">{{ min(b.onAirMinute) }} · {{ b.name }} · {{ b.storyCount ?? 0 }} haber · {{ dur(b.totalDurationSec ?? 0) }}</option>
          }
        </select>
        @if (selectedId != null) {
          <button class="bl-del" type="button" title="Seçili bülteni sil" (click)="onDelete($event, selectedId)">
            <mat-icon class="material-icons-outlined">delete</mat-icon>
          </button>
        }
      </div>

      @if (!adding()) {
        <button class="btn-new" type="button" (click)="adding.set(true)">
          <mat-icon class="material-icons-outlined">add</mat-icon> Yeni Bülten
        </button>
      } @else {
        <div class="new-form">
          <input class="in" [(ngModel)]="nName" placeholder="Bülten adı (ör. SPOR ANA HABER)" maxlength="200" />
          <div class="row">
            <input class="in code" [(ngModel)]="nCode" placeholder="Kod" maxlength="40" />
            <input class="in time" type="time" [(ngModel)]="nTime" />
          </div>
          <div class="row">
            <button class="btn-ok" type="button" [disabled]="!nName.trim()" (click)="emitCreate()">Oluştur</button>
            <button class="btn-cancel" type="button" (click)="cancel()">Vazgeç</button>
          </div>
        </div>
      }

      @if (!bulletins.length) {
        <div class="empty">Bu tarihte bülten yok.</div>
      }
    </div>
  `,
  styles: [`
    .bl { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
    .bl-pick { display: flex; gap: 6px; align-items: center; }
    .bl-select { flex: 1 1 auto; min-width: 0; background: var(--bp-bg-2); color: var(--bp-fg-1);
      border: 1px solid var(--bp-line-2); border-radius: 6px; padding: 8px; font-size: 13px; cursor: pointer; }
    .bl-del { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px;
      background: var(--bp-bg-2); color: var(--bp-fg-3); border: 1px solid var(--bp-line-2); border-radius: 6px; cursor: pointer; }
    .bl-del:hover { color: #ef4444; border-color: #ef4444; }
    .bl-del mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .btn-new { width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      background: var(--bp-purple-500); color: #fff; border: 1px solid var(--bp-purple-500);
      border-radius: 7px; padding: 8px; cursor: pointer; font-size: 13px; }
    .btn-new mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .new-form { display: flex; flex-direction: column; gap: 6px; }
    .new-form .row { display: flex; gap: 6px; }
    .in { background: var(--bp-bg-2); color: var(--bp-fg-1); border: 1px solid var(--bp-line-2);
      border-radius: 6px; padding: 7px 8px; font-size: 13px; width: 100%; }
    .in.code { flex: 1 1 auto; } .in.time { width: 110px; }
    .btn-ok { flex: 1; background: var(--bp-purple-500); color: #fff; border: none; border-radius: 6px; padding: 7px; cursor: pointer; }
    .btn-cancel { flex: 1; background: var(--bp-bg-2); color: var(--bp-fg-3); border: 1px solid var(--bp-line-2); border-radius: 6px; padding: 7px; cursor: pointer; }
    .empty { padding: 6px 2px; color: var(--bp-fg-3); font-size: 12px; text-align: center; }
  `],
})
export class BulletinListComponent {
  @Input() bulletins: NewsBulletin[] = [];
  @Input() selectedId: number | null = null;
  /** Yeni bülten için shell'in seçili tarih filtresi (YYYY-MM-DD). */
  @Input() forDate = '';
  @Output() select = new EventEmitter<number>();
  @Output() create = new EventEmitter<CreateBulletinDto>();
  @Output() remove = new EventEmitter<number>();

  readonly adding = signal(false);
  nName = '';
  nCode = '';
  nTime = '20:00';

  min(m: number): string { return minuteToHHMM(m); }
  dur(sec: number): string { return secToClock(sec); }

  onSelect(id: number | null): void { if (id != null) this.select.emit(id); }

  emitCreate(): void {
    if (!this.nName.trim()) return;
    this.create.emit({
      name: this.nName.trim(),
      bulletinCode: this.nCode.trim() || null,
      bulletinDate: this.forDate,
      onAirMinute: hhmmToMinute(this.nTime),
    });
    this.cancel();
  }
  cancel(): void { this.adding.set(false); this.nName = ''; this.nCode = ''; this.nTime = '20:00'; }
  onDelete(ev: Event, id: number): void { ev.stopPropagation(); this.remove.emit(id); }
}
