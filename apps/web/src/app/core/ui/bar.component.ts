import { Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Bar — küçük progress bar (gradient mor).
 */
@Component({
  selector: 'bp-bar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="track">
      <div class="fill" [style.width.%]="percent()"></div>
    </div>
  `,
  styles: [`
    .track {
      height: 4px;
      background: var(--bp-bg-0);
      border-radius: 2px;
      overflow: hidden;
    }
    .fill {
      height: 100%;
      background: linear-gradient(90deg, var(--bp-purple-400), var(--bp-purple-600));
      transition: width var(--bp-dur-slow) var(--bp-ease);
    }
  `],
})
export class BarComponent {
  value = input<number>(0);
  max = input<number>(100);
  percent = computed(() => Math.min(100, Math.max(0, (this.value() / this.max()) * 100)));
}
