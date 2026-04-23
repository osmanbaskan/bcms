import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { finalize } from 'rxjs';
import { StudioPlanService } from '../../core/services/studio-plan.service';
import type { StudioPlan, StudioPlanSlot } from '@bcms/shared';
import { StudioPlanListComponent } from './components/studio-plan-list.component';
import { StudioPlanTableComponent } from './components/studio-plan-table.component';
import { StudioPlanToolbarComponent } from './components/studio-plan-toolbar.component';
import type {
  StudioPlanAssignment,
  StudioPlanColor,
  StudioPlanDay,
  StudioPlanListEntry,
  StudioPlanViewMode,
  StudioPlanWeekOption,
} from './studio-plan.types';

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

const DEFAULT_PROGRAMS = [
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

const DEFAULT_COLORS: StudioPlanColor[] = [
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
    MatButtonModule,
    MatIconModule,
    StudioPlanListComponent,
    StudioPlanTableComponent,
    StudioPlanToolbarComponent,
  ],
  templateUrl: './studio-plan.component.html',
  styleUrl: './studio-plan-shell.scss',
})
export class StudioPlanComponent implements OnInit {
  private readonly studioPlanService = inject(StudioPlanService);

  readonly days = signal<StudioPlanDay[]>([]);
  readonly studios = STUDIOS;
  readonly programs = signal<string[]>(DEFAULT_PROGRAMS);
  readonly colors = signal<StudioPlanColor[]>(DEFAULT_COLORS);
  readonly timeSlots = TIME_SLOTS;
  readonly weekOptions = this.buildWeekOptions();

  readonly viewMode = signal<StudioPlanViewMode>('table');
  readonly cells = signal<Record<string, StudioPlanAssignment>>({});
  readonly eraserMode = signal(false);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly lastSavedAt = signal('');

  weekStart = DEFAULT_START_DATE;
  selectedDay = DEFAULT_START_DATE;
  selectedProgram = DEFAULT_PROGRAMS[0];
  selectedColor = DEFAULT_COLORS[0].value;

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
    this.loadCatalog();
    this.onWeekStartChange();
  }

  onWeekStartChange(weekStart = this.weekStart): void {
    const monday = this.normalizeToMonday(weekStart);
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

  onCellAssign(event: { day: string; studio: string; time: string }): void {
    this.assignProgram(event.day, event.studio, event.time);
  }

  colorLabel(value: string): string {
    return this.colors().find((color) => color.value === value)?.label ?? 'Renk';
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
    const sourceStart = this.weekStart;
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
      }

      return next;
    });

    this.weekStart = targetStart;
    const nextDays = this.buildWeekDays(targetStart);
    this.days.set(nextDays);
    this.selectedDay = nextDays[0]?.id ?? targetStart;
    this.viewMode.set('table');
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

  private loadCatalog(): void {
    this.studioPlanService.getCatalog().subscribe({
      next: (catalog) => {
        const programs = catalog.programs.filter((program) => program.active).map((program) => program.name);
        const colors = catalog.colors
          .filter((color) => color.active)
          .map((color) => ({ label: color.label, value: color.value }));

        if (programs.length > 0) {
          this.programs.set(programs);
          if (!programs.includes(this.selectedProgram)) this.selectedProgram = programs[0];
        }

        if (colors.length > 0) {
          this.colors.set(colors);
          if (!colors.some((color) => color.value === this.selectedColor)) this.selectedColor = colors[0].value;
        }
      },
      error: () => this.saveError.set('Program/renk kataloğu yüklenemedi'),
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
