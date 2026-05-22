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
    .page { display: flex; flex-direction: column; gap: 12px; padding: 0; }
    .page-head {
      display: flex; justify-content: space-between; align-items: center;
      padding: 12px 16px 0 16px;
    }
    h1 { margin: 0; font-size: 22px; font-weight: 600; }
    .subtitle { margin: 2px 0 0 0; font-size: 12.5px; color: #6b7280; }
    .status {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12.5px; padding: 4px 10px; border-radius: 14px;
      background: #f3f4f6; color: #6b7280;
    }
    .status .dot { font-size: 16px; width: 16px; height: 16px; }
    .status--ok { background: #ecfdf5; color: #047857; }
    .status--err { background: #fef2f2; color: #b91c1c; }
    .provys-tabs { background: #ffffff; }
    ::ng-deep .provys-tabs .mat-mdc-tab-header { border-bottom: 1px solid #e5e7eb; }
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
