import { ChangeDetectionStrategy, Component, Inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import type { BulletinExportResult } from '@bcms/shared';
import { NewsService } from './news.service';

export interface BulletinExportData {
  bulletinId: number;
  bulletinName: string;
}

/**
 * "Bülteni Gönder" — EGS dışa-aktarım. Açılışta dry-run önizleme (out + xml)
 * çeker; "Gönder" SMB'ye yazar (Ayarlar > Haber yolları). out + xml birlikte gider.
 */
@Component({
  selector: 'bp-bulletin-export-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, MatDialogModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Bülteni Gönder — {{ data.bulletinName }}</h2>
    <div mat-dialog-content class="bx">
      @if (preview(); as p) {
        <div class="meta">
          <span class="pill">{{ p.base }}</span>
          <span>{{ p.storyCount }} haber · {{ p.sceneCount }} KJ/SPOT</span>
        </div>

        <div class="tabs">
          <button type="button" [class.on]="tab() === 'out'" (click)="tab.set('out')">
            <mat-icon class="material-icons-outlined">subtitles</mat-icon> {{ p.prompter.filename }}
          </button>
          <button type="button" [class.on]="tab() === 'xml'" (click)="tab.set('xml')">
            <mat-icon class="material-icons-outlined">code</mat-icon> {{ p.vizrt.filename }}
          </button>
        </div>
        <pre class="prev">{{ tab() === 'out' ? p.prompter.text : p.vizrt.text }}</pre>

        @if (result(); as r) {
          <div class="result" [class.err]="r.partial">
            <div class="rh">{{ r.partial ? 'Kısmen gönderildi' : 'Gönderildi' }}</div>
            @for (w of r.written; track w.kind) {
              <div class="rrow" [class.bad]="!w.ok">
                <mat-icon class="material-icons-outlined">{{ w.ok ? 'check_circle' : 'error' }}</mat-icon>
                <span class="rk">{{ w.kind === 'prompter' ? 'Prompter (_out.WIN)' : 'Vizrt (.xml)' }}</span>
                <span class="rt">{{ w.ok ? (w.target + ' · ' + w.bytes + ' B') : w.error }}</span>
              </div>
            }
          </div>
        }
      } @else if (loadError()) {
        <div class="empty err">{{ loadError() }}</div>
      } @else {
        <div class="empty">Önizleme hazırlanıyor…</div>
      }
    </div>
    <div mat-dialog-actions class="bx-act">
      <span class="spacer"></span>
      <button type="button" class="btn-ghost" (click)="dialogRef.close()">Kapat</button>
      <button type="button" class="btn-send" [disabled]="!preview() || sending()" (click)="send()">
        <mat-icon class="material-icons-outlined">send</mat-icon>
        {{ sending() ? 'Gönderiliyor…' : 'SMB’ye Gönder (out + xml)' }}
      </button>
    </div>
  `,
  styles: [`
    .bx { display: flex; flex-direction: column; gap: 12px; min-width: 620px; max-width: 760px; }
    .meta { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--bp-fg-3); }
    .pill { font-family: monospace; font-size: 12px; background: var(--bp-bg-1); border: 1px solid var(--bp-line-2); border-radius: 6px; padding: 3px 8px; color: var(--bp-fg-1); }
    .tabs { display: inline-flex; gap: 6px; }
    .tabs button { display: inline-flex; align-items: center; gap: 5px; background: var(--bp-bg-0); color: var(--bp-fg-3); border: 1px solid var(--bp-line-2); border-radius: 7px 7px 0 0; padding: 6px 12px; cursor: pointer; font-size: 12px; font-family: monospace; }
    .tabs button.on { background: rgba(124,58,237,0.18); border-color: var(--bp-purple-500); color: var(--bp-fg-1); }
    .tabs mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .prev { margin: 0; padding: 12px; font-size: 12px; color: #a5f3fc; background: #05070a; border: 1px solid var(--bp-line-2); border-radius: 0 8px 8px 8px; overflow: auto; max-height: 320px; white-space: pre-wrap; word-break: break-word; }
    .result { border: 1px solid rgba(52,211,153,0.4); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
    .result.err { border-color: rgba(248,113,113,0.5); }
    .rh { font-size: 12px; font-weight: 600; color: var(--bp-fg-1); }
    .rrow { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--bp-fg-1); }
    .rrow mat-icon { font-size: 16px; width: 16px; height: 16px; color: #34d399; }
    .rrow.bad mat-icon { color: #f87171; }
    .rk { min-width: 150px; color: var(--bp-fg-3); }
    .rt { flex: 1; font-family: monospace; word-break: break-all; }
    .empty { padding: 20px; text-align: center; font-size: 13px; color: var(--bp-fg-3); }
    .empty.err { color: #f87171; }
    .bx-act { display: flex; align-items: center; } .spacer { flex: 1; }
    .btn-ghost { background: transparent; border: 1px solid var(--bp-line-2); color: var(--bp-fg-1); border-radius: 7px; padding: 8px 14px; cursor: pointer; font-size: 13px; }
    .btn-send { display: inline-flex; align-items: center; gap: 6px; background: var(--bp-purple-500); color: #fff; border: none; border-radius: 7px; padding: 8px 16px; cursor: pointer; font-size: 13px; margin-left: 8px; }
    .btn-send:disabled { opacity: 0.5; cursor: default; }
    .btn-send mat-icon { font-size: 18px; width: 18px; height: 18px; }
  `],
})
export class BulletinExportDialogComponent implements OnInit {
  readonly preview = signal<BulletinExportResult | null>(null);
  readonly result = signal<BulletinExportResult | null>(null);
  readonly loadError = signal('');
  readonly sending = signal(false);
  readonly tab = signal<'out' | 'xml'>('out');

  constructor(
    readonly dialogRef: MatDialogRef<BulletinExportDialogComponent>,
    @Inject(MAT_DIALOG_DATA) readonly data: BulletinExportData,
    private readonly svc: NewsService,
    private readonly snack: MatSnackBar,
  ) {}

  ngOnInit(): void {
    this.svc.exportBulletin(this.data.bulletinId, true).subscribe({
      next: (res) => this.preview.set(res),
      error: (e) => this.loadError.set(e?.error?.message ?? 'Önizleme alınamadı'),
    });
  }

  send(): void {
    this.sending.set(true);
    this.svc.exportBulletin(this.data.bulletinId, false).subscribe({
      next: (res) => {
        this.sending.set(false);
        this.result.set(res);
        this.snack.open(res.partial ? 'Kısmen gönderildi — detaylar aşağıda' : 'Bülten SMB’ye gönderildi (out + xml)', 'Kapat', { duration: 4000 });
      },
      error: (e) => {
        this.sending.set(false);
        this.snack.open(e?.error?.message ?? 'Gönderim başarısız', 'Kapat', { duration: 5000 });
      },
    });
  }
}
