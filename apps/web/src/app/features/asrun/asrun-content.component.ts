import { ChangeDetectionStrategy, Component, OnInit, OnDestroy, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { AsrunService } from './asrun.service';
import { AsrunChannelPanelComponent } from './asrun-channel-panel.component';
import { ASRUN_CHANNELS, type AsrunChannelSlug } from './asrun.types';

/**
 * Asrun İçerik Kaydı sayfası — playout sonrası gerçekleşen yayın listesi.
 * Provys "İçerik Kontrol" ile aynı 6 kanal tab yapısı; ayrı service +
 * panel component. V1: read-only tablo; filtre/export/SSE follow-up.
 */
@Component({
  selector: 'app-asrun-content',
  standalone: true,
  imports: [CommonModule, MatTabsModule, MatIconModule, MatButtonModule, AsrunChannelPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="top">
        <div class="title-block">
          <h1 class="page-title">Asrun (As-Run Kaydı)</h1>
          <p class="subtitle">Playout sonrası gerçekleşen yayın kaydı — Outbox/Ok BXF kaynağı.</p>
        </div>
        <div class="controls">
          <label class="date-control">
            <span class="date-label">Yayın günü</span>
            <input
              type="date"
              [value]="service.activeDate()"
              (change)="onDateChange($any($event.target).value)"
            />
          </label>
          <button mat-stroked-button (click)="reload()">
            <mat-icon>refresh</mat-icon>
            <span>Yenile</span>
          </button>
        </div>
      </header>
      <mat-tab-group
        class="asrun-tabs"
        [selectedIndex]="selectedIndex()"
        (selectedIndexChange)="selectedIndex.set($event)"
      >
        @for (ch of channels; track ch.slug) {
          <mat-tab [label]="ch.displayName">
            <app-asrun-channel-panel [channel]="$any(ch.slug)" />
          </mat-tab>
        }
      </mat-tab-group>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .page { padding: 16px; }
    .top {
      display: flex; align-items: flex-end; justify-content: space-between;
      gap: 16px; margin-bottom: 16px;
    }
    .title-block .page-title { font-size: 22px; font-weight: 600; color: var(--bp-fg-1); }
    .title-block .subtitle { font-size: 12.5px; color: var(--bp-fg-3); margin-top: 2px; }
    .controls { display: flex; align-items: center; gap: 12px; }
    .date-control { display: inline-flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--bp-fg-3); }
    .date-control input {
      padding: 6px 10px; border: 1px solid var(--bp-line); border-radius: 4px;
      background: var(--bp-bg-2); color: var(--bp-fg-1); font-size: 13px;
    }
    .asrun-tabs { background: var(--bp-bg-2); }
    ::ng-deep .asrun-tabs .mat-mdc-tab-header {
      border-bottom: 1px solid var(--bp-line);
      background: var(--bp-bg-2);
    }
    ::ng-deep .asrun-tabs .mat-mdc-tab .mdc-tab__text-label {
      font-size: 12.5px; font-weight: var(--bp-fw-medium, 500);
    }
    ::ng-deep .asrun-tabs .mdc-tab--active .mdc-tab__text-label,
    ::ng-deep .asrun-tabs .mat-mdc-tab[aria-selected="true"] .mdc-tab__text-label {
      font-size: 15.5px; font-weight: 700;
    }
    :host-context(html[data-theme="light"]) ::ng-deep
      .asrun-tabs .mdc-tab--active,
    :host-context(html[data-theme="light"]) ::ng-deep
      .asrun-tabs .mat-mdc-tab[aria-selected="true"] {
      background: var(--bp-bg-2);
      box-shadow: inset 0 3px 0 var(--bp-line);
    }
  `],
})
export class AsrunContentComponent implements OnInit, OnDestroy {
  readonly service = inject(AsrunService);
  readonly channels = ASRUN_CHANNELS;
  readonly selectedIndex = signal(0);
  readonly activeChannel = computed<AsrunChannelSlug>(
    () => this.channels[this.selectedIndex()]?.slug as AsrunChannelSlug,
  );

  async ngOnInit(): Promise<void> {
    await this.service.loadInitial();
  }

  ngOnDestroy(): void {
    /* no-op */
  }

  async reload(): Promise<void> {
    await this.service.loadInitial();
  }

  async onDateChange(date: string): Promise<void> {
    if (!date) return;
    await this.service.setActiveDate(date);
  }
}
