import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import type { NewsWireItem } from '@bcms/shared';

/**
 * Ajans penceresi (EGS "Ajans Penceresi / Tüm Ajanslar"). Gelen wire'lar
 * (FLASH önce), "Story'ye Çevir" + manuel giriş. Sunum bileşeni.
 */
@Component({
  selector: 'bp-wires',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, MatIconModule],
  template: `
    <div class="wr">
      <header class="wr-head">
        <span class="wh-title">Ajans</span>
        <span class="wh-tools">
          <mat-icon class="material-icons-outlined t" (click)="refresh.emit()" title="Yenile">refresh</mat-icon>
          <mat-icon class="material-icons-outlined t" (click)="adding.set(!adding())" title="Manuel ekle">add</mat-icon>
        </span>
      </header>

      @if (adding()) {
        <div class="wr-new">
          <div class="row">
            <input class="in src" [(ngModel)]="mSource" placeholder="Kaynak (AA)" maxlength="40" />
            <select class="in pri" [(ngModel)]="mPriority"><option value="NORMAL">Normal</option><option value="FLASH">FLAŞ</option></select>
          </div>
          <input class="in" [(ngModel)]="mHeadline" placeholder="Başlık" maxlength="500" />
          <textarea class="in body" [(ngModel)]="mBody" placeholder="Gövde" rows="3"></textarea>
          <div class="row">
            <button class="btn-ok" type="button" [disabled]="!mSource.trim() || !mHeadline.trim()" (click)="emitAdd()">Ekle</button>
            <button class="btn-cancel" type="button" (click)="adding.set(false)">Kapat</button>
          </div>
        </div>
      }

      <div class="wr-filter">
        @for (c of CATEGORIES; track c) {
          <button type="button" class="chip-f" [class.on]="selectedCat() === c" (click)="selectCat(c)">
            {{ c }}<span class="cn">{{ countFor(c) }}</span>
          </button>
        }
      </div>

      <div class="wr-items">
        @for (w of pagedWires(); track w.id) {
          <div class="wr-item" [class.flash]="w.priority === 'FLASH'" [class.used]="w.usedStoryId">
            <div class="wi-top">
              <span class="src">{{ w.source }}</span>
              @if (w.priority === 'FLASH') { <span class="flashtag">FLAŞ</span> }
              <span class="time">{{ w.receivedAt | date: 'HH:mm' }}</span>
            </div>
            <div class="wi-head">{{ w.headline }}</div>
            @if (w.body) { <div class="wi-body">{{ w.body }}</div> }
            <div class="wi-act">
              @if (w.usedStoryId) {
                <span class="usedtag"><mat-icon class="material-icons-outlined">check</mat-icon> Story'ye eklendi</span>
              } @else {
                <button type="button" class="btn-conv" (click)="toStory.emit(w.id)">
                  <mat-icon class="material-icons-outlined">move_to_inbox</mat-icon> Story'ye Çevir
                </button>
              }
            </div>
          </div>
        } @empty {
          <div class="empty">Ajans haberi yok. RSS kaynağı tanımlı değilse manuel ekleyebilirsiniz.</div>
        }
      </div>

      @if (totalPages() > 1) {
        <div class="wr-pager">
          <button type="button" [disabled]="page() === 1" (click)="prev()" aria-label="Önceki sayfa">
            <mat-icon class="material-icons-outlined">chevron_left</mat-icon>
          </button>
          <span class="pg">{{ page() }} / {{ totalPages() }}</span>
          <button type="button" [disabled]="page() === totalPages()" (click)="next()" aria-label="Sonraki sayfa">
            <mat-icon class="material-icons-outlined">chevron_right</mat-icon>
          </button>
        </div>
      }
    </div>
  `,
  styles: [`
    .wr { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .wr-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--bp-line-2); }
    .wh-title { font-size: 13px; font-weight: 600; color: var(--bp-fg-1); }
    .wh-tools { display: inline-flex; gap: 8px; }
    .wh-tools .t { font-size: 18px; width: 18px; height: 18px; color: var(--bp-fg-3); cursor: pointer; }
    .wh-tools .t:hover { color: var(--bp-fg-1); }
    .wr-new { padding: 8px; border-bottom: 1px solid var(--bp-line-2); display: flex; flex-direction: column; gap: 6px; }
    .wr-new .row { display: flex; gap: 6px; }
    .in { background: var(--bp-bg-2); color: var(--bp-fg-1); border: 1px solid var(--bp-line-2); border-radius: 6px; padding: 6px 8px; font-size: 12px; width: 100%; }
    .in.src { flex: 2; } .in.pri { flex: 1; } .in.body { resize: vertical; font-family: inherit; }
    .btn-ok { flex: 1; background: var(--bp-purple-500); color: #fff; border: none; border-radius: 6px; padding: 6px; cursor: pointer; }
    .btn-cancel { flex: 1; background: var(--bp-bg-2); color: var(--bp-fg-3); border: 1px solid var(--bp-line-2); border-radius: 6px; padding: 6px; cursor: pointer; }
    /* 5/sayfa: liste içeriğe göre yükselsin (flex:1 ile gerilip altta boşluk
       bırakmasın); taşarsa kaydırır. Pager haberlerin hemen altına oturur. */
    .wr-items { flex: 0 1 auto; overflow: auto; min-height: 0; }
    .wr-item { padding: 10px 12px; border-bottom: 1px solid var(--bp-line-2); }
    .wr-item.flash { background: rgba(248,113,113,0.06); }
    .wr-item.used { opacity: 0.6; }
    .wi-top { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
    .src { font-size: 11px; font-weight: 700; color: var(--bp-purple-300); }
    .flashtag { font-size: 10px; font-weight: 700; color: #fff; background: #ef4444; padding: 0 6px; border-radius: 8px; }
    .time { font-size: 11px; color: var(--bp-fg-3); margin-left: auto; }
    .wi-head { font-size: 13px; font-weight: 500; color: var(--bp-fg-1); }
    .wi-body { font-size: 12px; color: var(--bp-fg-3); margin-top: 3px; max-height: 48px; overflow: hidden; }
    .wi-act { margin-top: 6px; }
    .btn-conv { display: inline-flex; align-items: center; gap: 4px; background: var(--bp-bg-2); color: var(--bp-fg-1); border: 1px solid var(--bp-line-2); border-radius: 6px; padding: 4px 8px; font-size: 11px; cursor: pointer; }
    .btn-conv:hover { border-color: var(--bp-purple-500); }
    .btn-conv mat-icon, .usedtag mat-icon { font-size: 15px; width: 15px; height: 15px; }
    .usedtag { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: #34d399; }
    .empty { padding: 18px; color: var(--bp-fg-3); font-size: 12px; text-align: center; }
    .wr-filter { display: flex; flex-wrap: wrap; gap: 5px; padding: 8px 10px; border-bottom: 1px solid var(--bp-line-2); }
    .chip-f { display: inline-flex; align-items: center; gap: 5px; background: var(--bp-bg-2); color: var(--bp-fg-3);
      border: 1px solid var(--bp-line-2); border-radius: 14px; padding: 3px 10px; font-size: 11px; cursor: pointer; }
    .chip-f:hover { color: var(--bp-fg-1); }
    .chip-f.on { background: rgba(124,58,237,0.18); border-color: var(--bp-purple-500); color: var(--bp-fg-1); }
    .chip-f .cn { font-size: 10px; background: var(--bp-bg-3); border-radius: 8px; padding: 0 5px; color: var(--bp-fg-3); }
    .chip-f.on .cn { background: var(--bp-purple-500); color: #fff; }
    .wr-pager { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 7px; border-top: 1px solid var(--bp-line-2); }
    .wr-pager button { background: var(--bp-bg-2); border: 1px solid var(--bp-line-2); color: var(--bp-fg-1); border-radius: 6px; width: 28px; height: 28px; display: grid; place-items: center; cursor: pointer; }
    .wr-pager button:disabled { opacity: 0.35; cursor: default; }
    .wr-pager button mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .wr-pager .pg { font-size: 12px; color: var(--bp-fg-3); font-variant-numeric: tabular-nums; min-width: 44px; text-align: center; }
  `],
})
export class WiresComponent {
  @Input() wires: NewsWireItem[] = [];
  @Output() toStory = new EventEmitter<number>();
  @Output() refresh = new EventEmitter<void>();
  @Output() addManual = new EventEmitter<{ source: string; headline: string; body: string; priority: string }>();

  readonly adding = signal(false);
  mSource = '';
  mHeadline = '';
  mBody = '';
  mPriority = 'NORMAL';

  emitAdd(): void {
    if (!this.mSource.trim() || !this.mHeadline.trim()) return;
    this.addManual.emit({ source: this.mSource.trim(), headline: this.mHeadline.trim(), body: this.mBody.trim(), priority: this.mPriority });
    this.mSource = ''; this.mHeadline = ''; this.mBody = ''; this.mPriority = 'NORMAL';
    this.adding.set(false);
  }

  // ---- Kategori filtresi (5 çip: Tümü + 4 AA kategorisi) ----
  readonly CATEGORIES = ['Tümü', 'Spor', 'Ekonomi', 'Genel', 'Bilim, Teknoloji'];
  readonly selectedCat = signal('Tümü');

  filteredWires(): NewsWireItem[] {
    const c = this.selectedCat();
    if (c === 'Tümü') return this.wires;
    return this.wires.filter((w) => w.category === c);
  }
  countFor(chip: string): number {
    if (chip === 'Tümü') return this.wires.length;
    return this.wires.filter((w) => w.category === chip).length;
  }

  // ---- Sayfalama (10/sayfa) ----
  readonly PAGE_SIZE = 5;
  readonly page = signal(1);

  totalPages(): number {
    return Math.max(1, Math.ceil(this.filteredWires().length / this.PAGE_SIZE));
  }
  /** Geçerli sayfayı toplam sayfaya sabitle (filtre değişince taşma olmasın). */
  private clampedPage(): number {
    return Math.min(this.page(), this.totalPages());
  }
  pagedWires(): NewsWireItem[] {
    const p = this.clampedPage();
    const start = (p - 1) * this.PAGE_SIZE;
    return this.filteredWires().slice(start, start + this.PAGE_SIZE);
  }
  selectCat(c: string): void { this.selectedCat.set(c); this.page.set(1); }
  prev(): void { this.page.set(Math.max(1, this.clampedPage() - 1)); }
  next(): void { this.page.set(Math.min(this.totalPages(), this.clampedPage() + 1)); }
}
