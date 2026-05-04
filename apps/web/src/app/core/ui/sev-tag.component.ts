import { Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * SevTag — alarm severity badge (critical, warning, info)
 */

interface SevDef { label: string; bg: string; fg: string; }

const SEV_MAP: Record<string, SevDef> = {
  critical: { label: 'KRİTİK',  bg: 'rgba(239,68,68,0.18)',  fg: '#fca5a5' },
  warning:  { label: 'UYARI',   bg: 'rgba(245,158,11,0.16)', fg: '#fbbf24' },
  info:     { label: 'BİLGİ',   bg: 'rgba(59,130,246,0.16)', fg: '#93c5fd' },
};

@Component({
  selector: 'bp-sev-tag',
  standalone: true,
  imports: [CommonModule],
  template: `
    <span class="tag" [style.background]="def().bg" [style.color]="def().fg">{{ def().label }}</span>
  `,
  styles: [`
    .tag {
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.06em;
      padding: 3px 7px;
      border-radius: 4px;
      display: inline-block;
      font-family: var(--bp-font-sans);
      white-space: nowrap;
    }
  `],
})
export class SevTagComponent {
  severity = input<string>('info');
  def = computed<SevDef>(() => SEV_MAP[this.severity()] ?? SEV_MAP['info']);
}
