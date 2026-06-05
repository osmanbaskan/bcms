import { ChangeDetectionStrategy, Component, Input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import type { NewsBulletin } from '@bcms/shared';
import { minuteToHHMM } from './news.service';

/**
 * Prompter görünümü (EGS "Haber Akışı ve Prompter"). Bültenin haberlerini
 * sırayla, büyük punto + koyu zemin + kaydırmalı gösterir. Punto ayarı + mirror.
 */
@Component({
  selector: 'bp-prompter',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, MatIconModule],
  template: `
    <div class="pr">
      <div class="pr-bar">
        <span class="pb-title">{{ bulletin?.name || 'Prompter' }} @if (bulletin) { · {{ min(bulletin.onAirMinute) }} }</span>
        <span class="pb-tools">
          <button type="button" (click)="dec()" title="Küçült"><mat-icon class="material-icons-outlined">text_decrease</mat-icon></button>
          <span class="pb-size">{{ size() }}px</span>
          <button type="button" (click)="inc()" title="Büyüt"><mat-icon class="material-icons-outlined">text_increase</mat-icon></button>
          <button type="button" [class.on]="mirror()" (click)="mirror.set(!mirror())" title="Ayna"><mat-icon class="material-icons-outlined">flip</mat-icon></button>
        </span>
      </div>
      <div class="pr-scroll" [class.mirror]="mirror()" [style.fontSize.px]="size()">
        @for (s of bulletin?.stories ?? []; track s.id; let i = $index) {
          <article class="pr-story">
            <div class="ps-head">{{ i + 1 }}. {{ s.title }} @if (s.anchorName) { <span class="ps-anchor">— {{ s.anchorName }}</span> }</div>
            <div class="ps-body">{{ s.prompterText || s.description || '(metin yok)' }}</div>
            @if (s.lowerThirds.length) {
              <div class="ps-kj">
                @for (lt of s.lowerThirds; track lt.id) {
                  <span class="kj">{{ lt.kind }}: {{ lt.title }}@if (lt.line1) { · {{ lt.line1 }} }</span>
                }
              </div>
            }
          </article>
        } @empty {
          <div class="empty">Prompter için haber yok.</div>
        }
      </div>
    </div>
  `,
  styles: [`
    .pr { display: flex; flex-direction: column; height: 100%; min-height: 0; background: #05070a; }
    .pr-bar { display: flex; justify-content: space-between; align-items: center; padding: 8px 14px; background: #0b0e13; border-bottom: 1px solid #1b2230; }
    .pb-title { color: #cbd5e1; font-size: 13px; }
    .pb-tools { display: inline-flex; align-items: center; gap: 6px; }
    .pb-tools button { background: #131820; border: 1px solid #232c3a; color: #cbd5e1; border-radius: 6px; padding: 4px 6px; cursor: pointer; display: inline-flex; }
    .pb-tools button.on { border-color: var(--bp-purple-500); color: #fff; }
    .pb-tools mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .pb-size { color: #94a3b8; font-size: 12px; min-width: 40px; text-align: center; }
    .pr-scroll { flex: 1 1 auto; overflow: auto; min-height: 0; padding: 40px 8vw 60vh; line-height: 1.6; color: #f8fafc; }
    .pr-scroll.mirror { transform: scaleX(-1); }
    .pr-story { margin-bottom: 1.4em; }
    .ps-head { color: #fbbf24; font-weight: 700; margin-bottom: 0.3em; }
    .ps-anchor { color: #94a3b8; font-weight: 400; }
    .ps-body { white-space: pre-wrap; }
    .ps-kj { margin-top: 0.4em; display: flex; flex-wrap: wrap; gap: 8px; }
    .ps-kj .kj { font-size: 0.5em; background: rgba(124,58,237,0.25); border: 1px solid var(--bp-purple-500); color: #e9d5ff; padding: 2px 8px; border-radius: 5px; }
    .empty { color: #64748b; padding: 40px; text-align: center; }
  `],
})
export class PrompterComponent {
  @Input() bulletin: NewsBulletin | null = null;
  readonly size = signal(34);
  readonly mirror = signal(false);
  inc(): void { this.size.update((v) => Math.min(80, v + 4)); }
  dec(): void { this.size.update((v) => Math.max(18, v - 4)); }
  min(m: number): string { return minuteToHHMM(m); }
}
