import { CommonModule } from '@angular/common';
import { Component, HostListener, OnInit, OnDestroy, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { KeycloakService } from 'keycloak-angular';
import { Subject, Subscription, debounceTime, switchMap, finalize, tap } from 'rxjs';
import ExcelJS from 'exceljs';
import { StudioPlanService } from '../../core/services/studio-plan.service';
import { GROUP } from '@bcms/shared';
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

/** Stüdyo planını düzenleyebilen gruplar.
 *  2026-05-01: SystemEng kaldırıldı — sadece Admin + StudyoSefi.
 *  PERMISSIONS.studioPlans.write/delete ile hizalı. */
const STUDIO_EDIT_GROUPS = [GROUP.Admin, GROUP.StudyoSefi];

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
export class StudioPlanComponent implements OnInit, OnDestroy {
  private readonly saveTrigger$ = new Subject<void>();
  private saveSub?: Subscription;
  private readonly studioPlanService = inject(StudioPlanService);
  private readonly keycloak = inject(KeycloakService);

  readonly canEdit = computed(() => {
    const parsed = this.keycloak.getKeycloakInstance().tokenParsed as { groups?: string[] } | undefined;
    const userGroups: string[] = parsed?.groups ?? [];
    if (userGroups.includes(GROUP.Admin)) return true;
    return STUDIO_EDIT_GROUPS.some((g) => userGroups.includes(g));
  });

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
  readonly fullscreenActive = signal(false);

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
    const today = toDateInputValue(new Date());

    for (const day of this.days()) {
      if (day.id < today) continue;
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
    if (!this.canEdit()) {
      this.viewMode.set('list');
    }
    this.loadCatalog();
    this.onWeekStartChange();

    this.saveSub = this.saveTrigger$
      .pipe(
        debounceTime(400),
        tap(() => {
          this.saving.set(true);
          this.saveError.set('');
        }),
        switchMap(() => {
          const weekStart = this.weekStart;
          const slots = this.slotsForWeek(weekStart);
          return this.studioPlanService.savePlan(weekStart, { slots }).pipe(
            finalize(() => this.saving.set(false)),
          );
        }),
      )
      .subscribe({
        next: (plan) => {
          if (plan.weekStart === this.weekStart) {
            this.lastSavedAt.set(this.formatSaveTime(plan.updatedAt));
          }
        },
        error: () => this.saveError.set('Plan kaydedilemedi'),
      });
  }

  ngOnDestroy(): void {
    this.saveSub?.unsubscribe();
    this.saveTrigger$.complete();
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
    const exportNode = document.getElementById('studio-plan-export');
    if (!exportNode) return;

    const printWindow = window.open('', '_blank', 'width=1600,height=1000');
    if (!printWindow) {
      window.print();
      return;
    }
    printWindow.opener = null;

    const printNode = exportNode.cloneNode(true) as HTMLElement;
    printNode.querySelectorAll('.no-print').forEach((node) => node.remove());

    printWindow.document.open();
    printWindow.document.write(this.buildPrintDocument(printNode.outerHTML));
    printWindow.document.close();
    printWindow.focus();

    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 250);
  }

  async exportToExcel(): Promise<void> {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Stüdyo Planı');

    if (this.viewMode() === 'list') {
      worksheet.columns = [
        { header: 'Gün', key: 'dayLabel', width: 12 },
        { header: 'Tarih', key: 'dayDate', width: 14 },
        { header: 'Stüdyo', key: 'studio', width: 14 },
        { header: 'Başlangıç', key: 'startTime', width: 12 },
        { header: 'Bitiş', key: 'endTime', width: 12 },
        { header: 'Program', key: 'program', width: 35 },
        { header: 'Renk', key: 'colorLabel', width: 14 },
        { header: 'Slot Sayısı', key: 'slotCount', width: 12 },
      ];

      for (const entry of this.listEntries()) {
        const row = worksheet.addRow({ ...entry });
        const argb = this.hexToArgb(entry.color);
        if (argb !== 'FFFFFFFF') {
          row.getCell('program').fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb },
          };
        }
      }
    } else {
      const days = this.visibleDays();
      const studios = this.studios;
      const timeSlots = this.timeSlots;
      const totalCols = 1 + days.length * studios.length;

      const HEADER_BG = 'FF43206D';
      const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true };
      const BORDER = {
        top: { style: 'thin' as const, color: { argb: 'FF111827' } },
        left: { style: 'thin' as const, color: { argb: 'FF111827' } },
        bottom: { style: 'thin' as const, color: { argb: 'FF111827' } },
        right: { style: 'thin' as const, color: { argb: 'FF111827' } },
      };

      // Row 1: corner + day headers (merged)
      const headerRow1 = worksheet.addRow(new Array(totalCols).fill(''));
      headerRow1.getCell(1).value = 'Saat';
      let col = 2;
      for (const day of days) {
        const startCol = col;
        const endCol = col + studios.length - 1;
        headerRow1.getCell(startCol).value = `${day.label} · ${day.date}`;
        worksheet.mergeCells(1, startCol, 1, endCol);
        col = endCol + 1;
      }
      for (let i = 1; i <= totalCols; i++) {
        const cell = headerRow1.getCell(i);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
        cell.font = HEADER_FONT;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = BORDER;
      }

      // Row 2: empty + studio headers
      const headerRow2 = worksheet.addRow(new Array(totalCols).fill(''));
      headerRow2.getCell(1).value = '';
      let sCol = 2;
      for (const _day of days) {
        for (const studio of studios) {
          headerRow2.getCell(sCol).value = studio;
          sCol++;
        }
      }
      for (let i = 1; i <= totalCols; i++) {
        const cell = headerRow2.getCell(i);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
        cell.font = HEADER_FONT;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = BORDER;
      }

      // Data rows
      for (let i = 0; i < timeSlots.length; i++) {
        const time = timeSlots[i];
        const row = worksheet.addRow([time]);
        const timeCell = row.getCell(1);
        timeCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
        timeCell.font = HEADER_FONT;
        timeCell.alignment = { horizontal: 'center', vertical: 'middle' };
        timeCell.border = BORDER;

        let c = 2;
        for (const day of days) {
          for (const studio of studios) {
            const key = this.cellKey(day.id, studio, time);
            const assignment = this.cells()[key];
            const cell = row.getCell(c);
            cell.border = BORDER;
            if (assignment) {
              cell.value = assignment.program;
              const argb = this.hexToArgb(assignment.color);
              if (argb !== 'FFFFFFFF') {
                cell.fill = {
                  type: 'pattern',
                  pattern: 'solid',
                  fgColor: { argb },
                };
              }
            }
            c++;
          }
        }
      }

      // Slot merge: merge consecutive same-program slots per day+studio column
      let mergeCol = 2;
      for (const day of days) {
        for (const studio of studios) {
          let mergeStart = -1;
          let mergeProgram = '';
          let mergeColor = '';

          for (let i = 0; i < timeSlots.length; i++) {
            const time = timeSlots[i];
            const key = this.cellKey(day.id, studio, time);
            const assignment = this.cells()[key];

            if (assignment && assignment.program === mergeProgram && assignment.color === mergeColor) {
              continue;
            } else {
              if (mergeStart !== -1 && i - mergeStart > 1) {
                worksheet.mergeCells(3 + mergeStart, mergeCol, 3 + i - 1, mergeCol);
                const mergedCell = worksheet.getRow(3 + mergeStart).getCell(mergeCol);
                mergedCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
              }
              mergeStart = assignment ? i : -1;
              mergeProgram = assignment?.program ?? '';
              mergeColor = assignment?.color ?? '';
            }
          }
          if (mergeStart !== -1 && timeSlots.length - mergeStart > 1) {
            worksheet.mergeCells(3 + mergeStart, mergeCol, 3 + timeSlots.length - 1, mergeCol);
            const mergedCell = worksheet.getRow(3 + mergeStart).getCell(mergeCol);
            mergedCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
          }
          mergeCol++;
        }
      }

      // Auto-width heuristic
      worksheet.columns.forEach((colDef, idx) => {
        if (idx === 0) {
          colDef.width = 10;
        } else {
          colDef.width = 16;
        }
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Stüdyo-Planı-${this.weekStart}.xlsx`;
    a.click();
    window.URL.revokeObjectURL(url);
  }

  private hexToArgb(hex: string | undefined | null): string {
    if (!hex || typeof hex !== 'string') return 'FFFFFFFF';
    const clean = hex.replace('#', '').trim();
    if (!clean) return 'FFFFFFFF';
    if (clean.length === 8) return clean.toUpperCase();
    if (clean.length === 6) return `FF${clean.toUpperCase()}`;
    if (clean.length === 3) {
      const expanded = clean.split('').map((c) => c + c).join('');
      return `FF${expanded.toUpperCase()}`;
    }
    return 'FFFFFFFF';
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    this.fullscreenActive.set(document.fullscreenElement?.id === 'studio-plan-export');
  }

  async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement?.id === 'studio-plan-export') {
      await document.exitFullscreen();
      return;
    }
    await document.getElementById('studio-plan-export')?.requestFullscreen();
  }

  private buildPrintDocument(planHtml: string): string {
    const styles = Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]'))
      .map((node) => node.outerHTML)
      .join('\n');

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Stüdyo Planı</title>
  ${styles}
  <style>
    @page {
      size: A3 landscape;
      margin: 0;
    }

    html,
    body {
      width: 420mm;
      height: 297mm;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: #fff;
    }

    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    body {
      display: block;
    }

    #studio-plan-export {
      display: block !important;
      width: 420mm !important;
      height: 297mm !important;
      min-height: 0 !important;
      margin: 0 !important;
      border: 0 !important;
      overflow: hidden !important;
      background: #fff !important;
    }

    #studio-plan-export .print-title {
      height: 8mm !important;
      min-width: 0 !important;
      padding: 1mm 3mm !important;
    }

    #studio-plan-export app-studio-plan-table {
      display: block !important;
      width: 420mm !important;
      height: calc(297mm - 10mm) !important;
      overflow: hidden !important;
    }

    #studio-plan-export .plan-grid {
      --cell-width: minmax(0, 1fr);
      --time-width: 18mm;
      display: grid !important;
      grid-template-columns: var(--time-width) repeat(calc(var(--day-count) * 5), var(--cell-width)) !important;
      grid-template-rows: 8mm 11mm repeat(var(--slot-count), minmax(0, 1fr)) !important;
      width: 420mm !important;
      height: calc(297mm - 10mm) !important;
      min-width: 0 !important;
      font-size: 6px !important;
    }

    #studio-plan-export .corner-cell,
    #studio-plan-export .day-header,
    #studio-plan-export .studio-header,
    #studio-plan-export .time-cell,
    #studio-plan-export .slot-cell {
      min-height: 0 !important;
      position: static !important;
    }

    #studio-plan-export .day-header {
      padding: 1px !important;
    }

    #studio-plan-export .studio-header {
      padding: 1px !important;
      font-size: 5px !important;
      writing-mode: vertical-rl;
      transform: rotate(180deg);
    }

    #studio-plan-export .time-cell,
    #studio-plan-export .slot-cell {
      padding: 0 1px !important;
    }

    #studio-plan-export .slot-cell {
      appearance: none;
    }

    #studio-plan-export .slot-cell span {
      min-height: calc(var(--run-slots, 1) * ((100% - 19mm) / var(--slot-count)) - 2px) !important;
      font-size: calc(var(--program-font-size, 11px) * 0.5) !important;
      line-height: 1 !important;
    }
  </style>
</head>
<body>${planHtml}</body>
</html>`;
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
    this.saveTrigger$.next();
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
