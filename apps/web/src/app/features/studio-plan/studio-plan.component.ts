import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { finalize } from 'rxjs';
import { StudioPlanService } from '../../core/services/studio-plan.service';
import type { StudioPlan, StudioPlanSlot } from '@bcms/shared';

interface StudioPlanDay {
  id: string;
  label: string;
  date: string;
}

interface StudioPlanColor {
  label: string;
  value: string;
}

interface StudioPlanAssignment {
  program: string;
  color: string;
}

interface StudioPlanListEntry {
  id: string;
  dayLabel: string;
  dayDate: string;
  studio: string;
  startTime: string;
  endTime: string;
  program: string;
  color: string;
  colorLabel: string;
  slotCount: number;
}

const DAY_LABELS = [
  'Pazar',
  'Pazartesi',
  'Salı',
  'Çarşamba',
  'Perşembe',
  'Cuma',
  'Cumartesi',
];

const DEFAULT_START_DATE = mondayFor(new Date());
const STUDIOS = [
  'Stüdyo 1',
  'Stüdyo 2',
  'Stüdyo 3',
  'Stüdyo 4',
  'beIN Gurme',
];

const PROGRAMS = [
  'HABER CY',
  'beIN SABAH CY',
  'GÜN ORTASI CY',
  'beIN TENİS CY',
  'KADRO İÇİNDE BK',
  'BSL ÖZETLER BK',
  'beIN SÜPER LİG CY',
  'ANA HABER CY',
  'DEVRE ARASI',
  'KEŞFETTİK CY',
  'SKOR CY',
  'TRIO CY',
  'SPOR GECESİ CY',
  '10 NUMARA BK (UĞUR MELEKE’NİN ODASI)',
  'SPOR FİNAL CY',
  'DERBİ ANALİZ BK',
  'TAKTİK TAHTASI BK',
  'İSTATİSTİK BANKASI BK',
  'LİG MERKEZİ CY',
  'TARAFTAR BK',
  'beIN BASKETBOL CY',
  'BİR DERBİ GÜNÜ BK',
  'GAMER BK',
  'TAKTİK SETUP BK',
  'AVRUPA CY',
  'PREMIER EXPRES BK',
  'BASKETBOL SÜPER LİG MAÇ ÖNÜ REJİ ORTAK',
  'BASKETBOL SÜPER LİG MAÇ SONU REJİ ORTAK',
];

const COLORS: StudioPlanColor[] = [
  { label: 'HD NEWS', value: '#ffc400' },
  { label: 'BS 1', value: '#c6d9f1' },
  { label: 'BS 2', value: '#bfbfbf' },
  { label: 'BS 3', value: '#00a6d6' },
  { label: 'BS 4', value: '#2ff078' },
  { label: 'beIN GURME', value: '#f4f500' },
  { label: 'ADVERTORIAL / DEMO / DİĞER', value: '#8bc34a' },
  { label: 'BS5', value: '#8b8956' },
  { label: 'OUTSIDE', value: '#f5c9a8' },
  { label: 'REJİ VE TANITIM', value: '#ff1010' },
  { label: 'ORTAK YAYIN', value: '#6f2da8' },
];

function buildHalfHourSlots(): string[] {
  const slots: string[] = [];
  for (let minute = 6 * 60; minute < 26 * 60; minute += 30) {
    const hour = Math.floor(minute / 60) % 24;
    const mins = minute % 60;
    slots.push(`${String(hour).padStart(2, '0')}:${String(mins).padStart(2, '0')}`);
  }
  return slots;
}

const TIME_SLOTS = buildHalfHourSlots();

function mondayFor(date: Date): string {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = monday.getDay();
  const distanceFromMonday = day === 0 ? 6 : day - 1;
  monday.setDate(monday.getDate() - distanceFromMonday);
  return toDateInputValue(monday);
}

function toDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

@Component({
  selector: 'app-studio-plan',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatIconModule,
    MatSelectModule,
  ],
  template: `
    <section class="studio-plan-page">
      <header class="page-header">
        <div>
          <h1>Stüdyo Planı</h1>
          <p>{{ dateRangeLabel() }} · 06:00 - 02:00 · 30 dakikalık slotlar</p>
        </div>

        <button mat-flat-button color="primary" type="button" (click)="exportPlan()">
          <mat-icon>download</mat-icon>
          Export PDF
        </button>
      </header>

      <div class="toolbar">
        <mat-form-field appearance="outline">
          <mat-label>Hafta Başlangıcı</mat-label>
          <mat-select [(ngModel)]="weekStart" (selectionChange)="onWeekStartChange()">
            <mat-option *ngFor="let option of weekOptions" [value]="option.value">
              {{ option.label }}
            </mat-option>
          </mat-select>
        </mat-form-field>

        <mat-button-toggle-group
          [value]="viewMode()"
          (change)="viewMode.set($event.value)"
          aria-label="Görünüm"
        >
          <mat-button-toggle value="table">Tablo</mat-button-toggle>
          <mat-button-toggle value="list">Liste</mat-button-toggle>
        </mat-button-toggle-group>

        <mat-form-field appearance="outline" class="program-select">
          <mat-label>Program</mat-label>
          <mat-select [(ngModel)]="selectedProgram">
            <mat-option *ngFor="let program of programs" [value]="program">{{ program }}</mat-option>
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline" class="color-select">
          <mat-label>Renk</mat-label>
          <mat-select [(ngModel)]="selectedColor">
            <mat-select-trigger>
              <span class="color-option">
                <span class="color-swatch" [style.background]="selectedColor"></span>
                {{ colorLabel(selectedColor) }}
              </span>
            </mat-select-trigger>
            <mat-option *ngFor="let color of colors" [value]="color.value">
              <span class="color-option">
                <span class="color-swatch" [style.background]="color.value"></span>
                {{ color.label }}
              </span>
            </mat-option>
          </mat-select>
        </mat-form-field>

        <button mat-stroked-button type="button" (click)="clearSelection()">
          <mat-icon>backspace</mat-icon>
          Seçili Programı Temizle
        </button>

        <button mat-stroked-button type="button" (click)="moveCurrentWeekToNextWeek()">
          <mat-icon>event_repeat</mat-icon>
          Bu Haftayı Gelecek Haftaya Taşı
        </button>

        <button
          mat-stroked-button
          type="button"
          [class.active-tool]="eraserMode()"
          (click)="eraserMode.set(!eraserMode())"
        >
          <mat-icon>ink_eraser</mat-icon>
          Silgi
        </button>

        <span class="save-state" *ngIf="loading()">Yükleniyor...</span>
        <span class="save-state" *ngIf="saving()">Kaydediliyor...</span>
        <span class="save-state error" *ngIf="saveError()">{{ saveError() }}</span>
        <span class="save-state" *ngIf="!saving() && !loading() && lastSavedAt()">
          Kaydedildi · {{ lastSavedAt() }}
        </span>
      </div>

      <div id="studio-plan-export" class="plan-shell">
        <div class="print-title">
          <strong>STÜDYO PLANI</strong>
          <span>{{ dateRangeLabel() }}</span>
        </div>

        <div class="plan-grid" *ngIf="viewMode() !== 'list'" [style.--day-count]="visibleDays().length">
          <div class="corner-cell">Saat</div>

          <ng-container *ngFor="let day of visibleDays()">
            <div class="day-header" [style.gridColumn]="'span ' + studios.length">
              <strong>{{ day.date }}</strong>
              <span>{{ day.label }}</span>
            </div>
          </ng-container>

          <ng-container *ngFor="let day of visibleDays()">
            <div class="studio-header" *ngFor="let studio of studios">{{ studio }}</div>
          </ng-container>

          <ng-container *ngFor="let time of timeSlots">
            <div class="time-cell">{{ time }}</div>

            <ng-container *ngFor="let day of visibleDays()">
              <button
                class="slot-cell"
                type="button"
                *ngFor="let studio of studios"
                [class.filled]="programAt(day.id, studio, time)"
                [class.continuation]="isContinuation(day.id, studio, time)"
                [class.continues]="continuesProgram(day.id, studio, time)"
                [style.background]="colorAt(day.id, studio, time)"
                [style.borderBottomColor]="continuesProgram(day.id, studio, time) ? colorAt(day.id, studio, time) : null"
                [style.--run-slots]="runLength(day.id, studio, time)"
                [style.--program-font-size.px]="programFontSize(day.id, studio, time)"
                (click)="assignProgram(day.id, studio, time)"
                [attr.aria-label]="day.label + ' ' + studio + ' ' + time"
              >
                <span>{{ isContinuation(day.id, studio, time) ? '' : programAt(day.id, studio, time) }}</span>
              </button>
            </ng-container>
          </ng-container>
        </div>

        <div class="list-view" *ngIf="viewMode() === 'list'">
          <div class="list-header">
            <span>Gün</span>
            <span>Stüdyo</span>
            <span>Saat</span>
            <span>Program</span>
            <span>Renk</span>
            <span>Süre</span>
          </div>

          <div class="empty-list" *ngIf="listEntries().length === 0">
            Bu hafta için kayıtlı stüdyo planı yok.
          </div>

          <div class="list-row" *ngFor="let entry of listEntries()">
            <div class="day-cell">
              <strong>{{ entry.dayLabel }}</strong>
              <span>{{ entry.dayDate }}</span>
            </div>
            <div>{{ entry.studio }}</div>
            <div class="time-range">{{ entry.startTime }} - {{ entry.endTime }}</div>
            <div class="program-cell">
              <span class="program-marker" [style.background]="entry.color"></span>
              <strong>{{ entry.program }}</strong>
            </div>
            <div>{{ entry.colorLabel }}</div>
            <div>{{ entry.slotCount * 30 }} dk</div>
          </div>
        </div>
      </div>
    </section>
  `,
  styles: [`
    .studio-plan-page {
      display: flex;
      flex-direction: column;
      gap: 18px;
      min-width: 0;
    }

    .page-header,
    .toolbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 600;
    }

    p {
      margin: 4px 0 0;
      color: #667085;
    }

    .toolbar {
      align-items: center;
      padding: 12px;
      border: 1px solid #d0d5dd;
      background: #f8fafc;
    }

    mat-form-field {
      width: 220px;
    }

    .program-select {
      width: min(440px, 100%);
    }

    .color-select {
      width: 260px;
    }

    .color-option {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .color-swatch {
      width: 34px;
      height: 12px;
      border: 1px solid rgba(17, 24, 39, 0.3);
      flex: 0 0 auto;
    }

    .toolbar ::ng-deep .mat-mdc-select-value,
    .toolbar ::ng-deep .mat-mdc-select-arrow,
    .toolbar ::ng-deep .mat-mdc-floating-label,
    .toolbar ::ng-deep .mat-mdc-form-field-label {
      color: #111827 !important;
    }

    .toolbar ::ng-deep .mat-mdc-text-field-wrapper {
      background: #ffffff !important;
    }

    .toolbar ::ng-deep .mdc-notched-outline__leading,
    .toolbar ::ng-deep .mdc-notched-outline__notch,
    .toolbar ::ng-deep .mdc-notched-outline__trailing {
      border-color: #98a2b3 !important;
    }

    .active-tool {
      color: #fff !important;
      background: #b42318 !important;
      border-color: #b42318 !important;
    }

    .save-state {
      color: #475467;
      font-size: 13px;
      font-weight: 600;
    }

    .save-state.error {
      color: #b42318;
    }

    .plan-shell {
      max-height: calc(100vh - 260px);
      overflow: auto;
      border: 1px solid #111827;
      background: #fff;
      position: relative;
    }

    .print-title {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      min-width: max-content;
      padding: 10px 12px;
      color: #fff;
      background: #43206d;
      letter-spacing: 0.02em;
    }

    .plan-grid {
      --cell-width: 92px;
      --time-width: 58px;
      display: grid;
      grid-template-columns: var(--time-width) repeat(calc(var(--day-count) * 5), var(--cell-width));
      min-width: max-content;
      font-size: 11px;
    }

    .corner-cell,
    .time-cell,
    .day-header,
    .studio-header,
    .slot-cell {
      border-right: 1px solid #111827;
      border-bottom: 1px solid #111827;
    }

    .corner-cell,
    .time-cell {
      position: sticky;
      left: 0;
      z-index: 3;
    }

    .corner-cell {
      background: #43206d;
    }

    .corner-cell {
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: 700;
      grid-row: span 2;
      top: 0;
      z-index: 8;
    }

    .day-header {
      position: sticky;
      top: 0;
      z-index: 7;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 48px;
      color: #fff;
      background: #43206d;
      text-transform: uppercase;
    }

    .studio-header {
      position: sticky;
      top: 49px;
      z-index: 6;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      padding: 4px;
      color: #fff;
      background: #43206d;
      font-size: 10px;
      font-weight: 700;
      text-align: center;
      text-transform: uppercase;
    }

    .time-cell {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 34px;
      color: #fff;
      background: #43206d;
      font-weight: 700;
      z-index: 4;
    }

    .slot-cell {
      min-height: 34px;
      padding: 2px 3px;
      background: #ffd226;
      color: #111827;
      border-top: 0;
      border-left: 0;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      overflow: visible;
      position: relative;
    }

    .slot-cell:hover {
      outline: 2px solid #1d4ed8;
      outline-offset: -2px;
    }

    .slot-cell.filled {
      background: #f4b400;
    }

    .slot-cell.continuation {
      padding-top: 0;
      padding-bottom: 0;
    }

    .slot-cell span {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: calc(var(--run-slots, 1) * 34px - 6px);
      overflow: hidden;
      font-size: var(--program-font-size, 11px);
      line-height: 1.1;
      text-align: center;
      overflow-wrap: anywhere;
    }

    .slot-cell.continues:not(.continuation) span {
      position: absolute;
      inset: 2px 3px auto 3px;
      z-index: 2;
      pointer-events: none;
    }

    .list-view {
      min-width: 920px;
      color: #111827;
      background: #fff;
    }

    .list-header,
    .list-row {
      display: grid;
      grid-template-columns: 160px 120px 120px minmax(280px, 1fr) 180px 80px;
      align-items: center;
      min-height: 44px;
      border-bottom: 1px solid #d0d5dd;
    }

    .list-header {
      position: sticky;
      top: 0;
      z-index: 5;
      color: #fff;
      background: #43206d;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .list-header span,
    .list-row > div {
      min-width: 0;
      padding: 8px 10px;
      border-right: 1px solid #d0d5dd;
    }

    .list-row {
      font-size: 13px;
    }

    .list-row:nth-child(odd) {
      background: #f8fafc;
    }

    .day-cell,
    .program-cell {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .day-cell {
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
    }

    .day-cell span {
      color: #667085;
      font-size: 12px;
    }

    .time-range {
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }

    .program-marker {
      width: 30px;
      height: 14px;
      flex: 0 0 auto;
      border: 1px solid rgba(17, 24, 39, 0.3);
    }

    .program-cell strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .empty-list {
      padding: 28px;
      color: #667085;
      font-weight: 600;
      text-align: center;
    }

    @media print {
      body * {
        visibility: hidden;
      }

      #studio-plan-export,
      #studio-plan-export * {
        visibility: visible;
      }

      #studio-plan-export {
        position: fixed;
        inset: 0;
        overflow: visible;
        border: 0;
      }

      .page-header,
      .toolbar {
        display: none !important;
      }

      .plan-grid {
        --cell-width: 32px;
        --time-width: 30px;
        font-size: 5px;
      }

      .list-view {
        min-width: 0;
      }

      .list-header,
      .list-row {
        grid-template-columns: 88px 70px 70px minmax(130px, 1fr) 90px 44px;
        min-height: 24px;
        font-size: 6px;
      }

      .list-header span,
      .list-row > div {
        padding: 3px 4px;
      }

      .day-header {
        min-height: 22px;
      }

      .studio-header {
        min-height: 26px;
        font-size: 4.5px;
        writing-mode: vertical-rl;
        transform: rotate(180deg);
      }

      .time-cell,
      .slot-cell {
        min-height: 16px;
      }

      .slot-cell {
        appearance: none;
      }

      .slot-cell span {
        min-height: calc(var(--run-slots, 1) * 16px - 4px);
        font-size: calc(var(--program-font-size, 11px) * 0.55);
      }
    }
  `],
})
export class StudioPlanComponent implements OnInit {
  private readonly studioPlanService = inject(StudioPlanService);

  readonly days = signal<StudioPlanDay[]>([]);
  readonly studios = STUDIOS;
  readonly programs = PROGRAMS;
  readonly colors = COLORS;
  readonly timeSlots = TIME_SLOTS;
  readonly weekOptions = this.buildWeekOptions();

  readonly viewMode = signal<'table' | 'list'>('table');
  readonly cells = signal<Record<string, StudioPlanAssignment>>({});
  readonly eraserMode = signal(false);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly lastSavedAt = signal('');

  weekStart = DEFAULT_START_DATE;
  selectedDay = DEFAULT_START_DATE;
  selectedProgram = PROGRAMS[0];
  selectedColor = COLORS[0].value;

  readonly dateRangeLabel = computed(() => {
    const days = this.days();
    if (days.length === 0) return 'Tarih aralığı seçilmedi';
    return `${days[0].date} - ${days[days.length - 1].date}`;
  });

  readonly visibleDays = computed(() => {
    return this.days();
  });

  readonly listEntries = computed(() => {
    const entries: StudioPlanListEntry[] = [];

    for (const day of this.days()) {
      for (const studio of this.studios) {
        let cursor = 0;
        while (cursor < this.timeSlots.length) {
          const time = this.timeSlots[cursor];
          const assignment = this.cells()[this.cellKey(day.id, studio, time)];
          if (!assignment) {
            cursor++;
            continue;
          }

          let endIndex = cursor + 1;
          while (endIndex < this.timeSlots.length) {
            const nextTime = this.timeSlots[endIndex];
            const nextAssignment = this.cells()[this.cellKey(day.id, studio, nextTime)];
            if (!nextAssignment || nextAssignment.program !== assignment.program || nextAssignment.color !== assignment.color) break;
            endIndex++;
          }

          entries.push({
            id: `${day.id}-${studio}-${time}`,
            dayLabel: day.label,
            dayDate: day.date,
            studio,
            startTime: time,
            endTime: this.endTimeForSlotIndex(endIndex),
            program: assignment.program,
            color: assignment.color,
            colorLabel: this.colorLabel(assignment.color),
            slotCount: endIndex - cursor,
          });

          cursor = endIndex;
        }
      }
    }

    return entries;
  });

  ngOnInit(): void {
    this.onWeekStartChange();
  }

  onWeekStartChange(): void {
    const monday = this.normalizeToMonday(this.weekStart);
    this.weekStart = monday;

    const nextDays = this.buildWeekDays(monday);
    this.days.set(nextDays);

    if (!nextDays.some((day) => day.id === this.selectedDay)) {
      this.selectedDay = nextDays[0]?.id ?? monday;
    }

    this.loadPlan(monday);
  }

  assignProgram(day: string, studio: string, time: string): void {
    const key = this.cellKey(day, studio, time);
    if (this.eraserMode()) {
      this.cells.update((cells) => {
        const next = { ...cells };
        delete next[key];
        return next;
      });
      this.saveCurrentWeek();
      return;
    }

    const program = this.selectedProgram;
    const color = this.selectedColor;

    this.cells.update((cells) => {
      const next = { ...cells };
      if (next[key]?.program === program && next[key]?.color === color) delete next[key];
      else next[key] = { program, color };
      return next;
    });
    this.saveCurrentWeek();
  }

  programAt(day: string, studio: string, time: string): string {
    return this.cells()[this.cellKey(day, studio, time)]?.program ?? '';
  }

  colorAt(day: string, studio: string, time: string): string | null {
    return this.cells()[this.cellKey(day, studio, time)]?.color ?? null;
  }

  colorLabel(value: string): string {
    return this.colors.find((color) => color.value === value)?.label ?? 'Renk';
  }

  isContinuation(day: string, studio: string, time: string): boolean {
    const program = this.programAt(day, studio, time);
    const color = this.colorAt(day, studio, time);
    const previous = this.previousTime(time);
    return !!program && !!previous && this.programAt(day, studio, previous) === program && this.colorAt(day, studio, previous) === color;
  }

  continuesProgram(day: string, studio: string, time: string): boolean {
    const program = this.programAt(day, studio, time);
    const color = this.colorAt(day, studio, time);
    const next = this.nextTime(time);
    return !!program && !!next && this.programAt(day, studio, next) === program && this.colorAt(day, studio, next) === color;
  }

  runLength(day: string, studio: string, time: string): number {
    const program = this.programAt(day, studio, time);
    if (!program || this.isContinuation(day, studio, time)) return 1;

    let length = 1;
    let cursor = this.nextTime(time);
    const color = this.colorAt(day, studio, time);
    while (cursor && this.programAt(day, studio, cursor) === program && this.colorAt(day, studio, cursor) === color) {
      length++;
      cursor = this.nextTime(cursor);
    }
    return length;
  }

  programFontSize(day: string, studio: string, time: string): number {
    const program = this.programAt(day, studio, time);
    if (!program || this.isContinuation(day, studio, time)) return 11;

    const runLength = this.runLength(day, studio, time);
    const available = Math.max(1, runLength);
    const rawSize = Math.floor((available * 80) / Math.max(program.length, 12));
    return Math.max(7, Math.min(11, rawSize));
  }

  clearSelection(): void {
    this.cells.update((cells) => {
      const next = { ...cells };
      for (const [key, value] of Object.entries(next)) {
        if (value.program === this.selectedProgram) delete next[key];
      }
      return next;
    });
    this.saveCurrentWeek();
  }

  moveCurrentWeekToNextWeek(): void {
    const sourceStart = DEFAULT_START_DATE;
    const targetStart = this.toDateInputValue(this.addDays(this.parseDateInput(sourceStart) ?? new Date(), 7));
    const sourceDays = this.buildWeekDays(sourceStart);
    const targetBySourceDay = new Map(
      sourceDays.map((day, index) => [
        day.id,
        this.toDateInputValue(this.addDays(this.parseDateInput(day.id) ?? new Date(), 7)),
      ]),
    );

    this.cells.update((cells) => {
      const next = { ...cells };

      for (const [key, value] of Object.entries(cells)) {
        const [day, studio, time] = key.split('::');
        const targetDay = targetBySourceDay.get(day);
        if (!targetDay) continue;

        next[this.cellKey(targetDay, studio, time)] = value;
        delete next[key];
      }

      return next;
    });

    this.weekStart = targetStart;
    const nextDays = this.buildWeekDays(targetStart);
    this.days.set(nextDays);
    this.selectedDay = nextDays[0]?.id ?? targetStart;
    this.viewMode.set('table');
    this.saveWeek(sourceStart, []);
    this.saveCurrentWeek();
  }

  exportPlan(): void {
    window.print();
  }

  private cellKey(day: string, studio: string, time: string): string {
    return `${day}::${studio}::${time}`;
  }

  private loadPlan(weekStart: string): void {
    this.loading.set(true);
    this.saveError.set('');
    this.studioPlanService.getPlan(weekStart)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (plan) => this.applyPlan(plan),
        error: () => this.saveError.set('Plan yüklenemedi'),
      });
  }

  private applyPlan(plan: StudioPlan): void {
    const next: Record<string, StudioPlanAssignment> = {};
    for (const slot of plan.slots) {
      next[this.cellKey(slot.day, slot.studio, slot.time)] = {
        program: slot.program,
        color: slot.color,
      };
    }
    this.cells.set(next);
    this.lastSavedAt.set(plan.updatedAt ? this.formatSaveTime(plan.updatedAt) : '');
  }

  private saveCurrentWeek(): void {
    this.saveWeek(this.weekStart, this.slotsForWeek(this.weekStart));
  }

  private saveWeek(weekStart: string, slots: StudioPlanSlot[]): void {
    this.saving.set(true);
    this.saveError.set('');
    this.studioPlanService.savePlan(weekStart, { slots })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (plan) => {
          if (plan.weekStart === this.weekStart) this.lastSavedAt.set(this.formatSaveTime(plan.updatedAt));
        },
        error: () => this.saveError.set('Plan kaydedilemedi'),
      });
  }

  private slotsForWeek(weekStart: string): StudioPlanSlot[] {
    const weekDays = new Set(this.buildWeekDays(weekStart).map((day) => day.id));
    const slots: StudioPlanSlot[] = [];

    for (const [key, value] of Object.entries(this.cells())) {
      const [day, studio, time] = key.split('::');
      if (!weekDays.has(day)) continue;

      slots.push({
        day,
        studio,
        time,
        startMinute: this.timeToMinute(time),
        program: value.program,
        color: value.color,
      });
    }

    return slots;
  }

  private timeToMinute(time: string): number {
    const [hour, minute] = time.split(':').map(Number);
    const normalizedHour = hour < 6 ? hour + 24 : hour;
    return normalizedHour * 60 + minute;
  }

  private formatSaveTime(value: string): string {
    return new Intl.DateTimeFormat('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value));
  }

  private previousTime(time: string): string | undefined {
    const index = this.timeSlots.indexOf(time);
    return index > 0 ? this.timeSlots[index - 1] : undefined;
  }

  private nextTime(time: string): string | undefined {
    const index = this.timeSlots.indexOf(time);
    return index >= 0 && index < this.timeSlots.length - 1 ? this.timeSlots[index + 1] : undefined;
  }

  private endTimeForSlotIndex(index: number): string {
    if (index < this.timeSlots.length) return this.timeSlots[index];
    return '02:00';
  }

  private buildWeekDays(startValue: string): StudioPlanDay[] {
    const start = this.parseDateInput(startValue);
    if (!start) return [];

    const days: StudioPlanDay[] = [];
    const cursor = new Date(start);

    for (let index = 0; index < 7; index++) {
      const id = this.toDateInputValue(cursor);
      days.push({
        id,
        label: DAY_LABELS[cursor.getDay()],
        date: this.formatDisplayDate(cursor),
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    return days;
  }

  private normalizeToMonday(value: string): string {
    const date = this.parseDateInput(value);
    if (!date) return DEFAULT_START_DATE;

    const day = date.getDay();
    const distanceFromMonday = day === 0 ? 6 : day - 1;
    date.setDate(date.getDate() - distanceFromMonday);
    return this.toDateInputValue(date);
  }

  private parseDateInput(value: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  private toDateInputValue(date: Date): string {
    return toDateInputValue(date);
  }

  private formatDisplayDate(date: Date): string {
    return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
  }

  private buildWeekOptions(): { label: string; value: string }[] {
    const currentMonday = this.parseDateInput(DEFAULT_START_DATE) ?? new Date();
    return [
      { label: `Geçen hafta · ${this.formatDisplayDate(this.addDays(currentMonday, -7))}`, value: this.toDateInputValue(this.addDays(currentMonday, -7)) },
      { label: `Bu hafta · ${this.formatDisplayDate(currentMonday)}`, value: this.toDateInputValue(currentMonday) },
      { label: `Gelecek hafta · ${this.formatDisplayDate(this.addDays(currentMonday, 7))}`, value: this.toDateInputValue(this.addDays(currentMonday, 7)) },
    ];
  }

  private addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }
}
