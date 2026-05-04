import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Card — başlıklı kart container.
 * Title + count + opsiyonel action slot + body slot.
 */
@Component({
  selector: 'bp-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (title() || hasAction()) {
      <header class="head">
        <div class="head-left">
          @if (title()) { <h3 class="title">{{ title() }}</h3> }
          @if (count() != null) { <span class="count">{{ count() }}</span> }
        </div>
        <div class="head-right"><ng-content select="[card-action]"></ng-content></div>
      </header>
    }
    <div class="body" [class.padded]="padded()">
      <ng-content></ng-content>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      background: var(--bp-bg-2);
      border-radius: var(--bp-r-xl);
      border: 1px solid var(--bp-line-2);
      overflow: hidden;
    }
    .head {
      padding: 14px 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--bp-line-2);
    }
    .head-left { display: flex; align-items: baseline; gap: 10px; }
    .title { margin: 0; font-size: var(--bp-text-md); font-weight: var(--bp-fw-semibold); color: var(--bp-fg-1); }
    .count { font-size: var(--bp-text-xs); color: var(--bp-fg-3); }
    .body.padded { padding: 18px; }
  `],
})
export class CardComponent {
  title = input<string>();
  count = input<string | number | null>();
  padded = input<boolean>(false);
  // ng-content slots — Angular doesn't have a clean "has slot content" API;
  // assume action is always rendered if slot used.
  hasAction = () => true;
}
