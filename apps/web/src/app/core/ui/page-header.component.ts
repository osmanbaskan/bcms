import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';

export interface PageTab {
  id: string;
  label: string;
  href?: string;        // routerLink
}

/**
 * PageHeader — eyebrow + h1 + opsiyonel sub-tabs.
 * Shell.jsx pageHead pattern'inden.
 */
@Component({
  selector: 'bp-page-header',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="page-head">
      <div class="page-head-text">
        @if (eyebrow()) { <div class="eyebrow">{{ eyebrow() }}</div> }
        <h1 class="title">{{ title() }}</h1>
      </div>
      @if (tabs()?.length) {
        <div class="tabs">
          @for (t of tabs(); track t.id) {
            <a class="tab" [class.active]="t.id === activeTab()"
               [routerLink]="t.href ?? null">
              {{ t.label }}
            </a>
          }
        </div>
      }
      <ng-content select="[page-actions]"></ng-content>
    </div>
  `,
  styles: [`
    .page-head {
      padding: 24px 32px 16px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 16px;
      flex-wrap: wrap;
    }
    .eyebrow {
      font-size: var(--bp-text-xs);
      letter-spacing: var(--bp-ls-eyebrow);
      color: var(--bp-fg-3);
      font-weight: var(--bp-fw-semibold);
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .title {
      margin: 0;
      font-size: var(--bp-text-3xl);
      font-weight: var(--bp-fw-semibold);
      font-family: var(--bp-font-display);
      letter-spacing: var(--bp-ls-tight);
      color: var(--bp-fg-1);
    }
    .tabs {
      display: flex;
      gap: 0;
      background: var(--bp-bg-0);
      border-radius: var(--bp-r-md);
      padding: 4px;
      border: 1px solid var(--bp-line-2);
    }
    .tab {
      padding: 7px 14px;
      font-size: var(--bp-text-sm);
      color: var(--bp-fg-3);
      cursor: pointer;
      border-radius: var(--bp-r-sm);
      text-decoration: none;
      transition: color var(--bp-dur-fast) var(--bp-ease);
    }
    .tab:hover { color: var(--bp-fg-1); }
    .tab.active {
      background: var(--bp-purple-500);
      color: #fff;
      font-weight: var(--bp-fw-medium);
    }
  `],
})
export class PageHeaderComponent {
  title = input.required<string>();
  eyebrow = input<string>();
  tabs = input<PageTab[]>();
  activeTab = input<string>();
}
