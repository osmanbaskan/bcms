import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProvysService } from './provys.service';
import {
  PROVYS_CATEGORY_STYLES,
  type ProvysCategory,
  type ProvysChannelSlug,
  type ProvysItemDto,
} from './provys.types';

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
        <div class="state empty">Bu kanal için akış kaydı yok.</div>
      } @else {
        <table class="provys-list" role="grid" aria-label="Provys akış listesi">
          <thead>
            <tr>
              <th class="col-seq">#</th>
              <th class="col-time">Başlangıç</th>
              <th class="col-dur">Süre</th>
              <th class="col-cat">Kategori</th>
              <th class="col-title">Başlık</th>
              <th class="col-kind">Tür</th>
            </tr>
          </thead>
          <tbody>
            @for (item of items(); track item.id) {
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
                <td class="col-time mono">{{ formatTime(item.startAt) }}</td>
                <td class="col-dur mono">{{ formatDuration(item.durationMs) }}</td>
                <td class="col-cat">
                  <span class="cat-chip" [style.background]="styleFor(item.category).background" [style.color]="styleFor(item.category).text">
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
    :host { display: block; }
    .panel { background: #ffffff; }
    .state { padding: 32px; text-align: center; color: #6b7280; font-size: 13px; }
    .state.empty { color: #9ca3af; }
    table.provys-list {
      width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12.5px;
    }
    thead th {
      position: sticky; top: 0; z-index: 1;
      background: #f9fafb; color: #374151; font-weight: 600;
      text-align: left; padding: 6px 10px; border-bottom: 1px solid #e5e7eb;
      font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.03em;
    }
    tbody td {
      padding: 4px 10px; border-bottom: 1px solid #f3f4f6; line-height: 1.35;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .col-seq { width: 48px; color: #9ca3af; }
    .col-time { width: 110px; }
    .col-dur { width: 80px; color: #6b7280; }
    .col-cat { width: 130px; }
    .col-title { white-space: normal; }
    .col-kind { width: 130px; }
    .mono { font-family: ui-monospace, 'JetBrains Mono', 'Fira Code', Menlo, monospace; }
    .muted { color: #9ca3af; }
    .cat-chip {
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-size: 11px; font-weight: 600; line-height: 1.4;
    }
    .row { transition: background 80ms linear; }
    .row:hover { background: #f9fafb; }
    /* Sol-bar tint — kategori renkleri tek kaynaktan gelir (PROVYS_CATEGORY_STYLES) */
    .row--reklam  { box-shadow: inset 3px 0 0 #f59e0b; }
    .row--kamu    { box-shadow: inset 3px 0 0 #6366f1; }
    .row--canli   { box-shadow: inset 3px 0 0 #dc2626; background: #fff7f7; }
    .row--program { box-shadow: inset 3px 0 0 #10b981; }
    .row--tanitim { box-shadow: inset 3px 0 0 #a855f7; }
    .row--diger   { box-shadow: inset 3px 0 0 #9ca3af; }
  `],
})
export class ProvysChannelPanelComponent {
  readonly channel = input.required<ProvysChannelSlug>();
  readonly service = inject(ProvysService);

  readonly items = computed<ProvysItemDto[]>(() => this.service.itemsFor(this.channel())());

  styleFor(category: ProvysCategory) {
    return PROVYS_CATEGORY_STYLES[category];
  }

  formatTime(iso: string): string {
    if (!iso) return '';
    // Europe/Istanbul timezone lock (CLAUDE.md). Native Intl ile explicit TZ.
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: 'Europe/Istanbul',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date);
  }

  formatDuration(ms: number | null): string {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const sec = Math.round(ms / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
}
