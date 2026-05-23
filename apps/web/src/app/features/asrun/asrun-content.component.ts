import { ChangeDetectionStrategy, Component, OnInit, OnDestroy, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonToggleModule, MatButtonToggleChange } from '@angular/material/button-toggle';
import { LoggerService } from '../../core/services/logger.service';
import { AsrunService } from './asrun.service';
import { AsrunChannelPanelComponent } from './asrun-channel-panel.component';
import {
  ASRUN_CHANNELS,
  ASRUN_CATEGORIES,
  PROVYS_CATEGORY_STYLES,
  type AsrunCategory,
  type AsrunChannelSlug,
} from './asrun.types';

/**
 * Asrun İçerik Kaydı sayfası — Provys "İçerik Kontrol" sayfası ile aynı
 * UX: kanal tabları + kategori filtre toggle + Excel/PDF export.
 * Farklar: userNote feature'ı yok; ProgramHeader filter yok (Asrun
 * rawKind setinde ProgramHeader semantiği bulunmuyor).
 */
@Component({
  selector: 'app-asrun-content',
  standalone: true,
  imports: [
    CommonModule,
    MatTabsModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatButtonToggleModule,
    AsrunChannelPanelComponent,
  ],
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
          <button
            type="button"
            mat-stroked-button
            class="export-btn"
            matTooltip="Excel olarak indir"
            [disabled]="!canExport() || exporting()"
            (click)="onExportExcel()"
          >
            <mat-icon>file_download</mat-icon>
            <span class="btn-label">Excel ({{ activeVisibleCount() }})</span>
          </button>
          <button
            type="button"
            mat-stroked-button
            class="export-btn"
            matTooltip="PDF olarak indir"
            [disabled]="!canExport() || exporting()"
            (click)="onExportPdf()"
          >
            <mat-icon>picture_as_pdf</mat-icon>
            <span class="btn-label">PDF ({{ activeVisibleCount() }})</span>
          </button>
          <button mat-stroked-button (click)="reload()" matTooltip="Yenile">
            <mat-icon>refresh</mat-icon>
            <span class="btn-label">Yenile</span>
          </button>
        </div>
      </header>

      <div class="filter-bar">
        <span class="filter-label">KATEGORİLER:</span>
        <mat-button-toggle-group
          multiple
          class="cat-toggle"
          [value]="selectedCategoriesArray()"
          (change)="onCategoryChange($event)"
          aria-label="Kategori filtresi"
        >
          @for (c of categories; track c) {
            <mat-button-toggle [value]="c" matTooltip="{{ categoryLabel(c) }}">
              <span class="cat-swatch" [style.background]="categorySwatch(c)"></span>
              <span class="cat-name">{{ categoryLabel(c) }}</span>
            </mat-button-toggle>
          }
        </mat-button-toggle-group>
        <span class="count-label">{{ activeVisibleCount() }} / {{ activeTotalCount() }} kayıt</span>
      </div>

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
    .controls { display: flex; align-items: center; gap: 10px; }
    .date-control { display: inline-flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--bp-fg-3); }
    .date-control input {
      padding: 6px 10px; border: 1px solid var(--bp-line); border-radius: 4px;
      background: var(--bp-bg-2); color: var(--bp-fg-1); font-size: 13px;
    }
    .export-btn {
      display: inline-flex; align-items: center; gap: 4px;
      min-height: 36px; padding: 0 12px;
      border-color: var(--bp-line) !important;
      color: var(--bp-fg-1) !important;
      background: var(--bp-bg-3);
    }
    .export-btn[disabled] { opacity: 0.55; cursor: not-allowed; }
    .export-btn mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .export-btn .btn-label { font-size: 12.5px; font-weight: var(--bp-fw-medium, 500); }

    .filter-bar {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 4px 0 12px 0;
    }
    .filter-label {
      font-size: 11.5px; color: var(--bp-fg-3);
      font-weight: var(--bp-fw-semibold, 600);
      text-transform: uppercase; letter-spacing: 0;
    }
    .cat-toggle ::ng-deep .mat-button-toggle {
      background: var(--bp-bg-3);
      color: var(--bp-fg-2);
      border-color: var(--bp-line) !important;
    }
    .cat-toggle ::ng-deep .mat-button-toggle-checked {
      background: var(--bp-bg-1);
      color: var(--bp-fg-1);
    }
    .cat-toggle ::ng-deep .mat-button-toggle-button {
      height: 28px; padding: 0 8px;
    }
    .cat-toggle ::ng-deep .mat-button-toggle-label-content {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 11.5px; line-height: 1.2;
    }
    .cat-swatch {
      display: inline-block; width: 9px; height: 9px;
      border-radius: 50%;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.12);
    }
    .count-label {
      font-size: 11.5px; color: var(--bp-fg-3);
      font-variant-numeric: tabular-nums;
      margin-left: auto;
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
  private readonly logger = inject(LoggerService);
  readonly channels = ASRUN_CHANNELS;
  readonly categories = ASRUN_CATEGORIES;
  readonly selectedIndex = signal(0);
  readonly exporting = signal(false);
  readonly activeChannel = computed<AsrunChannelSlug>(
    () => this.channels[this.selectedIndex()]?.slug as AsrunChannelSlug,
  );

  /** ButtonToggleGroup multi-select için array gösterimi. */
  readonly selectedCategoriesArray = computed(() => Array.from(this.service.selectedCategories()));

  readonly activeTotalCount = computed(() => this.service.itemsFor(this.activeChannel())().length);
  readonly activeVisibleCount = computed(
    () => this.service.filteredItemsFor(this.activeChannel())().length,
  );
  readonly canExport = computed(() => this.activeVisibleCount() > 0);

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

  onCategoryChange(event: MatButtonToggleChange): void {
    const set = new Set<AsrunCategory>(event.value as AsrunCategory[]);
    this.service.setSelectedCategories(set);
  }

  categoryLabel(c: AsrunCategory): string {
    return PROVYS_CATEGORY_STYLES[c]?.label ?? c;
  }

  categorySwatch(c: AsrunCategory): string {
    return PROVYS_CATEGORY_STYLES[c]?.border ?? '#9ca3af';
  }

  async onExportExcel(): Promise<void> {
    if (!this.canExport() || this.exporting()) return;
    this.exporting.set(true);
    try {
      await this.service.exportExcel(this.activeChannel(), this.service.activeDate());
    } catch (err) {
      this.logger.error('asrun.export.excel.failed', err);
    } finally {
      this.exporting.set(false);
    }
  }

  async onExportPdf(): Promise<void> {
    if (!this.canExport() || this.exporting()) return;
    this.exporting.set(true);
    try {
      await this.service.exportPdf(this.activeChannel(), this.service.activeDate());
    } catch (err) {
      this.logger.error('asrun.export.pdf.failed', err);
    } finally {
      this.exporting.set(false);
    }
  }
}
