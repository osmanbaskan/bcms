import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * KPI panel — büyük sayı + label + opsiyonel sub.
 * `accent` true → mor gradient ile vurgulu.
 */
@Component({
  selector: 'bp-kpi',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="kpi" [class.accent]="accent()">
      <div class="label">{{ label() }}</div>
      <div class="value">
        {{ value() }}@if (unit()) { <span class="unit">{{ unit() }}</span> }
      </div>
      @if (sub()) { <div class="sub">{{ sub() }}</div> }
    </div>
  `,
  styles: [`
    .kpi {
      background: var(--bp-bg-2);
      border: 1px solid var(--bp-line-2);
      border-radius: var(--bp-r-lg);
      padding: 14px 16px;
    }
    .kpi.accent {
      border-color: rgba(167, 139, 250, 0.40);
      background: linear-gradient(180deg, rgba(124, 58, 237, 0.18), var(--bp-bg-2));
    }
    .label {
      font-size: var(--bp-text-xs);
      color: var(--bp-fg-3);
      text-transform: uppercase;
      letter-spacing: var(--bp-ls-label);
      font-weight: var(--bp-fw-semibold);
    }
    .value {
      font-family: var(--bp-font-display);
      font-size: 26px;
      font-weight: var(--bp-fw-semibold);
      margin-top: 6px;
      letter-spacing: var(--bp-ls-tight);
      color: var(--bp-fg-1);
    }
    .unit {
      font-size: var(--bp-text-md);
      color: var(--bp-fg-3);
      font-weight: var(--bp-fw-regular);
    }
    .sub {
      font-size: var(--bp-text-xs);
      color: var(--bp-fg-3);
      margin-top: 2px;
    }
  `],
})
export class KpiComponent {
  label = input.required<string>();
  value = input.required<string | number>();
  unit = input<string>();
  sub = input<string>();
  accent = input<boolean>(false);
}
