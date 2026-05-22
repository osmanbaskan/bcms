import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { ProvysService } from './provys.service';
import { ProvysChannelPanelComponent } from './provys-channel-panel.component';
import { PROVYS_CHANNELS } from './provys.types';

@Component({
  selector: 'app-provys-content-control',
  standalone: true,
  imports: [CommonModule, MatTabsModule, MatIconModule, ProvysChannelPanelComponent],
  template: `
    <section class="page">
      <header class="page-head">
        <div>
          <h1>Provys İçerik Kontrol</h1>
          <p class="subtitle">SMB Provys dizinindeki BXF akış dosyaları — kanal başına güncel snapshot.</p>
        </div>
        <div class="status" [class.status--ok]="connected()" [class.status--err]="!!error()">
          <mat-icon class="dot" aria-hidden="true">{{ connected() ? 'sensors' : 'sensors_off' }}</mat-icon>
          <span>{{ connected() ? 'Canlı' : (error() ?? 'Bağlanıyor…') }}</span>
        </div>
      </header>

      <mat-tab-group
        class="provys-tabs"
        animationDuration="0ms"
        [selectedIndex]="selectedIndex()"
        (selectedIndexChange)="selectedIndex.set($event)"
      >
        @for (ch of channels; track ch.slug) {
          <mat-tab [label]="ch.displayName">
            <app-provys-channel-panel [channel]="ch.slug" />
          </mat-tab>
        }
      </mat-tab-group>
    </section>
  `,
  styles: [`
    :host { display: block; color: var(--bp-fg-1); }
    .page {
      display: flex; flex-direction: column; gap: 12px; padding: 0;
      background: var(--bp-bg-1); min-height: 100%;
    }
    .page-head {
      display: flex; justify-content: space-between; align-items: center;
      padding: 12px 16px 0 16px;
    }
    h1 {
      margin: 0; font-size: 22px;
      font-weight: var(--bp-fw-semibold, 600);
      color: var(--bp-fg-1);
      font-family: var(--bp-font-display, var(--bp-font-sans));
      letter-spacing: var(--bp-ls-tight);
    }
    .subtitle {
      margin: 2px 0 0 0; font-size: 12.5px;
      color: var(--bp-fg-3);
    }
    .status {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12.5px; padding: 4px 10px;
      border-radius: var(--bp-r-pill, 999px);
      background: var(--bp-bg-3); color: var(--bp-fg-2);
      border: 1px solid var(--bp-line-2);
    }
    .status .dot { font-size: 16px; width: 16px; height: 16px; }
    .status--ok  {
      background: rgba(16, 185, 129, 0.16); color: #6ee7b7;
      border-color: rgba(16, 185, 129, 0.40);
    }
    .status--err {
      background: rgba(239, 68, 68, 0.18); color: #fca5a5;
      border-color: rgba(239, 68, 68, 0.40);
    }
    .provys-tabs { background: var(--bp-bg-2); }
    ::ng-deep .provys-tabs .mat-mdc-tab-header {
      border-bottom: 1px solid var(--bp-line);
      background: var(--bp-bg-2);
    }
  `],
})
export class ProvysContentControlComponent implements OnInit, OnDestroy {
  readonly channels = PROVYS_CHANNELS;
  readonly selectedIndex = signal(0);

  private readonly service = inject(ProvysService);
  readonly connected = computed(() => this.service.connected());
  readonly error = computed(() => this.service.lastError());

  ngOnInit(): void {
    // Initial REST + SSE birlikte — SSE snapshot da gelir, idempotent set.
    void this.service.loadInitial();
    this.service.ensureStreaming();
  }

  ngOnDestroy(): void {
    this.service.stopStreaming();
  }
}
