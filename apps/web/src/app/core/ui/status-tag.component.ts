import { Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * StatusTag — yayın state badge (live, onair, queued, done, draft)
 * beINport StatusTag pattern: küçük renkli dot + uppercase letter-spacing label.
 */

interface StatusDef {
  label: string;
  bg: string;
  fg: string;
  dot: boolean;
}

const STATUS_MAP: Record<string, StatusDef> = {
  live:    { label: 'CANLI',     bg: 'rgba(239,68,68,0.18)',  fg: '#fca5a5', dot: true },
  onair:   { label: 'YAYINDA',   bg: 'rgba(239,68,68,0.18)',  fg: '#fca5a5', dot: true },
  queued:  { label: 'BEKLEMEDE', bg: 'rgba(245,158,11,0.16)', fg: '#fbbf24', dot: false },
  done:    { label: 'TAMAM',     bg: 'rgba(16,185,129,0.16)', fg: '#6ee7b7', dot: false },
  draft:   { label: 'TASLAK',    bg: 'rgba(107,114,128,0.20)',fg: '#9ca3af', dot: false },
  // BCMS legacy enum aliases (ON_AIR hard-deleted 2026-05-11)
  COMPLETED: { label: 'TAMAM',     bg: 'rgba(16,185,129,0.16)', fg: '#6ee7b7', dot: false },
  DRAFT:     { label: 'TASLAK',    bg: 'rgba(107,114,128,0.20)',fg: '#9ca3af', dot: false },
  CONFIRMED: { label: 'ONAYLI',    bg: 'rgba(59,130,246,0.16)', fg: '#93c5fd', dot: false },
  CANCELLED: { label: 'İPTAL',     bg: 'rgba(75,85,99,0.30)',   fg: '#9ca3af', dot: false },
  PENDING:   { label: 'BEKLEMEDE', bg: 'rgba(245,158,11,0.16)', fg: '#fbbf24', dot: false },
  APPROVED:  { label: 'ONAYLI',    bg: 'rgba(34,197,94,0.16)',  fg: '#86efac', dot: false },
  REJECTED:  { label: 'RED',       bg: 'rgba(239,68,68,0.18)',  fg: '#fca5a5', dot: false },
};

@Component({
  selector: 'bp-status-tag',
  standalone: true,
  imports: [CommonModule],
  template: `
    <span class="tag" [style.background]="def().bg" [style.color]="def().fg">
      @if (def().dot) {
        <span class="dot" [style.background]="def().fg" [style.box-shadow]="'0 0 6px ' + def().fg"></span>
      }
      {{ def().label }}
    </span>
  `,
  styles: [`
    .tag {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: 10px;
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-family: var(--bp-font-sans);
      white-space: nowrap;
    }
    .dot {
      width: 5px;
      height: 5px;
      border-radius: 3px;
    }
  `],
})
export class StatusTagComponent {
  state = input<string>('draft');
  def = computed<StatusDef>(() => STATUS_MAP[this.state()] ?? STATUS_MAP['draft']);
}
