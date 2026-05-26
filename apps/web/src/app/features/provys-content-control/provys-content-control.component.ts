import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDatepickerModule, MatDatepickerInputEvent } from '@angular/material/datepicker';
import { MAT_DATE_LOCALE, provideNativeDateAdapter } from '@angular/material/core';
import { MatButtonToggleModule, MatButtonToggleChange } from '@angular/material/button-toggle';
import { MatSlideToggleModule, MatSlideToggleChange } from '@angular/material/slide-toggle';
import { LoggerService } from '../../core/services/logger.service';
import { ProvysService } from './provys.service';
import { ProvysChannelPanelComponent } from './provys-channel-panel.component';
import {
  PROVYS_CHANNELS,
  PROVYS_CATEGORIES,
  PROVYS_CATEGORY_STYLES,
  type ProvysCategory,
  type ProvysChannelSlug,
} from './provys.types';

function isoFromDate(d: Date): string {
  // Date picker user-local; UI Europe/Istanbul varsayar. Naive YYYY-MM-DD.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateFromIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map((s) => Number(s));
  return new Date(y, m - 1, d);
}

@Component({
  selector: 'app-provys-content-control',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatTabsModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatFormFieldModule,
    MatInputModule,
    MatDatepickerModule,
    MatButtonToggleModule,
    MatSlideToggleModule,
    ProvysChannelPanelComponent,
  ],
  providers: [
    provideNativeDateAdapter(),
    { provide: MAT_DATE_LOCALE, useValue: 'tr-TR' },
  ],
  template: `
    <section class="page">
      <header class="page-head">
        <div>
          <h1>Provys İçerik Kontrol</h1>
          <p class="subtitle">SMB Provys dizinindeki BXF akış dosyaları — kanal+gün başına snapshot.</p>
        </div>
        <div class="head-right">
          <mat-form-field appearance="outline" class="date-field" subscriptSizing="dynamic">
            <mat-label>Yayın günü</mat-label>
            <input
              matInput
              [matDatepicker]="picker"
              [value]="dateValue()"
              (dateChange)="onDateChange($event)"
              readonly
            />
            <mat-datepicker-toggle matIconSuffix [for]="picker" />
            <mat-datepicker #picker />
          </mat-form-field>
          <button
            type="button"
            mat-stroked-button
            class="export-btn"
            matTooltip="Excel olarak indir"
            [disabled]="!canExport() || exporting()"
            (click)="onExportExcel()"
          >
            <mat-icon>table_view</mat-icon>
            <span class="btn-label">Excel</span>
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
            <span class="btn-label">PDF</span>
          </button>
          <div class="status" [class.status--ok]="connected()" [class.status--err]="!!error()">
            <mat-icon class="dot" aria-hidden="true">{{ connected() ? 'sensors' : 'sensors_off' }}</mat-icon>
            <span>{{ connected() ? 'Canlı' : (error() ?? 'Bağlanıyor…') }}</span>
          </div>
        </div>
      </header>

      <div class="filter-bar">
        <span class="filter-label">Kategoriler:</span>
        <mat-button-toggle-group
          multiple
          class="cat-toggle"
          [value]="selectedCategoryArray()"
          (change)="onCategoryToggle($event)"
          hideSingleSelectionIndicator="true"
          aria-label="Kategori filtresi"
        >
          @for (cat of categories; track cat) {
            <mat-button-toggle [value]="cat" [class]="'cat-toggle-btn cat-toggle--' + cat.toLowerCase()">
              <span class="cat-swatch" [style.background]="swatchColor(cat)"></span>
              <span class="cat-toggle-label">{{ categoryLabel(cat) }}</span>
            </mat-button-toggle>
          }
        </mat-button-toggle-group>
        <mat-slide-toggle
          class="header-toggle"
          [checked]="showProgramHeaders()"
          (change)="onShowProgramHeadersToggle($event)"
          aria-label="Program başlıklarını göster"
        >
          Program başlıkları
        </mat-slide-toggle>
        <mat-slide-toggle
          class="header-toggle"
          [checked]="onlyMissingMaterial()"
          (change)="onOnlyMissingMaterialToggle($event)"
          aria-label="Sadece eksik materyaller"
          matTooltip="missing_material, found_duration_mismatch, found_duration_unknown, ssdb_error"
        >
          Sadece eksik materyaller
        </mat-slide-toggle>
        <span class="count-label" aria-live="polite">
          {{ visibleCount() }} / {{ totalCount() }} kayıt
        </span>
      </div>

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
      padding: 12px 16px 0 16px; gap: 12px; flex-wrap: wrap;
    }
    .head-right { display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap; }
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
    .date-field { width: 180px; }
    ::ng-deep .date-field .mat-mdc-form-field-subscript-wrapper { display: none; }
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
    /* Aktif kanal ismi her iki temada da pasiflerden net büyük olsun.
       Material default 14px → pasif 12.5 (mevcut header), aktif 15.5 + 700.
       letter-spacing hafif sıkı, layout shift olmaması için min-width: auto. */
    ::ng-deep .provys-tabs .mat-mdc-tab .mdc-tab__text-label {
      font-size: 12.5px;
      font-weight: var(--bp-fw-medium, 500);
      transition:
        font-size var(--bp-dur-fast, 100ms) linear,
        font-weight var(--bp-dur-fast, 100ms) linear,
        color var(--bp-dur-fast, 100ms) linear;
    }
    ::ng-deep .provys-tabs .mdc-tab--active .mdc-tab__text-label,
    ::ng-deep .provys-tabs .mat-mdc-tab[aria-selected="true"] .mdc-tab__text-label {
      font-size: 15.5px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    /* Aktif tab indicator (alt çubuk) tema-agnostik kalınlık + renk. */
    ::ng-deep .provys-tabs .mdc-tab-indicator__content--underline {
      border-top-width: 3px;
    }
    .filter-bar {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 4px 16px 0 16px;
    }
    .filter-label {
      font-size: 11.5px; color: var(--bp-fg-3);
      font-weight: var(--bp-fw-semibold, 600);
      text-transform: uppercase; letter-spacing: 0.04em;
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
    .header-toggle ::ng-deep .mdc-form-field { font-size: 11.5px; color: var(--bp-fg-2); }
    .header-toggle ::ng-deep label { color: var(--bp-fg-2); }

    /* ───── LIGHT MODE NETLİK ─────
       Sadece html[data-theme="light"] altında çerçeveleri kuvvetlendir.
       Dark theme dokunulmadan kalır. */
    :host-context(html[data-theme="light"]) .provys-tabs {
      border: 1px solid var(--bp-line);
      border-radius: 6px;
      overflow: hidden;
    }
    :host-context(html[data-theme="light"]) ::ng-deep
      .provys-tabs .mat-mdc-tab-header {
      border-bottom: 2px solid var(--bp-line);
      background: var(--bp-bg-4);
    }
    :host-context(html[data-theme="light"]) ::ng-deep
      .provys-tabs .mat-mdc-tab .mdc-tab__text-label {
      color: var(--bp-fg-3);
    }
    :host-context(html[data-theme="light"]) ::ng-deep
      .provys-tabs .mdc-tab--active .mdc-tab__text-label,
    :host-context(html[data-theme="light"]) ::ng-deep
      .provys-tabs .mat-mdc-tab[aria-selected="true"] .mdc-tab__text-label {
      color: var(--bp-fg-1);
    }
    /* Light mode aktif tab: kart-beyazı zemin (bg-4 mor header üstünde
       ayrımı net) + üst kenar accent. */
    :host-context(html[data-theme="light"]) ::ng-deep
      .provys-tabs .mdc-tab--active,
    :host-context(html[data-theme="light"]) ::ng-deep
      .provys-tabs .mat-mdc-tab[aria-selected="true"] {
      background: var(--bp-bg-2);
      box-shadow: inset 0 3px 0 var(--bp-line);
    }
    /* Light mode aktif indicator: Material default rengi tema rengine zorla. */
    :host-context(html[data-theme="light"]) ::ng-deep
      .provys-tabs .mdc-tab-indicator--active
      .mdc-tab-indicator__content--underline {
      border-color: var(--bp-line) !important;
    }
    /* Filter bar (kategori toggle + count + ProgramHeader switch) zemini
       light mode'da kart kenarıyla net ayrılsın. */
    :host-context(html[data-theme="light"]) .filter-bar {
      border-bottom: 1px solid rgba(76, 29, 149, 0.28);
    }
    :host-context(html[data-theme="light"]) .cat-toggle ::ng-deep
      .mat-button-toggle {
      border-color: var(--bp-line) !important;
      color: var(--bp-fg-1);
    }
  `],
})
export class ProvysContentControlComponent implements OnInit, OnDestroy {
  readonly channels = PROVYS_CHANNELS;
  readonly categories = PROVYS_CATEGORIES;
  readonly selectedIndex = signal(0);
  readonly exporting = signal(false);

  private readonly service = inject(ProvysService);
  private readonly logger = inject(LoggerService);
  readonly connected = computed(() => this.service.connected());
  readonly error = computed(() => this.service.lastError());

  /** Date picker `Date` objesi olarak okur; service ISO string saklar. */
  readonly dateValue = computed<Date>(() => dateFromIso(this.service.activeDate()));

  /** Aktif tab → kanal slug. */
  readonly activeChannel = computed<ProvysChannelSlug>(() => this.channels[this.selectedIndex()].slug);

  /** Kategori toggle-group için ham array (mat-button-toggle-group `value`). */
  readonly selectedCategoryArray = computed<ProvysCategory[]>(() => {
    const set = this.service.selectedCategories();
    return this.categories.filter((c) => set.has(c));
  });

  /** Sayım — aktif kanalın görünür/toplam satır sayısı. */
  readonly totalCount = computed<number>(() => this.service.itemsFor(this.activeChannel())().length);
  readonly visibleCount = computed<number>(() => this.service.filteredItemsFor(this.activeChannel())().length);

  /** Export butonları — aktif kanal+gün+filtre için satır yoksa disable. */
  readonly canExport = computed<boolean>(() => this.visibleCount() > 0);

  categoryLabel(category: ProvysCategory): string {
    return PROVYS_CATEGORY_STYLES[category]?.label ?? category;
  }

  /** Toggle UI swatch'ı için accent border rengi. */
  swatchColor(category: ProvysCategory): string {
    return PROVYS_CATEGORY_STYLES[category]?.border ?? '#9ca3af';
  }

  onCategoryToggle(ev: MatButtonToggleChange): void {
    // `multiple` toggle-group: value = seçili kategori array'i
    const selected = new Set(ev.value as ProvysCategory[]);
    this.service.setSelectedCategories(selected);
  }

  /** Service'in showProgramHeaders signal'ini computed olarak okur. */
  readonly showProgramHeaders = computed<boolean>(() => this.service.showProgramHeaders());

  onShowProgramHeadersToggle(ev: MatSlideToggleChange): void {
    this.service.setShowProgramHeaders(ev.checked);
  }

  readonly onlyMissingMaterial = computed<boolean>(() => this.service.onlyMissingMaterial());

  onOnlyMissingMaterialToggle(ev: MatSlideToggleChange): void {
    this.service.setOnlyMissingMaterial(ev.checked);
  }

  ngOnInit(): void {
    void this.service.loadInitial();
    this.service.ensureStreaming();
  }

  ngOnDestroy(): void {
    this.service.stopStreaming();
  }

  onDateChange(ev: MatDatepickerInputEvent<Date>): void {
    if (!ev.value) return;
    void this.service.setActiveDate(isoFromDate(ev.value));
  }

  async onExportExcel(): Promise<void> {
    if (this.exporting()) return;
    this.exporting.set(true);
    try {
      await this.service.exportExcel(this.activeChannel(), this.service.activeDate());
    } catch (err) {
      this.logger.error('Provys Excel export failed', err);
    } finally {
      this.exporting.set(false);
    }
  }

  async onExportPdf(): Promise<void> {
    if (this.exporting()) return;
    this.exporting.set(true);
    try {
      await this.service.exportPdf(this.activeChannel(), this.service.activeDate());
    } catch (err) {
      this.logger.error('Provys PDF export failed', err);
    } finally {
      this.exporting.set(false);
    }
  }
}
