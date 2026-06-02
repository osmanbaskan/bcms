import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Card — başlıklı kart container.
 * Title + count + opsiyonel action slot + body slot.
 *
 * 2026-05-31: `expandable` ile sağ üst köşeye çapraz-ok (büyüt) butonu eklenir;
 * tıklanınca `expandClick` emit edilir. Büyütme görünümü (`.is-expanded`
 * host class'ı) parent tarafından yönetilir (dashboard overlay).
 */
@Component({
  selector: 'bp-card',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.accent]': 'accent()' },
  template: `
    @if (title() || hasAction() || expandable()) {
      <header class="head">
        <div class="head-left">
          @if (title()) { <h3 class="title">{{ title() }}</h3> }
          @if (count() != null) { <span class="count">{{ count() }}</span> }
        </div>
        <div class="head-right">
          <ng-content select="[card-action]"></ng-content>
          @if (expandable()) {
            <button type="button"
                    class="card-expand"
                    (click)="expandClick.emit()"
                    [attr.aria-label]="(title() ?? 'Kart') + ' kutusunu büyüt'"
                    [title]="expanded() ? 'Kapat' : 'Büyüt'">
              @if (expanded()) {
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path fill="currentColor" d="M22 3.41 16.71 8.7 19 11h-7V4l2.29 2.29L19.59 1 22 3.41zM2 20.59 7.29 15.3 5 13h7v7l-2.29-2.29L4.41 23 2 20.59z"/>
                </svg>
              } @else {
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path fill="currentColor" d="M10 21H3v-7h2v3.59l4.29-4.3 1.42 1.42L6.41 19H10v2zm11-11h-2V6.41l-4.29 4.3-1.42-1.42L17.59 5H14V3h7v7z"/>
                </svg>
              }
            </button>
          }
        </div>
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
    /* KPI accent ile aynı mor gradient; uzun kartta tüm yüzeyi mora boyamamak
       için geçiş ~160px'de bg-2'ye iner (üstte mor parıltı, altı düz). */
    :host(.accent) {
      border-color: rgba(167, 139, 250, 0.40);
      background: linear-gradient(180deg, rgba(124, 58, 237, 0.18) 0%, var(--bp-bg-2) 160px);
    }
    /* Büyütülmüş hâli — parent .is-expanded host class verir; ekrana ortalanır. */
    :host(.is-expanded) {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: min(880px, 92vw);
      max-height: 86vh;
      overflow: auto;
      z-index: 1001;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
      border-color: var(--bp-purple-400, #a78bfa);
      animation: bp-card-pop 140ms ease-out;
    }
    @keyframes bp-card-pop { from { transform: translate(-50%, -50%) scale(0.96); opacity: 0; } to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }
    .head {
      padding: 14px 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--bp-line-2);
    }
    .head-left { display: flex; align-items: baseline; gap: 10px; }
    .head-right { display: inline-flex; align-items: center; gap: 8px; }
    .title { margin: 0; font-size: var(--bp-text-md); font-weight: var(--bp-fw-semibold); color: var(--bp-fg-1); }
    .count { font-size: var(--bp-text-xs); color: var(--bp-fg-3); }
    .body.padded { padding: 18px; }
    .card-expand {
      width: 24px; height: 24px;
      display: grid; place-items: center;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--bp-line-2);
      border-radius: 5px;
      color: var(--bp-fg-3);
      cursor: pointer;
      padding: 0;
      transition: background var(--bp-dur-fast), color var(--bp-dur-fast);
    }
    .card-expand:hover { background: rgba(124, 58, 237, 0.20); color: var(--bp-fg-1); }
  `],
})
export class CardComponent {
  title = input<string>();
  count = input<string | number | null>();
  padded = input<boolean>(false);
  /** Mor gradient vurgu arka planı (KPI accent ile aynı görsel dil). */
  accent = input<boolean>(false);
  /** Sağ üstte büyüt (çapraz-ok) butonu göster. */
  expandable = input<boolean>(false);
  /** Şu an büyütülmüş mü (ikon yönü için). */
  expanded = input<boolean>(false);
  /** Büyüt/kapat butonuna tıklandı. */
  expandClick = output<void>();
  // ng-content slots — Angular doesn't have a clean "has slot content" API;
  // assume action is always rendered if slot used.
  hasAction = () => true;
}
