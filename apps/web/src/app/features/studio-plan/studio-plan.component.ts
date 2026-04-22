import { CommonModule } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';

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
const INITIAL_DAYS: StudioPlanDay[] = [
  { id: '2026-04-20', label: 'Pazartesi', date: '20.04.2026' },
  { id: '2026-04-21', label: 'Salı', date: '21.04.2026' },
  { id: '2026-04-22', label: 'Çarşamba', date: '22.04.2026' },
  { id: '2026-04-23', label: 'Perşembe', date: '23.04.2026' },
  { id: '2026-04-24', label: 'Cuma', date: '24.04.2026' },
  { id: '2026-04-25', label: 'Cumartesi', date: '25.04.2026' },
  { id: '2026-04-26', label: 'Pazar', date: '26.04.2026' },
];

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
          <mat-button-toggle value="week">Pazartesi - Pazar</mat-button-toggle>
          <mat-button-toggle value="day">Tek Gün</mat-button-toggle>
        </mat-button-toggle-group>

        <mat-form-field appearance="outline" *ngIf="viewMode() === 'day'">
          <mat-label>Gün</mat-label>
          <mat-select [(ngModel)]="selectedDay">
            <mat-option *ngFor="let day of days()" [value]="day.id">{{ day.label }} · {{ day.date }}</mat-option>
          </mat-select>
        </mat-form-field>

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
      </div>

      <div id="studio-plan-export" class="plan-shell">
        <div class="print-title">
          <strong>STÜDYO PLANI</strong>
          <span>{{ dateRangeLabel() }}</span>
        </div>

        <div class="plan-grid" [style.--day-count]="visibleDays().length">
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
export class StudioPlanComponent {
  readonly days = signal<StudioPlanDay[]>(INITIAL_DAYS);
  readonly studios = STUDIOS;
  readonly programs = PROGRAMS;
  readonly colors = COLORS;
  readonly timeSlots = TIME_SLOTS;
  readonly weekOptions = this.buildWeekOptions();

  readonly viewMode = signal<'week' | 'day'>('week');
  readonly cells = signal<Record<string, StudioPlanAssignment>>({});
  readonly eraserMode = signal(false);

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
    if (this.viewMode() === 'week') return this.days();
    return this.days().filter((day) => day.id === this.selectedDay);
  });

  onWeekStartChange(): void {
    const monday = this.normalizeToMonday(this.weekStart);
    this.weekStart = monday;

    const nextDays = this.buildWeekDays(monday);
    this.days.set(nextDays);

    if (!nextDays.some((day) => day.id === this.selectedDay)) {
      this.selectedDay = nextDays[0]?.id ?? monday;
    }
  }

  assignProgram(day: string, studio: string, time: string): void {
    const key = this.cellKey(day, studio, time);
    if (this.eraserMode()) {
      this.cells.update((cells) => {
        const next = { ...cells };
        delete next[key];
        return next;
      });
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
    this.viewMode.set('week');
  }

  exportPlan(): void {
    window.print();
  }

  private cellKey(day: string, studio: string, time: string): string {
    return `${day}::${studio}::${time}`;
  }

  private previousTime(time: string): string | undefined {
    const index = this.timeSlots.indexOf(time);
    return index > 0 ? this.timeSlots[index - 1] : undefined;
  }

  private nextTime(time: string): string | undefined {
    const index = this.timeSlots.indexOf(time);
    return index >= 0 && index < this.timeSlots.length - 1 ? this.timeSlots[index + 1] : undefined;
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
