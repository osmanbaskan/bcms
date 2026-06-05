import { ChangeDetectionStrategy, Component, Inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import type { NewsMosAction, NewsMosDevice, NewsStory } from '@bcms/shared';
import { NewsService } from './news.service';

export interface SendToAirData {
  story: NewsStory;
  devices: NewsMosDevice[];
}

/**
 * "Yayına Gönder" (EGS: KJ/SPOT → VizRT XML + MOS). KJ/SPOT'lar ve CRAWL/ROLL
 * için dryRun önizleme (XML) + gerçek gönderim (cihaz seçili). Cihaz yoksa
 * yalnız önizleme döner.
 */
@Component({
  selector: 'bp-send-to-air-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, MatDialogModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Yayına Gönder — {{ data.story.title }}</h2>
    <div mat-dialog-content class="sa">
      <div class="dev">
        <label>Çıkış cihazı
          <select class="in" [(ngModel)]="deviceId">
            <option [ngValue]="null">— (yalnız önizleme / dry-run) —</option>
            @for (d of data.devices; track d.id) { <option [ngValue]="d.id">{{ d.name }} ({{ d.kind }})</option> }
          </select>
        </label>
      </div>

      <div class="lts">
        <div class="sec-t">KJ / SPOT</div>
        @for (lt of data.story.lowerThirds; track lt.id) {
          <div class="lt-row">
            <span class="kind k-{{ lt.kind }}">{{ lt.kind }}</span>
            <span class="lt-txt">{{ lt.title }} @if (lt.line1) { · {{ lt.line1 }} }</span>
            <button type="button" class="b" (click)="run(lt.kind, lt.id, true)">Önizle</button>
            <button type="button" class="b send" (click)="run(lt.kind, lt.id, false)">Gönder</button>
          </div>
        } @empty { <div class="empty">Bu haberde KJ/SPOT yok.</div> }

        <div class="sec-t">Diğer</div>
        <div class="lt-row">
          <span class="kind k-CRAWL">CRAWL</span>
          <span class="lt-txt">Akan yazı (haber metni)</span>
          <button type="button" class="b" (click)="run('CRAWL', undefined, true)">Önizle</button>
          <button type="button" class="b send" (click)="run('CRAWL', undefined, false)">Gönder</button>
        </div>
        <div class="lt-row">
          <span class="kind k-ROLL">ROLL</span>
          <span class="lt-txt">Jenerik / roll</span>
          <button type="button" class="b" (click)="run('ROLL', undefined, true)">Önizle</button>
          <button type="button" class="b send" (click)="run('ROLL', undefined, false)">Gönder</button>
        </div>
      </div>

      @if (previewXml()) {
        <div class="prev">
          <div class="pv-h">{{ lastDryRun() ? 'Önizleme (XML)' : 'Gönderildi — payload (XML)' }}</div>
          <pre>{{ previewXml() }}</pre>
        </div>
      }
    </div>
    <div mat-dialog-actions class="sa-act">
      <span class="spacer"></span>
      <button type="button" class="btn-ghost" (click)="dialogRef.close()">Kapat</button>
    </div>
  `,
  styles: [`
    .sa { display: flex; flex-direction: column; gap: 12px; min-width: 560px; max-width: 680px; }
    .dev label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--bp-fg-3); }
    .in { background: var(--bp-bg-0); color: var(--bp-fg-1); border: 1px solid var(--bp-line-2); border-radius: 6px; padding: 8px; font-size: 13px; }
    .sec-t { font-size: 11px; text-transform: uppercase; color: var(--bp-fg-3); margin: 6px 0 2px; }
    .lt-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--bp-line-2); }
    .kind { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 5px; min-width: 46px; text-align: center; }
    .k-KJ { background: rgba(52,211,153,0.2); color: #34d399; }
    .k-SPOT { background: rgba(124,58,237,0.2); color: var(--bp-purple-300); }
    .k-CRAWL, .k-ROLL { background: var(--bp-bg-0); color: var(--bp-fg-1); border: 1px solid var(--bp-line-2); }
    .lt-txt { flex: 1; font-size: 13px; color: var(--bp-fg-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .b { background: var(--bp-bg-1); border: 1px solid var(--bp-line-2); color: var(--bp-fg-1); border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
    .b.send { background: var(--bp-purple-500); border-color: var(--bp-purple-500); color: #fff; }
    .empty { font-size: 12px; color: var(--bp-fg-3); padding: 4px 0; }
    .prev { border: 1px solid var(--bp-line-2); border-radius: 8px; overflow: hidden; }
    .pv-h { font-size: 11px; color: var(--bp-fg-3); padding: 6px 10px; background: var(--bp-bg-1); border-bottom: 1px solid var(--bp-line-2); }
    pre { margin: 0; padding: 10px; font-size: 12px; color: #a5f3fc; background: #05070a; overflow: auto; max-height: 260px; }
    .sa-act { display: flex; } .spacer { flex: 1; }
    .btn-ghost { background: transparent; border: 1px solid var(--bp-line-2); color: var(--bp-fg-1); border-radius: 7px; padding: 7px 14px; cursor: pointer; font-size: 13px; }
  `],
})
export class SendToAirDialogComponent {
  deviceId: number | null = null;
  readonly previewXml = signal('');
  readonly lastDryRun = signal(true);

  constructor(
    readonly dialogRef: MatDialogRef<SendToAirDialogComponent>,
    @Inject(MAT_DIALOG_DATA) readonly data: SendToAirData,
    private readonly svc: NewsService,
    private readonly snack: MatSnackBar,
  ) {}

  run(action: NewsMosAction, lowerThirdId: number | undefined, dryRun: boolean): void {
    this.svc.sendToAir(this.data.story.id, { action, lowerThirdId, deviceId: this.deviceId, dryRun }).subscribe({
      next: (res) => {
        this.previewXml.set(res.previewXml);
        this.lastDryRun.set(res.dryRun);
        if (!dryRun) {
          this.snack.open(res.dryRun ? 'Cihaz seçili değil — yalnız önizleme üretildi' : `${action} yayına gönderildi (#${res.job?.id})`, 'Kapat', { duration: 3500 });
        }
      },
      error: (e) => this.snack.open(e?.error?.message ?? 'Gönderim başarısız', 'Kapat', { duration: 4000 }),
    });
  }
}
