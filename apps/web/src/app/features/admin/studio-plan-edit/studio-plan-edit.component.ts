import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../../core/services/api.service';
import { LoggerService } from '../../../core/services/logger.service';
import { STUDIO_PLAN_SLOT_MINUTES } from '../../studio-plan/studio-plan.component';
import {
  type CatalogDto, type ColorRow, type ProgramRow, type SettingsDto,
  buildHourlyTimeOptions, durationMinutes, validateColors, validatePrograms,
  validateTimeRange, HEX_RE, mondayOf,
} from './studio-plan-edit.types';

@Component({
  selector: 'app-studio-plan-edit',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatButtonModule, MatIconModule, MatInputModule, MatFormFieldModule,
    MatSelectModule, MatSlideToggleModule, MatTooltipModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './studio-plan-edit.component.html',
  styleUrl: './studio-plan-edit.component.scss',
})
export class StudioPlanEditComponent implements OnInit {
  private readonly api    = inject(ApiService);
  private readonly logger = inject(LoggerService);

  readonly slotMinutes = STUDIO_PLAN_SLOT_MINUTES;
  readonly timeOptions = buildHourlyTimeOptions();

  // Catalog state
  readonly loading      = signal(true);
  readonly errorMsg     = signal('');
  readonly saveMsg      = signal('');
  readonly programs     = signal<ProgramRow[]>([]);
  readonly colors       = signal<ColorRow[]>([]);
  readonly catalogDirty = signal(false);
  readonly draftColorHex = signal('#cccccc');

  // Settings state — hafta bazlı persist
  readonly weekStart       = signal<string>(mondayOf(new Date()));
  readonly selectedStart   = signal('07:00');
  readonly selectedEnd     = signal('03:00');
  readonly settingsPersisted = signal(false);
  readonly settingsUpdatedBy = signal<string | null>(null);
  readonly settingsDirty   = signal(false);

  // ── computed validation ──────────────────────────────────────────────────
  readonly programErrors = computed(() => validatePrograms(this.programs()));
  readonly colorErrors   = computed(() => validateColors(this.colors()));
  readonly timeErrors    = computed(() => validateTimeRange(this.selectedStart(), this.selectedEnd()));
  readonly draftHexValid = computed(() => HEX_RE.test(this.draftColorHex()));
  readonly catalogErrors = computed(() => [...this.programErrors(), ...this.colorErrors()]);
  readonly selectedDurationMinutes = computed(
    () => durationMinutes(this.selectedStart(), this.selectedEnd()),
  );

  /** Kaydet aktif olma kuralı:
   *   - catalogDirty + catalog valid, VEYA
   *   - settingsDirty + time range valid
   *   ↓ İki taraftan en az biri kaydedilebilir olmalı. */
  readonly canSave = computed(() => {
    const catalogOk  = this.catalogDirty()  && this.catalogErrors().length === 0;
    const settingsOk = this.settingsDirty() && this.timeErrors().length    === 0;
    return catalogOk || settingsOk;
  });

  // ── lifecycle ────────────────────────────────────────────────────────────
  async ngOnInit(): Promise<void> { await this.reload(); }

  async reload(): Promise<void> {
    await Promise.all([this.reloadCatalog(), this.reloadSettings()]);
  }

  async reloadCatalog(): Promise<void> {
    this.loading.set(true); this.errorMsg.set(''); this.saveMsg.set('');
    try {
      const dto = await firstValueFrom(this.api.get<CatalogDto>('/studio-plans/catalog'));
      this.programs.set(dto.programs.map((p) => ({ ...p })));
      this.colors.set(dto.colors.map((c) => ({ ...c })));
      this.catalogDirty.set(false);
    } catch (err) {
      this.logger.error('studio-plan-edit.catalog.load.failed', err);
      this.errorMsg.set('Katalog yüklenemedi');
    } finally {
      this.loading.set(false);
    }
  }

  async reloadSettings(): Promise<void> {
    this.saveMsg.set('');
    try {
      const ws = this.weekStart();
      const dto = await firstValueFrom(this.api.get<SettingsDto>(`/studio-plans/${ws}/settings`));
      this.selectedStart.set(dto.timeRangeStart);
      this.selectedEnd.set(dto.timeRangeEnd);
      this.settingsPersisted.set(dto.persisted);
      this.settingsUpdatedBy.set(dto.updatedBy ?? null);
      this.settingsDirty.set(false);
    } catch (err) {
      this.logger.error('studio-plan-edit.settings.load.failed', err);
      this.errorMsg.set('Ayarlar yüklenemedi');
    }
  }

  // ── catalog editors ──────────────────────────────────────────────────────
  markCatalogDirty(): void { this.catalogDirty.set(true); this.saveMsg.set(''); }
  addProgram(): void {
    const order = (this.programs().length + 1) * 10;
    this.programs.set([...this.programs(), { name: '', sortOrder: order, active: true }]);
    this.markCatalogDirty();
  }
  removeProgram(i: number): void {
    const next = [...this.programs()]; next.splice(i, 1);
    this.programs.set(next); this.markCatalogDirty();
  }
  addColor(): void {
    const order = (this.colors().length + 1) * 10;
    const hex = this.draftHexValid() ? this.draftColorHex().toLowerCase() : '#cccccc';
    this.colors.set([...this.colors(), { label: '', value: hex, sortOrder: order, active: true }]);
    this.markCatalogDirty();
  }
  removeColor(i: number): void {
    const next = [...this.colors()]; next.splice(i, 1);
    this.colors.set(next); this.markCatalogDirty();
  }
  onColorPick(c: ColorRow, hex: string): void { c.value = hex; this.markCatalogDirty(); }
  isHex(v: string | null | undefined): boolean { return !!v && HEX_RE.test(v); }
  normalizedHex(v: string | undefined): string { return this.isHex(v) ? v! : '#cccccc'; }
  onDraftColorPick(hex: string): void { this.draftColorHex.set(hex); }

  // ── settings form ────────────────────────────────────────────────────────
  markSettingsDirty(): void { this.settingsDirty.set(true); this.saveMsg.set(''); }
  setStart(v: string): void { this.selectedStart.set(v); this.markSettingsDirty(); }
  setEnd(v: string): void { this.selectedEnd.set(v); this.markSettingsDirty(); }
  async onWeekStartChange(v: string): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    const monday = mondayOf(new Date(`${v}T00:00:00Z`));
    this.weekStart.set(monday);
    await this.reloadSettings();
  }
  clearTimeForm(): void {
    this.selectedStart.set('07:00');
    this.selectedEnd.set('03:00');
    this.markSettingsDirty();
  }

  // ── save (catalog ve/veya settings, slot YAZMAZ) ─────────────────────────
  async save(): Promise<void> {
    if (!this.canSave()) return;
    this.loading.set(true); this.errorMsg.set(''); this.saveMsg.set('');
    const messages: string[] = [];
    try {
      if (this.catalogDirty() && this.catalogErrors().length === 0) {
        const payload = {
          programs: this.programs().map((p) => ({
            name: p.name.trim(), sortOrder: p.sortOrder | 0, active: !!p.active,
          })),
          colors: this.colors().map((c) => ({
            label: c.label.trim(), value: c.value.toLowerCase(),
            sortOrder: c.sortOrder | 0, active: !!c.active,
          })),
        };
        const dto = await firstValueFrom(this.api.put<CatalogDto>('/studio-plans/catalog', payload));
        this.programs.set(dto.programs.map((p) => ({ ...p })));
        this.colors.set(dto.colors.map((c) => ({ ...c })));
        this.catalogDirty.set(false);
        messages.push('Katalog kaydedildi.');
      }
      if (this.settingsDirty() && this.timeErrors().length === 0) {
        const ws = this.weekStart();
        const dto = await firstValueFrom(this.api.put<SettingsDto>(`/studio-plans/${ws}/settings`, {
          timeRangeStart: this.selectedStart(),
          timeRangeEnd:   this.selectedEnd(),
        }));
        this.selectedStart.set(dto.timeRangeStart);
        this.selectedEnd.set(dto.timeRangeEnd);
        this.settingsPersisted.set(dto.persisted);
        this.settingsUpdatedBy.set(dto.updatedBy ?? null);
        this.settingsDirty.set(false);
        messages.push(`Zaman aralığı ${ws} haftası için kaydedildi (slot yazılmadı).`);
      }
      this.saveMsg.set(messages.join(' '));
    } catch (err) {
      this.logger.error('studio-plan-edit.save.failed', err);
      this.errorMsg.set('Kaydetme başarısız oldu.');
    } finally {
      this.loading.set(false);
    }
  }
}
