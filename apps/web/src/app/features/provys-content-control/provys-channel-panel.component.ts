import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProvysService } from './provys.service';
import {
  PROVYS_CATEGORY_STYLES,
  type ProvysCategory,
  type ProvysChannelSlug,
  type ProvysItemDto,
} from './provys.types';

/** Kategori → CSS class fragment (template'te `cat-chip--<frag>` / `row--<frag>`). */
const CATEGORY_CLASS: Record<ProvysCategory, string> = {
  REKLAM: 'reklam',
  KAMU_SPOTU: 'kamu',
  CANLI: 'canli',
  PROGRAM: 'program',
  TANITIM: 'tanitim',
  DIGER: 'diger',
};

@Component({
  selector: 'app-provys-channel-panel',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel">
      @if (!service.hasReceived(channel())) {
        <div class="state">Yükleniyor…</div>
      } @else if (items().length === 0) {
        <div class="state empty">Seçili tarih için BXF akışı yok</div>
      } @else if (visibleItems().length === 0) {
        <div class="state empty">Seçili kategori filtreleriyle gösterilecek kayıt yok</div>
      } @else {
        <table class="provys-list" role="grid" aria-label="Provys akış listesi">
          <thead>
            <tr>
              <th class="col-seq">#</th>
              <th class="col-time">Başlangıç</th>
              <th class="col-dur">Süre</th>
              <th class="col-dc">DC Kod</th>
              <th class="col-cat">Kategori</th>
              <th class="col-title">Başlık</th>
              <th class="col-kind">Tür</th>
            </tr>
          </thead>
          <tbody>
            @for (item of visibleItems(); track item.id) {
              <tr
                class="row"
                [class.row--reklam]="item.category === 'REKLAM'"
                [class.row--kamu]="item.category === 'KAMU_SPOTU'"
                [class.row--canli]="item.category === 'CANLI'"
                [class.row--program]="item.category === 'PROGRAM'"
                [class.row--tanitim]="item.category === 'TANITIM'"
                [class.row--diger]="item.category === 'DIGER'"
              >
                <td class="col-seq">{{ item.sequence + 1 }}</td>
                <td class="col-time mono">{{ formatStart(item) }}</td>
                <td class="col-dur mono">{{ formatDur(item) }}</td>
                <td class="col-dc mono" [class.muted]="!item.dcCode">{{ item.dcCode ?? '—' }}</td>
                <td class="col-cat">
                  <span class="cat-chip" [class]="'cat-chip cat-chip--' + categoryClass(item.category)">
                    {{ styleFor(item.category).label }}
                  </span>
                </td>
                <td class="col-title">{{ item.title }}</td>
                <td class="col-kind mono muted">{{ item.rawKind ?? '—' }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
  styles: [`
    :host { display: block; color: var(--bp-fg-1); }
    .panel { background: var(--bp-bg-2); }
    .state {
      padding: 32px; text-align: center;
      color: var(--bp-fg-3); font-size: 13px;
    }
    .state.empty { color: var(--bp-fg-4); }
    table.provys-list {
      width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12.5px;
      color: var(--bp-fg-1);
    }
    thead th {
      position: sticky; top: 0; z-index: 1;
      background: var(--bp-bg-3); color: var(--bp-fg-2); font-weight: 600;
      text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--bp-line);
      font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.03em;
    }
    tbody td {
      padding: 4px 10px; border-bottom: 1px solid var(--bp-line-2); line-height: 1.35;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      color: var(--bp-fg-1);
    }
    .col-seq { width: 48px; color: var(--bp-fg-4); }
    .col-time { width: 110px; color: var(--bp-fg-1); }
    .col-dur { width: 100px; color: var(--bp-fg-2); }
    .col-dc { width: 110px; color: var(--bp-fg-2); }
    .col-cat { width: 130px; }
    .col-title { white-space: normal; color: var(--bp-fg-1); }
    .col-kind { width: 130px; }
    .mono { font-family: var(--bp-font-mono, ui-monospace, 'JetBrains Mono', Menlo, monospace); font-variant-numeric: tabular-nums; }
    .muted { color: var(--bp-fg-3); }
    .cat-chip {
      display: inline-block; padding: 2px 8px; border-radius: var(--bp-r-pill, 999px);
      font-size: 11px; font-weight: var(--bp-fw-semibold, 600); line-height: 1.4;
      border: 1px solid transparent;
    }
    /* Kategori chip — dark uyumlu: translucent bg + soft border + parlak fg */
    .cat-chip--reklam   { background: rgba(245, 158, 11, 0.18); color: #fcd34d; border-color: rgba(245, 158, 11, 0.40); }
    .cat-chip--kamu     { background: rgba(99, 102, 241, 0.18); color: #a5b4fc; border-color: rgba(99, 102, 241, 0.40); }
    .cat-chip--canli    { background: rgba(239, 68, 68, 0.22);  color: #fca5a5; border-color: rgba(239, 68, 68, 0.45); }
    .cat-chip--program  { background: rgba(16, 185, 129, 0.18); color: #6ee7b7; border-color: rgba(16, 185, 129, 0.40); }
    .cat-chip--tanitim  { background: rgba(168, 85, 247, 0.18); color: #d8b4fe; border-color: rgba(168, 85, 247, 0.40); }
    .cat-chip--diger    { background: rgba(156, 163, 175, 0.16); color: #d1d5db; border-color: rgba(156, 163, 175, 0.35); }
    .row { transition: background var(--bp-dur-fast, 100ms) linear; }
    .row:hover { background: var(--bp-bg-3); }
    /* Sol-bar accent — dark zeminde okunabilir kalsın; CANLI için ek soft tint */
    .row--reklam  { box-shadow: inset 3px 0 0 #f59e0b; }
    .row--kamu    { box-shadow: inset 3px 0 0 #6366f1; }
    .row--canli   { box-shadow: inset 3px 0 0 #ef4444; background: rgba(239, 68, 68, 0.06); }
    .row--canli:hover { background: rgba(239, 68, 68, 0.12); }
    .row--program { box-shadow: inset 3px 0 0 #10b981; }
    .row--tanitim { box-shadow: inset 3px 0 0 #a855f7; }
    .row--diger   { box-shadow: inset 3px 0 0 #6b7280; }
  `],
})
export class ProvysChannelPanelComponent {
  readonly channel = input.required<ProvysChannelSlug>();
  readonly service = inject(ProvysService);

  readonly items = computed<ProvysItemDto[]>(() => this.service.itemsFor(this.channel())());
  /** Aktif kategori filtresi uygulanmış görünür satırlar. */
  readonly visibleItems = computed<ProvysItemDto[]>(() => this.service.filteredItemsFor(this.channel())());

  styleFor(category: ProvysCategory) {
    return PROVYS_CATEGORY_STYLES[category];
  }

  /** Kategori → CSS class fragment (chip + row için ortak). */
  categoryClass(category: ProvysCategory): string {
    return CATEGORY_CLASS[category];
  }

  /**
   * Başlangıç gösterimi — primer: SMPTE timecode `HH:MM:SS:FF` (frame korunur).
   * Eski kayıtta `startTimecode` null ise Istanbul wall-clock `HH:MM:SS`
   * fallback'i (frame yok).
   */
  formatStart(item: ProvysItemDto): string {
    if (item.startTimecode) return item.startTimecode;
    if (!item.startAt) return '';
    const date = new Date(item.startAt);
    if (Number.isNaN(date.getTime())) return item.startAt;
    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: 'Europe/Istanbul',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date);
  }

  /**
   * Süre gösterimi — primer: SMPTE duration `HH:MM:SS:FF`. Eski kayıtta
   * `durationTimecode` null ise `durationMs` üstünden ms→HH:MM:SS hesaplanır
   * (frame yok). `durationMs` da yoksa `—`.
   */
  formatDur(item: ProvysItemDto): string {
    if (item.durationTimecode) return item.durationTimecode;
    const ms = item.durationMs;
    if (ms == null || !Number.isFinite(ms)) return '—';
    const sec = Math.round(ms / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
}
