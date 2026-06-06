import { ChangeDetectionStrategy, Component, Inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { of, switchMap } from 'rxjs';
import type { NewsLowerThirdKind, NewsStory, NewsStoryType, UpsertLowerThirdDto } from '@bcms/shared';
import { NewsService } from './news.service';

export interface StoryEditorData {
  story?: NewsStory;
  bulletinId?: number | null;
}

const TYPES: { v: NewsStoryType; l: string }[] = [
  { v: 'PKG', l: 'Paket' }, { v: 'VO', l: 'VO' }, { v: 'VOSOT', l: 'VO/SOT' },
  { v: 'READER', l: 'Spiker' }, { v: 'LIVE', l: 'Canlı' }, { v: 'PHONE', l: 'Telefon' },
  { v: 'CRAWL', l: 'Crawl' }, { v: 'ROLL', l: 'Roll' },
];

interface LtRow { kind: NewsLowerThirdKind; title: string; line1: string; line2: string; }

/**
 * Haber editörü (EGS "Haber" düzenleme). Form + prompter metni + KJ/SPOT
 * paneli + Koru/Kilitle + büyük/küçük harf. Kaydet → story + lower-thirds.
 * Optimistic-lock (version) ve kilit (409) hataları snackbar ile bildirilir.
 */
@Component({
  selector: 'bp-story-editor-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, MatDialogModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>{{ isEdit ? 'Haberi Düzenle' : 'Yeni Haber' }}
      @if (locked()) { <span class="lk"><mat-icon class="material-icons-outlined">lock</mat-icon> {{ lockedBy() }}</span> }
    </h2>
    <div mat-dialog-content class="se">
      <!-- ÜST: form alanları yatay -->
      <div class="se-top">
        <label class="fl wide">Haber Adı
          <div class="with-btn">
            <input class="in" [(ngModel)]="title" maxlength="300" placeholder="Başlık" />
            <button type="button" class="case" (click)="title = up(title)" title="Büyük harf">AA</button>
          </div>
        </label>
        <div class="se-fields">
          <label class="fl">Tür
            <select class="in" [(ngModel)]="storyType">
              @for (t of types; track t.v) { <option [value]="t.v">{{ t.l }}</option> }
            </select>
          </label>
          <label class="fl">Bant Süresi
            <span class="dur"><input class="in num" type="number" min="0" [(ngModel)]="durMin" /> dk
              <input class="in num" type="number" min="0" max="59" [(ngModel)]="durSec" /> sn</span>
          </label>
          <label class="fl">Spiker
            <input class="in" [(ngModel)]="anchorName" maxlength="200" placeholder="Spiker" />
          </label>
          <label class="fl">Görüntü Adı
            <input class="in" [(ngModel)]="displayName" maxlength="300" placeholder="Görüntü adı (ops.)" />
          </label>
          <label class="fl">Grup
            <input class="in" [(ngModel)]="newsGroup" maxlength="80" placeholder="Haber Hattı Grubu" />
          </label>
        </div>
      </div>

      <!-- AÇIKLAMA: artan dialog yüksekliğini bu alan yutar (flex-grow) -->
      <label class="fl se-desc">Açıklama
        <textarea class="in desc" [(ngModel)]="description" maxlength="20000" placeholder="Kısa açıklama"></textarea>
      </label>

      <!-- ANA: Prompter | KJ/SPOT yan yana, sabit yükseklik (büyümez) -->
      <div class="se-main">
        <label class="fl col-prompter">Prompter / Spiker Metni
          <div class="with-btn fill">
            <textarea class="in ta" [(ngModel)]="prompterText" placeholder="Spikerin okuyacağı metin..."></textarea>
            <button type="button" class="case" (click)="prompterText = up(prompterText)" title="Büyük harf">AA</button>
          </div>
        </label>

        <div class="kj-sec col-kj">
          <div class="kj-head">
            <span>KJ / SPOT (Altyazı)</span>
            <span class="kj-add">
              <button type="button" (click)="addLt('KJ')">+ KJ</button>
              <button type="button" (click)="addLt('SPOT')">+ SPOT</button>
            </span>
          </div>
          <div class="kj-list">
            @for (lt of lts(); track $index) {
              <div class="kj-row">
                <span class="kind k-{{ lt.kind }}">{{ lt.kind }}</span>
                <div class="kj-fields">
                  <input class="in" [(ngModel)]="lt.title" placeholder="Başlık" maxlength="300" />
                  <input class="in" [(ngModel)]="lt.line1" placeholder="1. satır" maxlength="300" />
                  <input class="in" [(ngModel)]="lt.line2" placeholder="2. satır" maxlength="300" />
                </div>
                <mat-icon class="material-icons-outlined rm" (click)="removeLt($index)" title="Sil">close</mat-icon>
              </div>
            } @empty { <div class="kj-empty">KJ/SPOT yok. "+ KJ" veya "+ SPOT" ile ekleyin.</div> }
          </div>
        </div>
      </div>
    </div>

    <div mat-dialog-actions class="se-actions">
      @if (isEdit) {
        <button type="button" class="btn-ghost" (click)="toggleLock()">
          <mat-icon class="material-icons-outlined">{{ locked() ? 'lock_open' : 'lock' }}</mat-icon>
          {{ locked() ? 'Kilidi Aç' : 'Koru' }}
        </button>
      }
      <span class="spacer"></span>
      <button type="button" class="btn-ghost" (click)="close()">Vazgeç</button>
      <button type="button" class="btn-primary" [disabled]="!title.trim() || saving()" (click)="save()">
        {{ saving() ? 'Kaydediliyor…' : 'Kaydet' }}
      </button>
    </div>
  `,
  styles: [`
    /* MDC mat-dialog-content varsayılan max-height:65vh cap'ini kaldır; dialog
       yüksekliğini (96vh) tam doldursun, alt boşluk kalmasın. */
    .se { display: flex; flex-direction: column; gap: 12px; height: 100%; max-height: none; min-height: 0; overflow: hidden; }
    .fl { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--bp-fg-3); }
    .se-top { display: flex; flex-direction: column; gap: 10px; flex: 0 0 auto; }
    .se-fields { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
    /* Açıklama büyüyen alan; prompter/KJ bloğu sabit (artan yükseklik açıklamaya gider). */
    .se-desc { flex: 1 1 auto; min-height: 80px; }
    .se-main { display: flex; gap: 14px; flex: 0 0 48vh; min-height: 240px; }
    .col-prompter { flex: 1 1 58%; min-height: 0; }
    .col-kj { flex: 1 1 42%; min-height: 0; }
    .in { background: var(--bp-bg-0); color: var(--bp-fg-1); border: 1px solid var(--bp-line-2); border-radius: 6px; padding: 8px; font-size: 13px; width: 100%; }
    .in.ta { resize: none; font-family: inherit; line-height: 1.55; flex: 1 1 auto; min-height: 0; }
    .in.desc { resize: none; font-family: inherit; line-height: 1.5; flex: 1 1 auto; min-height: 0; }
    .with-btn.fill { align-items: stretch; flex: 1 1 auto; min-height: 0; }
    .with-btn.fill .case { align-self: flex-start; }
    .in.num { width: 56px; }
    .dur { display: inline-flex; align-items: center; gap: 4px; color: var(--bp-fg-3); font-size: 12px; }
    .with-btn { display: flex; gap: 6px; align-items: flex-start; }
    .case { background: var(--bp-bg-1); border: 1px solid var(--bp-line-2); color: var(--bp-fg-3); border-radius: 6px; padding: 0 8px; cursor: pointer; font-size: 11px; align-self: stretch; }
    .lk { font-size: 12px; color: #f59e0b; display: inline-flex; align-items: center; gap: 3px; margin-left: 8px; }
    .lk mat-icon { font-size: 15px; width: 15px; height: 15px; }
    .kj-sec { border: 1px solid var(--bp-line-2); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
    .kj-list { flex: 1 1 auto; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
    .kj-head { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--bp-fg-1); font-weight: 600; }
    .kj-add button { background: rgba(124,58,237,0.18); border: 1px solid var(--bp-purple-500); color: var(--bp-fg-1); border-radius: 6px; padding: 3px 8px; margin-left: 6px; cursor: pointer; font-size: 11px; }
    .kj-row { display: flex; align-items: flex-start; gap: 8px; padding: 8px; border: 1px solid var(--bp-line-2); border-radius: 7px; background: var(--bp-bg-0); }
    .kind { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 5px; min-width: 38px; text-align: center; }
    .k-KJ { background: rgba(52,211,153,0.2); color: #34d399; }
    .k-SPOT { background: rgba(124,58,237,0.2); color: var(--bp-purple-300); }
    /* Başlık / 1. satır / 2. satır artık ALT ALTA (dikey) → her biri tam genişlik. */
    .kj-fields { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
    .rm { font-size: 16px; width: 16px; height: 16px; color: var(--bp-fg-3); cursor: pointer; }
    .rm:hover { color: #ef4444; }
    .kj-empty { font-size: 12px; color: var(--bp-fg-3); }
    .se-actions { display: flex; align-items: center; gap: 8px; padding-top: 8px; }
    .spacer { flex: 1; }
    .btn-ghost { display: inline-flex; align-items: center; gap: 4px; background: transparent; border: 1px solid var(--bp-line-2); color: var(--bp-fg-1); border-radius: 7px; padding: 7px 12px; cursor: pointer; font-size: 13px; }
    .btn-ghost mat-icon { font-size: 17px; width: 17px; height: 17px; }
    .btn-primary { background: var(--bp-purple-500); color: #fff; border: none; border-radius: 7px; padding: 8px 16px; cursor: pointer; font-size: 13px; }
    .btn-primary:disabled { opacity: 0.5; cursor: default; }
  `],
})
export class StoryEditorDialogComponent {
  readonly types = TYPES;
  readonly isEdit: boolean;
  private readonly storyId: number | null;
  private readonly bulletinId: number | null;
  private version: number;

  title = '';
  displayName = '';
  storyType: NewsStoryType = 'READER';
  durMin = 0;
  durSec = 0;
  anchorName = '';
  description = '';
  prompterText = '';
  newsGroup = '';

  readonly lts = signal<LtRow[]>([]);
  readonly saving = signal(false);
  readonly locked = signal(false);
  readonly lockedBy = signal<string | null>(null);

  constructor(
    private readonly dialogRef: MatDialogRef<StoryEditorDialogComponent, NewsStory | undefined>,
    @Inject(MAT_DIALOG_DATA) data: StoryEditorData,
    private readonly svc: NewsService,
    private readonly snack: MatSnackBar,
  ) {
    const s = data.story;
    this.isEdit = !!s;
    this.storyId = s?.id ?? null;
    this.bulletinId = s ? s.bulletinId : (data.bulletinId ?? null);
    this.version = s?.version ?? 0;
    if (s) {
      this.title = s.title;
      this.displayName = s.displayName ?? '';
      this.storyType = s.storyType;
      this.durMin = Math.floor(s.clipDurationSec / 60);
      this.durSec = s.clipDurationSec % 60;
      this.anchorName = s.anchorName ?? '';
      this.description = s.description ?? '';
      this.prompterText = s.prompterText ?? '';
      this.newsGroup = s.newsGroup ?? '';
      this.locked.set(s.locked);
      this.lockedBy.set(s.lockedBy);
      this.lts.set(s.lowerThirds.map((lt) => ({ kind: lt.kind, title: lt.title ?? '', line1: lt.line1 ?? '', line2: lt.line2 ?? '' })));
    }
  }

  up(v: string): string { return v.toLocaleUpperCase('tr-TR'); }
  addLt(kind: NewsLowerThirdKind): void { this.lts.update((a) => [...a, { kind, title: '', line1: '', line2: '' }]); }
  removeLt(i: number): void { this.lts.update((a) => a.filter((_, idx) => idx !== i)); }

  private clipSec(): number { return Math.max(0, (this.durMin || 0) * 60 + (this.durSec || 0)); }
  private ltDtos(): UpsertLowerThirdDto[] {
    return this.lts().map((lt, i) => ({ kind: lt.kind, orderIndex: i, title: lt.title || null, line1: lt.line1 || null, line2: lt.line2 || null }));
  }

  toggleLock(): void {
    if (!this.storyId) return;
    const op = this.locked() ? this.svc.unlockStory(this.storyId) : this.svc.lockStory(this.storyId);
    op.subscribe({
      next: (s) => { this.locked.set(s.locked); this.lockedBy.set(s.lockedBy); this.version = s.version; },
      error: (e) => this.snack.open(this.msg(e, 'Kilit işlemi başarısız'), 'Kapat', { duration: 4000 }),
    });
  }

  save(): void {
    if (!this.title.trim()) return;
    this.saving.set(true);
    const dto = {
      title: this.title.trim(),
      displayName: this.displayName.trim() || null,
      storyType: this.storyType,
      clipDurationSec: this.clipSec(),
      anchorName: this.anchorName.trim() || null,
      description: this.description.trim() || null,
      prompterText: this.prompterText || null,
      newsGroup: this.newsGroup.trim() || null,
    };

    const base$ = this.isEdit && this.storyId
      ? this.svc.updateStory(this.storyId, dto, this.version)
      : this.svc.createStory({ ...dto, bulletinId: this.bulletinId });

    base$.pipe(
      switchMap((story) =>
        this.ltDtos().length || this.isEdit
          ? this.svc.replaceLowerThirds(story.id, this.ltDtos())
          : of(story),
      ),
    ).subscribe({
      next: (saved) => { this.saving.set(false); this.dialogRef.close(saved); },
      error: (e) => { this.saving.set(false); this.snack.open(this.msg(e, 'Kaydedilemedi'), 'Kapat', { duration: 5000 }); },
    });
  }

  close(): void { this.dialogRef.close(undefined); }

  private msg(e: { status?: number; error?: { message?: string } }, fallback: string): string {
    if (e?.status === 412) return 'Sürüm çakışması: haber başkası tarafından güncellendi. Kapatıp tekrar açın.';
    if (e?.status === 409) return e.error?.message ?? 'Haber kilitli — düzenlenemez.';
    return e?.error?.message ?? fallback;
  }
}
