import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import {
  ASRUN_CHANNELS,
  PROVYS_CATEGORY_STYLES,
  type AsrunChannelSlug,
  type AsrunMergeItemDto,
} from '@bcms/shared';

/** Europe/Istanbul dün (asrun gün-sonu kaynağı; bugünün merge'i ertesi gece oluşur). */
function istanbulYesterdayDate(): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return prev.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Asrun-Merge (2026-06-10) — "o gün GERÇEKTE ne yayınlandı".
 * Playout router ile konuşmadığı için asrun canlıda yanıltıcıdır; bu sekme
 * Provys CANLI bloklarını KİLİTLİ koyar, asrun satırlarını boşluklara kırparak
 * yerleştirir. Rozetler: 🔒 canlı blok · ✂ kırpıldı · "P" isim Provys'ten ·
 * sınır plan-bazlı ⚠ / asrun akışından ✓.
 */
@Component({
  selector: 'app-asrun-merge',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatButtonModule, MatTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="top">
        <div>
          <h1 class="page-title">Asrun-Merge (Gerçek Yayın)</h1>
          <p class="subtitle">Provys CANLI blokları (kilitli) + asrun boşluk dolgusu — playout/router kör noktası düzeltilmiş as-run.</p>
        </div>
        <div class="controls">
          <button mat-icon-button matTooltip="Önceki gün" (click)="shiftDate(-1)"><mat-icon>chevron_left</mat-icon></button>
          <label class="date-control">
            <span>Yayın günü</span>
            <input type="date" [value]="date()" (change)="onDate($any($event.target).value)" />
          </label>
          <button mat-icon-button matTooltip="Sonraki gün" (click)="shiftDate(1)"><mat-icon>chevron_right</mat-icon></button>
          <button mat-stroked-button (click)="load()" matTooltip="Yenile"><mat-icon>refresh</mat-icon> Yenile</button>
        </div>
      </header>

      <div class="ch-tabs">
        @for (c of channels; track c.slug) {
          <button type="button" class="ch-tab" [class.on]="c.slug === channel()" (click)="setChannel(c.slug)">{{ c.displayName }}</button>
        }
      </div>

      <div class="state" *ngIf="loading()">Yükleniyor…</div>
      <div class="state empty" *ngIf="!loading() && rows().length === 0">
        Bu gün için merge kaydı yok. (Merge, asrun dosyası gece düştüğünde otomatik kurulur.)
      </div>

      <div class="table-wrap" *ngIf="!loading() && rows().length > 0">
        <table>
          <thead><tr>
            <th class="c-time">Başlangıç</th><th class="c-time">Bitiş</th><th class="c-dur">Süre</th>
            <th class="c-dc">DC Kod</th><th>Başlık</th><th class="c-cat">Kategori</th>
            <th class="c-src">Kaynak</th><th class="c-flags">Notlar</th>
          </tr></thead>
          <tbody>
            @for (r of rows(); track r.id) {
              <tr [class.live]="r.origin === 'PROVYS_CANLI'">
                <td class="mono">{{ fmtTime(r.startAt) }}</td>
                <td class="mono">{{ fmtTime(r.endAt) }}</td>
                <td class="mono">{{ fmtDur(r.durationMs) }}</td>
                <td class="mono">{{ r.dcCode ?? '—' }}</td>
                <td class="c-title">
                  {{ r.title }}
                  @if (r.titleSource === 'PROVYS' && r.origin === 'ASRUN') {
                    <span class="chip chip-p" matTooltip="İsim Provys'ten alındı (asrun'da isimsiz DC)">P</span>
                  }
                </td>
                <td><span class="chip" [style.background]="catStyle(r.category).background"
                          [style.borderColor]="catStyle(r.category).border"
                          [style.color]="catStyle(r.category).text">{{ catStyle(r.category).label }}</span></td>
                <td>
                  @if (r.origin === 'PROVYS_CANLI') {
                    <span class="chip chip-live"><mat-icon inline>lock</mat-icon> Canlı (Provys)</span>
                  } @else { <span class="chip chip-asrun">Asrun</span> }
                </td>
                <td class="c-flags">
                  @if (r.trimmed) { <span class="chip chip-trim" matTooltip="Canlı pencereyle çakışan kısım kırpıldı">✂ kırpıldı</span> }
                  @if (r.origin === 'PROVYS_CANLI') {
                    @if (r.startDetected) { <span class="chip chip-ok" matTooltip="Başlangıç asrun akışından tespit edildi">başl. ✓</span> }
                    @if (r.endDetected)   { <span class="chip chip-ok" matTooltip="Bitiş asrun akışından tespit edildi">bitiş ✓</span> }
                    @if (!r.startDetected && !r.endDetected) { <span class="chip chip-warn" matTooltip="Sınırlar plan bazlı (asrun akışı tespit edilemedi)">plan bazlı ⚠</span> }
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; color: var(--bp-fg-1); }
    .page { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px; }
    .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
    .page-title { margin: 0; font-size: 22px; font-weight: 600; }
    .subtitle { margin: 4px 0 0; color: var(--bp-fg-3); font-size: 12px; }
    .controls { display: flex; align-items: center; gap: 8px; }
    .date-control { display: flex; flex-direction: column; font-size: 10px; color: var(--bp-fg-3); }
    .date-control input { background: var(--bp-bg-3); color: var(--bp-fg-1); border: 1px solid var(--bp-line-2); border-radius: 6px; padding: 5px 8px; }
    .ch-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
    .ch-tab {
      padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer;
      background: var(--bp-bg-2); color: var(--bp-fg-2);
      border: 1px solid var(--bp-line-2); border-radius: var(--bp-r-pill, 999px);
    }
    .ch-tab.on { background: rgba(124,58,237,.20); color: var(--bp-acc-purple); border-color: rgba(124,58,237,.55); }
    .state { padding: 22px; text-align: center; color: var(--bp-fg-3); border: 1px solid var(--bp-line-2); border-radius: 6px; background: var(--bp-bg-2); }
    .table-wrap { border: 1px solid var(--bp-line-2); border-radius: 6px; background: var(--bp-bg-2); overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; min-width: 980px; }
    thead th { position: sticky; top: 0; background: var(--bp-bg-3); color: var(--bp-fg-2); text-align: left; padding: 7px 10px; font-size: 11px; text-transform: uppercase; border-bottom: 1px solid var(--bp-line); }
    tbody td { padding: 5px 10px; border-bottom: 1px solid var(--bp-line-2); white-space: nowrap; }
    .c-title { white-space: normal; min-width: 260px; }
    .c-time { width: 88px; } .c-dur { width: 84px; } .c-dc { width: 110px; } .c-cat { width: 110px; } .c-src { width: 140px; } .c-flags { width: 190px; }
    .mono { font-family: var(--bp-font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
    tr.live td { background: rgba(220,38,38,.07); }
    .chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 600; border: 1px solid transparent; margin-right: 4px; }
    .chip-live { background: rgba(220,38,38,.16); color: #fca5a5; border-color: rgba(220,38,38,.5); }
    :host-context(html[data-theme="light"]) .chip-live { color: #7f1d1d; }
    .chip-asrun { background: rgba(99,102,241,.14); color: var(--bp-acc-indigo); border-color: rgba(99,102,241,.4); }
    .chip-trim { background: rgba(245,158,11,.16); color: #fcd34d; border-color: rgba(245,158,11,.5); }
    :host-context(html[data-theme="light"]) .chip-trim { color: #92400e; }
    .chip-ok { background: rgba(16,185,129,.14); color: var(--bp-acc-green); border-color: rgba(16,185,129,.45); }
    .chip-warn { background: rgba(249,115,22,.16); color: #fdba74; border-color: rgba(249,115,22,.5); }
    :host-context(html[data-theme="light"]) .chip-warn { color: #9a3412; }
    .chip-p { background: rgba(124,58,237,.16); color: var(--bp-acc-purple); border-color: rgba(124,58,237,.45); }
    .chip mat-icon { font-size: 12px; height: 12px; width: 12px; vertical-align: -1px; }
  `],
})
export class AsrunMergeComponent implements OnInit {
  private readonly api = inject(ApiService);

  readonly channels = ASRUN_CHANNELS;
  readonly channel = signal<AsrunChannelSlug>('beinsports1');
  readonly date = signal<string>(istanbulYesterdayDate());
  readonly rows = signal<AsrunMergeItemDto[]>([]);
  readonly loading = signal<boolean>(false);
  readonly liveCount = computed(() => this.rows().filter((r) => r.origin === 'PROVYS_CANLI').length);

  async ngOnInit(): Promise<void> { await this.load(); }

  setChannel(slug: AsrunChannelSlug): void { this.channel.set(slug); void this.load(); }
  onDate(v: string): void { if (v) { this.date.set(v); void this.load(); } }
  shiftDate(days: number): void { this.date.set(addDaysIso(this.date(), days)); void this.load(); }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const rows = await firstValueFrom(
        this.api.get<AsrunMergeItemDto[]>('/asrun/merge', { channel: this.channel(), date: this.date() }),
      );
      this.rows.set(rows);
    } catch {
      this.rows.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  catStyle(cat: string) {
    return PROVYS_CATEGORY_STYLES[cat as keyof typeof PROVYS_CATEGORY_STYLES] ?? PROVYS_CATEGORY_STYLES.DIGER;
  }

  fmtTime(iso: string): string {
    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(iso));
  }

  fmtDur(ms: number): string {
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
}
