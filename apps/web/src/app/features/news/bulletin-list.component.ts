import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import type { CreateBulletinDto, NewsBulletin } from '@bcms/shared';
import { BULLETIN_STATUS_LABELS, hhmmToMinute, minuteToHHMM, secToClock } from './news.service';

/**
 * Bülten listesi (EGS "Günlük Yayın Akışları") + inline "Yeni Bülten" formu.
 * Sunum bileşeni: seçim/oluştur/sil event'leri shell'e emit edilir.
 */
@Component({
  selector: 'bp-bulletin-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, MatIconModule],
  template: `
    <div class="bl">
      <div class="bl-new">
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
      </div>

      <div class="bl-items">
        @for (b of bulletins; track b.id) {
          <button type="button" class="bl-item" [class.sel]="b.id === selectedId" (click)="select.emit(b.id)">
            <div class="bi-main">
              <span class="bi-time">{{ min(b.onAirMinute) }}</span>
              <span class="bi-name">{{ b.name }}</span>
            </div>
            <div class="bi-meta">
              <span class="chip s-{{ b.status }}">{{ statusLabel(b.status) }}</span>
              <span class="bi-count">{{ b.storyCount ?? 0 }} haber · {{ dur(b.totalDurationSec ?? 0) }}</span>
              <mat-icon class="material-icons-outlined del" (click)="onDelete($event, b.id)" title="Bülteni sil">delete</mat-icon>
            </div>
          </button>
        } @empty {
          <div class="empty">Bu tarihte bülten yok.</div>
        }
      </div>
    </div>
  `,
  styles: [`
    .bl { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .bl-new { padding: 8px; border-bottom: 1px solid var(--bp-line-2); }
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
    .bl-items { flex: 1 1 auto; overflow: auto; min-height: 0; }
    .bl-item { width: 100%; text-align: left; background: transparent; border: none; border-bottom: 1px solid var(--bp-line-2);
      padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 5px; color: var(--bp-fg-1); }
    .bl-item:hover { background: var(--bp-bg-1); }
    .bl-item.sel { background: rgba(124,58,237,0.14); border-left: 3px solid var(--bp-purple-500); }
    .bi-main { display: flex; align-items: baseline; gap: 8px; }
    .bi-time { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--bp-purple-300); font-size: 13px; }
    .bi-name { font-size: 13px; font-weight: 500; }
    .bi-meta { display: flex; align-items: center; gap: 8px; }
    .bi-count { font-size: 11px; color: var(--bp-fg-3); }
    .del { font-size: 16px; width: 16px; height: 16px; margin-left: auto; color: var(--bp-fg-3); opacity: 0; }
    .bl-item:hover .del { opacity: 1; }
    .del:hover { color: #ef4444; }
    .chip { font-size: 10px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--bp-line-2); color: var(--bp-fg-3); }
    .chip.s-READY { color: #34d399; border-color: rgba(52,211,153,0.4); }
    .chip.s-ON_AIR { color: #f87171; border-color: rgba(248,113,113,0.5); }
    .chip.s-DONE { color: var(--bp-fg-3); }
    .empty { padding: 18px; color: var(--bp-fg-3); font-size: 12px; text-align: center; }
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

  statusLabel(s: string): string { return BULLETIN_STATUS_LABELS[s] ?? s; }
  min(m: number): string { return minuteToHHMM(m); }
  dur(sec: number): string { return secToClock(sec); }

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
