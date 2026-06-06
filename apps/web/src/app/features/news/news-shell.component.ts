import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { catchError, of } from 'rxjs';
import type { CreateBulletinDto, NewsBulletin, NewsStory, NewsWireItem } from '@bcms/shared';
import { NewsService, STORY_TYPE_LABELS, secToClock } from './news.service';
import { BulletinListComponent } from './bulletin-list.component';
import { RundownComponent } from './rundown.component';
import { PrompterComponent } from './prompter.component';
import { WiresComponent } from './wires.component';
import { StoryEditorDialogComponent, type StoryEditorData } from './story-editor-dialog.component';
import { SendToAirDialogComponent } from './send-to-air-dialog.component';
import { BulletinExportDialogComponent, type BulletinExportData } from './bulletin-export-dialog.component';

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD'yi gün bazında kaydırır (UTC takvim aritmetiği — DST/TZ etkisi yok). */
function shiftDay(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Haber (NewsWorks NRCS) — modül kabuğu (shell) / orchestrator.
 * 3-pane: sol (Bültenler + Haber Havuzu) · orta (Akış / Prompter) · sağ (Ajans).
 * EGS NewsWorks 2000 yerine native newsroom. Çocuk bileşenleri koordine eder,
 * NewsService'i çağırır, dialog'ları açar.
 */
@Component({
  selector: 'bp-news-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, MatIconModule, BulletinListComponent, RundownComponent, PrompterComponent, WiresComponent],
  template: `
    <section class="ns">
      <header class="ns-head">
        <div class="nh-left">
          <mat-icon class="material-icons-outlined logo">feed</mat-icon>
          <h1>Haber</h1>
          <div class="date-nav">
            <button type="button" class="day-arw" (click)="shiftDate(-1)" title="Önceki gün" aria-label="Önceki gün"><mat-icon class="material-icons-outlined">chevron_left</mat-icon></button>
            <input class="date" type="date" [ngModel]="filterDate()" (ngModelChange)="onDate($event)" />
            <button type="button" class="day-arw" (click)="shiftDate(1)" title="Sonraki gün" aria-label="Sonraki gün"><mat-icon class="material-icons-outlined">chevron_right</mat-icon></button>
          </div>
        </div>
        <div class="nh-views">
          <button type="button" [class.on]="view() === 'rundown'" (click)="view.set('rundown')"><mat-icon class="material-icons-outlined">list_alt</mat-icon> Akış</button>
          <button type="button" [class.on]="view() === 'prompter'" (click)="view.set('prompter')"><mat-icon class="material-icons-outlined">subtitles</mat-icon> Prompter</button>
          <button type="button" (click)="reloadAll()" title="Yenile"><mat-icon class="material-icons-outlined">refresh</mat-icon></button>
        </div>
      </header>

      <div class="ns-body">
        <aside class="pane left">
          <bp-bulletin-list
            [bulletins]="bulletins()" [selectedId]="selectedId()" [forDate]="filterDate()"
            (select)="selectBulletin($event)" (create)="createBulletin($event)" (remove)="deleteBulletin($event)" />
          <div class="pool">
            <div class="pool-h">Haber Havuzu <span>{{ pool().length }}</span></div>
            <div class="pool-items">
              @for (s of pool(); track s.id) {
                <div class="pool-item">
                  <span class="pi-type">{{ typeLabel(s.storyType) }}</span>
                  <span class="pi-title" (dblclick)="editStory(s)">{{ s.title }}</span>
                  <span class="pi-dur">{{ dur(s.clipDurationSec) }}</span>
                  <mat-icon class="material-icons-outlined add"
                    [class.dis]="!selectedId() && !inBulletin(s)" [class.added]="inBulletin(s)"
                    [title]="inBulletin(s) ? 'Bu haber bültende zaten var' : 'Bültene ekle (kopya — havuzda kalır)'"
                    (click)="poolToBulletin(s)">{{ inBulletin(s) ? 'done' : 'south' }}</mat-icon>
                </div>
              } @empty { <div class="pool-empty">Havuz boş.</div> }
            </div>
            <button type="button" class="pool-new" (click)="newPoolStory()"><mat-icon class="material-icons-outlined">add</mat-icon> Havuza Haber</button>
          </div>
        </aside>

        <main class="pane center">
          @if (view() === 'rundown') {
            <bp-rundown [bulletin]="bulletin()"
              (addStory)="addStory()" (editStory)="editStory($event)" (reorder)="reorder($event)"
              (deleteStory)="deleteStory($event)" (sendStory)="sendStory($event)" (lockToggle)="lockToggle($event)"
              (exportBulletin)="exportBulletin()" />
          } @else {
            <bp-prompter [bulletin]="bulletin()" />
          }
        </main>

        <aside class="pane right">
          <bp-wires [wires]="wires()" (toStory)="wireToStory($event)" (refresh)="loadWires()" (addManual)="addWire($event)" />
        </aside>
      </div>
    </section>
  `,
  styles: [`
    .ns { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bp-bg-0); }
    .ns-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--bp-line-2); background: var(--bp-bg-1); }
    .nh-left { display: flex; align-items: center; gap: 12px; }
    .nh-left .logo { color: var(--bp-purple-300); }
    .nh-left h1 { margin: 0; font-size: 18px; font-weight: 600; color: var(--bp-fg-1); }
    .date-nav { display: inline-flex; align-items: center; gap: 4px; }
    .date { background: var(--bp-bg-0); color: var(--bp-fg-1); border: 1px solid var(--bp-line-2); border-radius: 6px; padding: 6px 8px; font-size: 13px; }
    .day-arw { display: inline-flex; align-items: center; justify-content: center; background: var(--bp-bg-0); color: var(--bp-fg-3); border: 1px solid var(--bp-line-2); border-radius: 6px; width: 30px; height: 30px; padding: 0; cursor: pointer; }
    .day-arw:hover { color: var(--bp-fg-1); border-color: var(--bp-purple-500); background: rgba(124,58,237,0.12); }
    .day-arw mat-icon { font-size: 20px; width: 20px; height: 20px; }
    .nh-views { display: inline-flex; gap: 6px; }
    .nh-views button { display: inline-flex; align-items: center; gap: 5px; background: var(--bp-bg-0); color: var(--bp-fg-3); border: 1px solid var(--bp-line-2); border-radius: 7px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
    .nh-views button.on { background: rgba(124,58,237,0.18); border-color: var(--bp-purple-500); color: var(--bp-fg-1); }
    .nh-views mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .ns-body { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 300px 1fr 320px; }
    .pane { min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
    .pane.left { border-right: 1px solid var(--bp-line-2); }
    .pane.right { border-left: 1px solid var(--bp-line-2); }
    .pane.center { background: var(--bp-bg-2); }
    .pane.left { background: var(--bp-bg-1); }
    .left bp-bulletin-list { flex: 1 1 55%; min-height: 0; display: block; overflow: hidden; }
    .pool { flex: 1 1 45%; min-height: 0; display: flex; flex-direction: column; border-top: 2px solid var(--bp-line-2); }
    .pool-h { padding: 8px 12px; font-size: 12px; font-weight: 600; color: var(--bp-fg-1); display: flex; justify-content: space-between; }
    .pool-h span { color: var(--bp-fg-3); }
    .pool-items { flex: 1 1 auto; overflow: auto; min-height: 0; }
    .pool-item { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--bp-line-2); font-size: 12px; }
    .pi-type { font-size: 10px; color: var(--bp-fg-3); min-width: 42px; }
    .pi-title { flex: 1; color: var(--bp-fg-1); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pi-dur { color: var(--bp-fg-3); font-variant-numeric: tabular-nums; }
    .add { font-size: 16px; width: 16px; height: 16px; color: var(--bp-purple-300); cursor: pointer; }
    .add.dis { color: var(--bp-fg-3); opacity: 0.4; cursor: default; }
    .add.added { color: #34d399; cursor: default; }
    .pool-empty { padding: 14px; font-size: 12px; color: var(--bp-fg-3); text-align: center; }
    .pool-new { margin: 8px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; background: var(--bp-bg-0); color: var(--bp-fg-1); border: 1px solid var(--bp-line-2); border-radius: 7px; padding: 7px; cursor: pointer; font-size: 12px; }
    .pool-new mat-icon { font-size: 16px; width: 16px; height: 16px; }
  `],
})
export class NewsShellComponent implements OnInit {
  private readonly svc = inject(NewsService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  readonly filterDate = signal(today());
  readonly view = signal<'rundown' | 'prompter'>('rundown');
  readonly bulletins = signal<NewsBulletin[]>([]);
  readonly selectedId = signal<number | null>(null);
  readonly bulletin = signal<NewsBulletin | null>(null);
  readonly pool = signal<NewsStory[]>([]);
  readonly wires = signal<NewsWireItem[]>([]);

  ngOnInit(): void { this.reloadAll(); }

  /** Seçili bültende bulunan havuz-haberi kökenleri (sourceStoryId set'i). */
  readonly bulletinSourceIds = computed(
    () => new Set((this.bulletin()?.stories ?? []).map((st) => st.sourceStoryId).filter((x): x is number => x != null)),
  );
  /** Havuz haberi seçili bültende zaten var mı (kökenine göre). */
  inBulletin(s: NewsStory): boolean { return this.bulletinSourceIds().has(s.id); }

  typeLabel(t: string): string { return STORY_TYPE_LABELS[t] ?? t; }
  dur(sec: number): string { return secToClock(sec); }

  reloadAll(): void { this.loadBulletins(); this.loadPool(); this.loadWires(); }

  onDate(date: string): void { this.filterDate.set(date); this.loadBulletins(); }
  shiftDate(delta: number): void { this.onDate(shiftDay(this.filterDate(), delta)); }

  loadBulletins(): void {
    this.svc.listBulletins({ date: this.filterDate() }).subscribe({
      next: (list) => {
        this.bulletins.set(list);
        const sel = this.selectedId();
        if (sel && !list.some((b) => b.id === sel)) { this.selectedId.set(null); this.bulletin.set(null); }
      },
      error: () => this.err('Bültenler yüklenemedi'),
    });
  }
  loadPool(): void { this.svc.listStories({ pool: true }).subscribe({ next: (s) => this.pool.set(s), error: () => {} }); }
  loadWires(): void { this.svc.listWires().subscribe({ next: (w) => this.wires.set(w), error: () => {} }); }

  selectBulletin(id: number): void {
    this.selectedId.set(id);
    this.svc.getBulletin(id).subscribe({ next: (b) => this.bulletin.set(b), error: () => this.err('Bülten açılamadı') });
  }
  private refreshBulletin(): void { const id = this.selectedId(); if (id) this.selectBulletin(id); }

  createBulletin(dto: CreateBulletinDto): void {
    this.svc.createBulletin(dto).subscribe({
      next: (b) => { this.loadBulletins(); this.selectBulletin(b.id); this.ok('Bülten oluşturuldu'); },
      error: () => this.err('Bülten oluşturulamadı'),
    });
  }
  deleteBulletin(id: number): void {
    if (!confirm('Bülten silinecek. Haberleri Haber Havuzu\'na taşınacak. Onaylıyor musunuz?')) return;
    this.svc.deleteBulletin(id).subscribe({
      next: () => { if (this.selectedId() === id) { this.selectedId.set(null); this.bulletin.set(null); } this.loadBulletins(); this.loadPool(); this.ok('Bülten silindi'); },
      error: () => this.err('Bülten silinemedi'),
    });
  }
  reorder(ids: number[]): void {
    const id = this.selectedId(); if (!id) return;
    this.svc.reorderStories(id, ids).subscribe({ next: (b) => this.bulletin.set(b), error: () => this.err('Sıralama kaydedilemedi') });
  }

  addStory(): void { this.openEditor({ bulletinId: this.selectedId() }); }
  newPoolStory(): void { this.openEditor({ bulletinId: null }); }
  editStory(story: NewsStory): void { this.openEditor({ story }); }

  private openEditor(data: StoryEditorData): void {
    this.dialog.open(StoryEditorDialogComponent, {
      data, autoFocus: false, restoreFocus: false,
      width: '75vw', height: '96vh', maxWidth: '75vw', maxHeight: '96vh',
    })
      .afterClosed().subscribe((saved?: NewsStory) => {
        if (!saved) return;
        this.refreshBulletin(); this.loadPool();
        this.ok('Haber kaydedildi');
      });
  }

  deleteStory(id: number): void {
    if (!confirm('Haber çöpe atılacak. Onaylıyor musunuz?')) return;
    this.svc.deleteStory(id).subscribe({ next: () => { this.refreshBulletin(); this.loadPool(); this.ok('Haber çöpe atıldı'); }, error: (e) => this.err(e?.error?.message ?? 'Silinemedi') });
  }
  lockToggle(s: NewsStory): void {
    const op = s.locked ? this.svc.unlockStory(s.id) : this.svc.lockStory(s.id);
    op.subscribe({ next: () => this.refreshBulletin(), error: (e) => this.err(e?.error?.message ?? 'Kilit işlemi başarısız') });
  }
  poolToBulletin(s: NewsStory): void {
    const id = this.selectedId(); if (!id) { this.err('Önce bir bülten seçin'); return; }
    if (this.inBulletin(s)) return; // aynı haber bir bültene tek kez
    // Kopya: havuz haberi yerinde kalır, başka bültenlerde de kullanılabilir.
    this.svc.copyStoryToBulletin(s.id, id).subscribe({
      next: () => { this.refreshBulletin(); this.ok('Haber bültene eklendi (havuzda kaldı)'); },
      error: (e) => this.err(e?.error?.message ?? 'Eklenemedi'),
    });
  }

  sendStory(story: NewsStory): void {
    this.svc.listMosDevices().pipe(catchError(() => of([]))).subscribe((devices) => {
      this.dialog.open(SendToAirDialogComponent, { data: { story, devices }, autoFocus: false });
    });
  }

  exportBulletin(): void {
    const b = this.bulletin();
    if (!b) { this.err('Önce bir bülten seçin'); return; }
    const data: BulletinExportData = { bulletinId: b.id, bulletinName: b.name };
    this.dialog.open(BulletinExportDialogComponent, { data, autoFocus: false, width: '820px', maxWidth: '94vw' });
  }

  wireToStory(id: number): void {
    this.svc.wireToStory(id).subscribe({ next: () => { this.loadWires(); this.loadPool(); this.ok('Ajans haberi havuza eklendi'); }, error: (e) => this.err(e?.error?.message ?? 'Çevrilemedi') });
  }
  addWire(dto: { source: string; headline: string; body: string; priority: string }): void {
    this.svc.createWire(dto).subscribe({ next: () => { this.loadWires(); this.ok('Ajans haberi eklendi'); }, error: () => this.err('Eklenemedi') });
  }

  private ok(m: string): void { this.snack.open(m, 'Kapat', { duration: 2500 }); }
  private err(m: string): void { this.snack.open(m, 'Kapat', { duration: 4000 }); }
}
