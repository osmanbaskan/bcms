import { Component, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SevTagComponent } from './sev-tag.component';

export interface AlertItem {
  sev: 'critical' | 'warning' | 'info';
  msg: string;
  time: string;     // örn. "19:42"
  port?: string;    // teknik bağlam
  src?: string;     // kaynak component
  ack?: boolean;
}

/**
 * AlertPopover — header'da bell icon yanında açılan popover (placeholder).
 * Aşama 1'de mock veri; gerçek bağlantı (Prometheus/BCMS alert sistemi) Aşama 2/3.
 */
@Component({
  selector: 'bp-alert-popover',
  standalone: true,
  imports: [CommonModule, SevTagComponent],
  template: `
    @if (open()) {
      <div class="popover" (mouseleave)="close.emit()">
        <header class="head">
          <span>Aktif uyarılar</span>
          <a class="all-link" routerLink="/monitoring">Hepsi →</a>
        </header>
        @for (a of alerts().slice(0, 5); track a.msg) {
          <div class="row">
            <bp-sev-tag [severity]="a.sev"></bp-sev-tag>
            <div class="row-text">
              <div class="msg">{{ a.msg }}</div>
              <div class="meta">{{ a.time }}@if (a.port) { · {{ a.port }} }@if (a.src) { · {{ a.src }} }</div>
            </div>
          </div>
        } @empty {
          <div class="empty">Aktif uyarı yok.</div>
        }
      </div>
    }
  `,
  styles: [`
    .popover {
      position: absolute;
      right: 120px;
      top: 54px;
      width: 380px;
      background: var(--bp-bg-2);
      border: 1px solid var(--bp-line-2);
      border-radius: var(--bp-r-lg);
      box-shadow: var(--bp-shadow-lg);
      overflow: hidden;
      z-index: var(--bp-z-dropdown);
    }
    .head {
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--bp-line-2);
      font-size: var(--bp-text-sm);
      font-weight: var(--bp-fw-semibold);
      color: var(--bp-fg-1);
    }
    .all-link {
      font-size: var(--bp-text-xs);
      color: var(--bp-purple-300);
      text-decoration: none;
    }
    .row {
      padding: 10px 16px;
      display: flex;
      gap: 10px;
      align-items: flex-start;
      border-bottom: 1px solid var(--bp-line-2);
    }
    .row:last-child { border-bottom: 0; }
    .row-text { flex: 1; }
    .msg { font-size: 12.5px; color: var(--bp-fg-1); }
    .meta {
      font-size: var(--bp-text-xs);
      color: var(--bp-fg-3);
      font-family: var(--bp-font-mono);
      margin-top: 2px;
    }
    .empty {
      padding: 20px 16px;
      text-align: center;
      color: var(--bp-fg-3);
      font-size: var(--bp-text-sm);
    }
  `],
})
export class AlertPopoverComponent {
  open = input<boolean>(false);
  alerts = input<AlertItem[]>([]);
  close = output<void>();
}
