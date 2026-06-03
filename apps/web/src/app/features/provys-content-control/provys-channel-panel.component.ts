import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ProvysService } from './provys.service';
import {
  PROVYS_CATEGORY_STYLES,
  type ProvysCategory,
  type ProvysChannelSlug,
  type ProvysItemDto,
} from './provys.types';
import {
  MATERIAL_BADGE,
  buildMaterialTooltip,
  type MaterialBadgeStyle,
} from './provys-material-badge';

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
  imports: [CommonModule, FormsModule],
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
              <th class="col-cat">Kategori</th>
              <th class="col-dc">DC Kod</th>
              <th class="col-title">Başlık</th>
              <th class="col-mat">NEXIO</th>
              <th class="col-dur">Süre</th>
              <th class="col-note">Not</th>
            </tr>
          </thead>
          <tbody>
            @for (item of visibleItems(); track item.id; let i = $index) {
              <tr
                class="row"
                [class.row--reklam]="item.category === 'REKLAM'"
                [class.row--kamu]="item.category === 'KAMU_SPOTU'"
                [class.row--canli]="item.category === 'CANLI'"
                [class.row--program]="item.category === 'PROGRAM'"
                [class.row--tanitim]="item.category === 'TANITIM'"
                [class.row--diger]="item.category === 'DIGER'"
              >
                <!-- # kolonu DB sequence değil görünür satır index'idir;
                     multi-BXF günlerde sequence tekrarlanabildiği için gerçek
                     akış sırasını sadece template $index garantiler. -->
                <td class="col-seq">{{ i + 1 }}</td>
                <td class="col-time mono">{{ formatStart(item) }}</td>
                <td class="col-cat">
                  <span class="cat-chip" [class]="'cat-chip cat-chip--' + categoryClass(item.category)">
                    {{ styleFor(item.category).label }}
                  </span>
                </td>
                <td class="col-dc mono" [class.muted]="!item.dcCode">{{ item.dcCode ?? '—' }}</td>
                <!-- 2026-05-26: 2 seviyeli görünüm — series_name varsa üst
                     bağlam (program ailesi/turnuva) + title alt başlık. Tanıtım/
                     Kamu Spotu gibi NonProgramEvent kayıtlarında series_name
                     null → eski tek seviyeli görünüm bozulmaz. episode_number
                     varsa rozet olarak "B.<n>" gösterilir. -->
                <td class="col-title">
                  @if (item.seriesName) {
                    <div class="title-series">
                      {{ item.seriesName }}
                      @if (item.episodeNumber != null) {
                        <span class="title-episode" [title]="'Bölüm ' + item.episodeNumber">B.{{ item.episodeNumber }}</span>
                      }
                    </div>
                  }
                  <div class="title-text" [title]="item.title">{{ item.title }}</div>
                </td>
                <!-- NEXIO materyal status badge (SSDB cache). 2026-05-30: kolon
                     Başlık ile Süre arasına taşındı (kullanıcı tercihi). var=#00a6d6,
                     eksik=kırmızı, süre uymuyor=sarı. -->
                <td class="col-mat">
                  <span
                    class="mat-badge"
                    [class]="'mat-badge mat-badge--' + materialBadgeFor(item).tone"
                    [title]="materialTooltipFor(item)"
                  >{{ materialBadgeFor(item).compact }}</span>
                </td>
                <td class="col-dur mono">{{ formatDur(item) }}</td>
                <!-- 2026-05-27: Kullanıcı transient not alanı.
                     ngModel local; service.notesByEventId signal'ında tutulur.
                     Export request body'ye eventId bazlı eklenir. -->
                <td class="col-note">
                  <input
                    type="text"
                    class="note-input"
                    [ngModel]="service.getNote(item.eventId)"
                    (ngModelChange)="service.setNote(item.eventId, $event)"
                    [attr.aria-label]="'Not: ' + item.title"
                    maxlength="500"
                  />
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
  styles: [`
    /* 2026-05-28: Panel kendi içinde flex container; tablo gövdesi scroll
       context. Parent (mat-tab-body-content) flex-column ve panel'i fill
       eder. .panel { overflow: auto } sticky thead için scroll context
       sağlar; sayfa scroll'u büyütmez. */
    :host {
      display: flex; flex-direction: column;
      min-height: 0; flex: 1 1 auto;
      color: var(--bp-fg-1);
    }
    .panel {
      flex: 1 1 auto; min-height: 0;
      overflow: auto;
      background: var(--bp-bg-2);
    }
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
    /* SMPTE 'HH:MM:SS:FF' (11 char + ':' separator) tabular-nums + padding
       (10px+10px) için 112px güvenli alt sınır. nowrap + clip ile frame ':FF'
       hiçbir koşulda kesilmez (ellipsis explicit kapatıldı). */
    .col-time, .col-dur {
      width: 112px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: clip;
    }
    .col-time { color: var(--bp-fg-1); }
    .col-dur  { color: var(--bp-fg-2); }
    .col-cat { width: 130px; }
    .col-dc { width: 110px; color: var(--bp-fg-2); }
    /* 2026-05-27: Not kolonu (en sağda, kullanıcı transient input). */
    .col-note { width: 160px; }
    .note-input {
      width: 100%;
      box-sizing: border-box;
      padding: 2px 6px;
      background: rgba(255, 255, 255, 0.04);
      color: var(--bp-fg-1);
      border: 1px solid var(--bp-line-2, rgba(255, 255, 255, 0.14));
      border-radius: 4px;
      font: inherit;
      font-size: 11.5px;
      line-height: 1.3;
    }
    .note-input:focus {
      outline: none;
      border-color: rgba(124, 58, 237, 0.6);
      background: rgba(124, 58, 237, 0.08);
    }
    /* "Materyal" kolonu — dar + tek satır + ellipsis. Badge tek satır;
       kompakt etiketler (Canlı/Var/Eksik/...) sığsın. */
    .col-mat { width: 120px; }
    .mat-badge {
      display: inline-block;
      max-width: 100%;
      padding: 1px 7px;
      border-radius: var(--bp-r-pill, 999px);
      font-size: 10.5px;
      font-weight: var(--bp-fw-semibold, 600);
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border: 1px solid transparent;
    }
    /* Tone palet — dark default; light override aşağıda */
    .mat-badge--neutral { background: rgba(156, 163, 175, 0.16); color: #d1d5db; border-color: rgba(156, 163, 175, 0.35); }
    .mat-badge--muted   { background: rgba(107, 114, 128, 0.14); color: #9ca3af; border-color: rgba(107, 114, 128, 0.30); font-style: italic; }
    .mat-badge--warning { background: rgba(245, 158, 11, 0.18); color: #fcd34d; border-color: rgba(245, 158, 11, 0.45); }
    .mat-badge--success { background: rgba(16, 185, 129, 0.18); color: var(--bp-acc-green); border-color: rgba(16, 185, 129, 0.45); }
    .mat-badge--danger  { background: rgba(239, 68, 68, 0.22);  color: #fca5a5; border-color: rgba(239, 68, 68, 0.50); }
    /* 2026-05-30: "Var" → #00a6d6 cyan (yeşilden ayrı tutuldu; kullanıcı tercihi). */
    .mat-badge--found   { background: rgba(0, 166, 214, 0.18);  color: #5fd0ec; border-color: #00a6d6; }
    /* Başlık: leftover'i alır (table-layout: fixed → explicit width yok).
       DC Kod sabit, Başlık esnek; dar viewport'ta ellipsis devreye girer. */
    .col-title { white-space: normal; color: var(--bp-fg-1); }
    /* 2026-05-26: 2 seviyeli başlık görünümü. series_name varsa üst rozet,
       title alt satır. NonProgramEvent (Tanıtım/Kamu Spotu) için series_name
       null → sadece title render edilir. */
    .title-series {
      font-size: 10.5px;
      color: var(--bp-fg-3);
      letter-spacing: 0.04em;
      margin-bottom: 1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .title-episode {
      display: inline-block;
      margin-left: 6px;
      padding: 0 5px;
      border: 1px solid var(--bp-line);
      border-radius: 3px;
      font-size: 9.5px;
      color: var(--bp-fg-2);
      vertical-align: 1px;
      font-family: var(--bp-font-mono);
    }
    .title-text { color: var(--bp-fg-1); }
    .mono { font-family: var(--bp-font-mono, ui-monospace, 'JetBrains Mono', Menlo, monospace); font-variant-numeric: tabular-nums; }
    .muted { color: var(--bp-fg-3); }
    .cat-chip {
      display: inline-block; padding: 2px 8px; border-radius: var(--bp-r-pill, 999px);
      font-size: 11px; font-weight: var(--bp-fw-semibold, 600); line-height: 1.4;
      border: 1px solid transparent;
    }
    /* Kategori chip — dark uyumlu: translucent bg + soft border + parlak fg */
    /* 2026-05-27 (correction): REKLAM=yeşil, PROGRAM=sarı swap. */
    .cat-chip--reklam   { background: rgba(16, 185, 129, 0.18); color: var(--bp-acc-green); border-color: rgba(16, 185, 129, 0.40); }
    .cat-chip--kamu     { background: rgba(99, 102, 241, 0.18); color: var(--bp-acc-indigo); border-color: rgba(99, 102, 241, 0.40); }
    .cat-chip--canli    { background: rgba(239, 68, 68, 0.22);  color: #fca5a5; border-color: rgba(239, 68, 68, 0.45); }
    .cat-chip--program  { background: rgba(245, 158, 11, 0.18); color: #fcd34d; border-color: rgba(245, 158, 11, 0.40); }
    .cat-chip--tanitim  { background: rgba(168, 85, 247, 0.18); color: #d8b4fe; border-color: rgba(168, 85, 247, 0.40); }
    .cat-chip--diger    { background: rgba(156, 163, 175, 0.16); color: #d1d5db; border-color: rgba(156, 163, 175, 0.35); }

    /* ───── LIGHT MODE NETLİK GÜÇLENDİRMESİ ─────
       Sadece html[data-theme="light"] altında devreye giren override'lar:
       1) thead/td border'ları --bp-line ile patlıcan mor (default --bp-line-2
          %42 alfa tone'u açık zeminde silik kalıyor)
       2) chip fg/border kontrastı artırıldı — koyu metin + güçlü border + biraz
          daha dolgun fill (fw-700 ile birlikte WCAG AA okunabilir)
       Dark theme yolu (default kurallar yukarıda) etkilenmez. */
    :host-context(html[data-theme="light"]) thead th {
      border-bottom-color: var(--bp-line);
      background: var(--bp-bg-4);
      color: var(--bp-fg-1);
    }
    :host-context(html[data-theme="light"]) tbody td {
      border-bottom-color: rgba(76, 29, 149, 0.28);
    }
    :host-context(html[data-theme="light"]) .note-input {
      background: #ffffff;
      color: #1f2937;
      border-color: rgba(76, 29, 149, 0.30);
    }
    :host-context(html[data-theme="light"]) .note-input:focus {
      border-color: rgba(124, 58, 237, 0.7);
      background: rgba(124, 58, 237, 0.06);
    }
    :host-context(html[data-theme="light"]) .cat-chip {
      font-weight: 700;
    }
    :host-context(html[data-theme="light"]) .cat-chip--reklam {
      background: rgba(16, 185, 129, 0.20); color: #065f46; border-color: #059669;
    }
    :host-context(html[data-theme="light"]) .cat-chip--kamu {
      background: rgba(99, 102, 241, 0.20); color: #3730a3; border-color: #4f46e5;
    }
    :host-context(html[data-theme="light"]) .cat-chip--canli {
      background: rgba(239, 68, 68, 0.20); color: #991b1b; border-color: #dc2626;
    }
    :host-context(html[data-theme="light"]) .cat-chip--program {
      background: rgba(245, 158, 11, 0.22); color: #92400e; border-color: #d97706;
    }
    :host-context(html[data-theme="light"]) .cat-chip--tanitim {
      background: rgba(168, 85, 247, 0.20); color: #6b21a8; border-color: #9333ea;
    }
    :host-context(html[data-theme="light"]) .cat-chip--diger {
      background: rgba(75, 85, 99, 0.16); color: #1f2937; border-color: #4b5563;
    }
    /* Materyal badge — light mode kontrast güçlendirmesi (WCAG AA) */
    :host-context(html[data-theme="light"]) .mat-badge { font-weight: 700; }
    :host-context(html[data-theme="light"]) .mat-badge--neutral {
      background: rgba(75, 85, 99, 0.14); color: #1f2937; border-color: #4b5563;
    }
    :host-context(html[data-theme="light"]) .mat-badge--muted {
      background: rgba(107, 114, 128, 0.10); color: #374151; border-color: #6b7280;
    }
    :host-context(html[data-theme="light"]) .mat-badge--warning {
      background: rgba(245, 158, 11, 0.22); color: #92400e; border-color: #d97706;
    }
    :host-context(html[data-theme="light"]) .mat-badge--success {
      background: rgba(16, 185, 129, 0.20); color: #065f46; border-color: #059669;
    }
    :host-context(html[data-theme="light"]) .mat-badge--danger {
      background: rgba(239, 68, 68, 0.20); color: #991b1b; border-color: #dc2626;
    }
    :host-context(html[data-theme="light"]) .mat-badge--found {
      background: rgba(0, 166, 214, 0.16); color: #075985; border-color: #00a6d6;
    }
    .row { transition: background var(--bp-dur-fast, 100ms) linear; }
    .row:hover { background: var(--bp-bg-3); }
    /* Sol-bar accent — dark zeminde okunabilir kalsın; CANLI için ek soft tint */
    /* 2026-05-27 (correction): REKLAM=yeşil, PROGRAM=sarı swap (row accent). */
    .row--reklam  { box-shadow: inset 3px 0 0 #10b981; }
    .row--kamu    { box-shadow: inset 3px 0 0 #6366f1; }
    .row--canli   { box-shadow: inset 3px 0 0 #ef4444; background: rgba(239, 68, 68, 0.06); }
    .row--canli:hover { background: rgba(239, 68, 68, 0.12); }
    .row--program { box-shadow: inset 3px 0 0 #f59e0b; }
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

  /** Materyal status -> badge compact label + tone CSS class. */
  materialBadgeFor(item: ProvysItemDto): MaterialBadgeStyle {
    return MATERIAL_BADGE[item.ssdb.materialStatus];
  }

  /** Materyal status -> multi-line tooltip (`title` attribute). */
  materialTooltipFor(item: ProvysItemDto): string {
    return buildMaterialTooltip(item);
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
