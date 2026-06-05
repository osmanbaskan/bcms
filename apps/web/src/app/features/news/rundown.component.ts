import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import type { NewsBulletin, NewsStory } from '@bcms/shared';
import { STORY_TYPE_LABELS, minuteToHHMM, secToClock } from './news.service';

/**
 * Akış (rundown) — EGS "Haber Akışı". Bültenin haberleri sıralı grid;
 * drag-reorder (CDK), toplam süre, KJ/SPOT sayısı, kilit. Aksiyonlar shell'e emit.
 */
@Component({
  selector: 'bp-rundown',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, MatIconModule, DragDropModule],
  template: `
    @if (!bulletin) {
      <div class="empty">Soldan bir bülten seçin ya da yeni bülten oluşturun.</div>
    } @else {
      <div class="rd">
        <header class="rd-head">
          <div class="rh-title">
            <span class="rh-time">{{ min(bulletin.onAirMinute) }}</span>
            <h2>{{ bulletin.name }}</h2>
            @if (bulletin.anchorName) { <span class="rh-anchor">Spiker: {{ bulletin.anchorName }}</span> }
          </div>
          <div class="rh-actions">
            <span class="rh-total">Toplam: {{ dur(total()) }} · {{ stories().length }} haber</span>
            <button class="btn-add" type="button" (click)="addStory.emit()">
              <mat-icon class="material-icons-outlined">add</mat-icon> Yeni Haber
            </button>
          </div>
        </header>

        <div class="rd-grid">
          <div class="rg-headrow">
            <span class="c-ord">#</span><span class="c-type">Tür</span><span class="c-title">Haber</span>
            <span class="c-anchor">Spiker</span><span class="c-kj">KJ/SPOT</span><span class="c-dur">Süre</span><span class="c-act"></span>
          </div>
          <div cdkDropList (cdkDropListDropped)="drop($event)" class="rg-body">
            @for (s of stories(); track s.id; let i = $index) {
              <div class="rg-row" cdkDrag (dblclick)="editStory.emit(s)">
                <span class="c-ord"><mat-icon class="material-icons-outlined grip" cdkDragHandle>drag_indicator</mat-icon>{{ i + 1 }}</span>
                <span class="c-type"><span class="tbadge t-{{ s.storyType }}">{{ typeLabel(s.storyType) }}</span></span>
                <span class="c-title">
                  {{ s.title }}
                  @if (s.locked) { <mat-icon class="material-icons-outlined lk" title="Kilitli: {{ s.lockedBy }}">lock</mat-icon> }
                </span>
                <span class="c-anchor">{{ s.anchorName || '—' }}</span>
                <span class="c-kj">{{ s.lowerThirds.length || '—' }}</span>
                <span class="c-dur">{{ dur(s.clipDurationSec) }}</span>
                <span class="c-act">
                  <mat-icon class="material-icons-outlined a" title="Düzenle" (click)="editStory.emit(s); $event.stopPropagation()">edit</mat-icon>
                  <mat-icon class="material-icons-outlined a" title="Yayına Gönder (KJ/SPOT)" (click)="sendStory.emit(s); $event.stopPropagation()">live_tv</mat-icon>
                  <mat-icon class="material-icons-outlined a" [title]="s.locked ? 'Kilidi aç' : 'Koru'" (click)="lockToggle.emit(s); $event.stopPropagation()">{{ s.locked ? 'lock' : 'lock_open' }}</mat-icon>
                  <mat-icon class="material-icons-outlined a del" title="Çöpe at" (click)="deleteStory.emit(s.id); $event.stopPropagation()">delete</mat-icon>
                </span>
              </div>
            } @empty {
              <div class="empty">Bu bültende henüz haber yok. "Yeni Haber" ile ekleyin.</div>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .empty { padding: 28px; color: var(--bp-fg-3); font-size: 13px; text-align: center; }
    .rd { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .rd-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--bp-line-2); gap: 12px; }
    .rh-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
    .rh-time { font-variant-numeric: tabular-nums; font-weight: 700; color: var(--bp-purple-300); }
    .rh-title h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--bp-fg-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rh-anchor { font-size: 12px; color: var(--bp-fg-3); }
    .rh-actions { display: flex; align-items: center; gap: 12px; }
    .rh-total { font-size: 12px; color: var(--bp-fg-3); white-space: nowrap; }
    .btn-add { display: inline-flex; align-items: center; gap: 5px; background: rgba(124,58,237,0.18); color: var(--bp-fg-1);
      border: 1px solid var(--bp-purple-500); border-radius: 7px; padding: 6px 10px; cursor: pointer; font-size: 12px; white-space: nowrap; }
    .btn-add mat-icon { font-size: 17px; width: 17px; height: 17px; }
    .rd-grid { flex: 1 1 auto; overflow: auto; min-height: 0; }
    .rg-headrow, .rg-row { display: grid; grid-template-columns: 52px 78px 1fr 130px 70px 60px 116px; align-items: center; gap: 8px; padding: 0 14px; }
    .rg-headrow { height: 32px; position: sticky; top: 0; background: var(--bp-bg-1); border-bottom: 1px solid var(--bp-line-2); font-size: 11px; color: var(--bp-fg-3); text-transform: uppercase; z-index: 1; }
    .rg-row { min-height: 42px; border-bottom: 1px solid var(--bp-line-2); font-size: 13px; color: var(--bp-fg-1); background: var(--bp-bg-2); }
    .rg-row:hover { background: var(--bp-bg-1); }
    .cdk-drag-preview { background: var(--bp-bg-1); box-shadow: 0 8px 24px rgba(0,0,0,0.4); border-radius: 6px; }
    .cdk-drag-placeholder { opacity: 0.3; }
    .c-ord { display: inline-flex; align-items: center; gap: 4px; color: var(--bp-fg-3); font-variant-numeric: tabular-nums; }
    .grip { cursor: grab; font-size: 16px; width: 16px; height: 16px; color: var(--bp-fg-3); }
    .c-title { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lk { font-size: 14px; width: 14px; height: 14px; color: #f59e0b; }
    .c-anchor { color: var(--bp-fg-3); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .c-kj, .c-dur { font-variant-numeric: tabular-nums; color: var(--bp-fg-3); }
    .tbadge { font-size: 11px; padding: 1px 7px; border-radius: 5px; background: var(--bp-bg-0); border: 1px solid var(--bp-line-2); color: var(--bp-fg-1); }
    .t-PKG { color: #34d399; border-color: rgba(52,211,153,0.4); }
    .t-LIVE { color: #f87171; border-color: rgba(248,113,113,0.4); }
    .t-CRAWL, .t-ROLL { color: var(--bp-purple-300); border-color: var(--bp-purple-500); }
    .c-act { display: inline-flex; gap: 4px; justify-content: flex-end; }
    .c-act .a { font-size: 17px; width: 17px; height: 17px; color: var(--bp-fg-3); cursor: pointer; }
    .c-act .a:hover { color: var(--bp-fg-1); }
    .c-act .del:hover { color: #ef4444; }
  `],
})
export class RundownComponent {
  @Input() bulletin: NewsBulletin | null = null;
  @Output() editStory = new EventEmitter<NewsStory>();
  @Output() addStory = new EventEmitter<void>();
  @Output() reorder = new EventEmitter<number[]>();
  @Output() deleteStory = new EventEmitter<number>();
  @Output() sendStory = new EventEmitter<NewsStory>();
  @Output() lockToggle = new EventEmitter<NewsStory>();

  stories(): NewsStory[] { return this.bulletin?.stories ?? []; }
  total(): number { return this.stories().reduce((s, x) => s + (x.clipDurationSec || 0), 0); }
  typeLabel(t: string): string { return STORY_TYPE_LABELS[t] ?? t; }
  min(m: number): string { return minuteToHHMM(m); }
  dur(sec: number): string { return secToClock(sec); }

  drop(ev: CdkDragDrop<NewsStory[]>): void {
    const list = [...this.stories()];
    moveItemInArray(list, ev.previousIndex, ev.currentIndex);
    this.reorder.emit(list.map((s) => s.id));
  }
}
