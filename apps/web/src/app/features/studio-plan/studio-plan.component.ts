import { CommonModule } from '@angular/common';
import { Component, ElementRef, HostListener, OnInit, OnDestroy, ViewChild, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { KeycloakService } from 'keycloak-angular';
import { Subject, Subscription, debounceTime, switchMap, finalize, tap } from 'rxjs';
import ExcelJS from 'exceljs';
import { ApiService } from '../../core/services/api.service';
import { StudioPlanService } from '../../core/services/studio-plan.service';
import { formatIstanbulTime } from '../../core/time/tz.helpers';
import { firstValueFrom } from 'rxjs';
import { GROUP } from '@bcms/shared';
import type { StudioPlan, StudioPlanSlot } from '@bcms/shared';
import { StudioPlanListComponent } from './components/studio-plan-list.component';
import { StudioPlanTableComponent } from './components/studio-plan-table.component';
import { StudioPlanToolbarComponent } from './components/studio-plan-toolbar.component';
import {
  buildSlotsForRange,
  type StudioPlanAssignment,
  type StudioPlanColor,
  type StudioPlanDay,
  type StudioPlanListEntry,
  type StudioPlanViewMode,
  type StudioPlanWeekOption,
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

// 2026-05-14: Studio plan slot çözünürlüğü 30 dk → 15 dk. Mevcut DB modeli
// (studio_plan_slots.start_minute INT) 15 dk için zaten yeterli; migration
// gerekmez. Eski 30 dk kayıtlar yeni gridde tek 15 dk slot olarak görünür.
export const STUDIO_PLAN_SLOT_MINUTES = 15;
// 2026-05-25 (rev): per-week settings'le birlikte default time range artık
// 07:00-03:00 (önceden 06:00-02:00). Bu sabitler **fallback** olarak kullanılır;
// gerçek grid `buildSlotsForRange()` ile dinamik hesaplanır. Eski tüketici
// kodlar için global TIME_SLOTS export'u korundu (Excel export legacy yol).
export const STUDIO_PLAN_DEFAULT_START = '07:00';
export const STUDIO_PLAN_DEFAULT_END   = '03:00';

// Geriye dönük uyumluluk — admin edit'in info notları ve diğer
// tüketiciler için sabit saat dakikaları. Yeni çalışmalar `buildSlotsForRange`
// kullanmalı.
export const STUDIO_PLAN_START_MINUTE = 7 * 60;    // 07:00
export const STUDIO_PLAN_END_MINUTE   = 27 * 60;   // 03:00 ertesi gün

const TIME_SLOTS = buildSlotsForRange(STUDIO_PLAN_DEFAULT_START, STUDIO_PLAN_DEFAULT_END, STUDIO_PLAN_SLOT_MINUTES);

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
  private readonly api = inject(ApiService);
  private readonly keycloak = inject(KeycloakService);

  /** Reactive userGroups signal — ngOnInit'te tokenParsed'dan set edilir.
   *  Eski sürüm computed içinde non-reactive okuyorduk; signal pattern
   *  app.component.ts ve schedule-list.component.ts ile tutarlı. */
  private readonly _userGroups = signal<string[]>([]);

  readonly canEdit = computed(() => {
    const userGroups = this._userGroups();
    if (userGroups.includes(GROUP.Admin)) return true;
    return STUDIO_EDIT_GROUPS.some((g) => userGroups.includes(g));
  });

  readonly days = signal<StudioPlanDay[]>([]);
  readonly studios = STUDIOS;
  readonly programs = signal<string[]>(DEFAULT_PROGRAMS);
  readonly colors = signal<StudioPlanColor[]>(DEFAULT_COLORS);
  // 2026-05-25: hafta bazlı time range — admin edit sayfası persist eder,
  // burada GET /studio-plans/:weekStart/settings ile yüklenir; grid bu
  // signal'e göre dinamik üretilir.
  readonly weekTimeRangeStart = signal(STUDIO_PLAN_DEFAULT_START);
  readonly weekTimeRangeEnd   = signal(STUDIO_PLAN_DEFAULT_END);
  readonly timeSlots = computed<string[]>(() => buildSlotsForRange(
    this.weekTimeRangeStart(), this.weekTimeRangeEnd(), STUDIO_PLAN_SLOT_MINUTES,
  ));
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

    // 2026-05-14: Liste tablo ile aynı `cells()` canonical signal'ından üretilir.
    // Daha önce burada `if (day.id < today) continue;` ile geçmiş günler
    // dışlanıyordu — tabloda gözüken Pazartesi/Salı programları listede
    // görünmüyordu. Tablo + liste aynı haftanın tamamını göstermeli.
    for (const day of this.days()) {
      for (const studio of this.studios) {
        let cursor = 0;
        while (cursor < this.timeSlots().length) {
          const time = this.timeSlots()[cursor];
          const assignment = this.cells()[this.cellKey(day.id, studio, time)];
          if (!assignment) {
            cursor++;
            continue;
          }

          let endIndex = cursor + 1;
          while (endIndex < this.timeSlots().length) {
            const nextTime = this.timeSlots()[endIndex];
            const nextAssignment = this.cells()[this.cellKey(day.id, studio, nextTime)];
            if (!nextAssignment || nextAssignment.program !== assignment.program || nextAssignment.color !== assignment.color) break;
            endIndex++;
          }

          const slotCount = endIndex - cursor;
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
            slotCount,
            durationMinutes: slotCount * STUDIO_PLAN_SLOT_MINUTES,
          });

          cursor = endIndex;
        }
      }
    }

    return entries;
  });

  ngOnInit(): void {
    // tokenParsed'dan grupları oku ve signal'e set et — canEdit reactive olur
    const parsed = this.keycloak.getKeycloakInstance()?.tokenParsed as { groups?: string[] } | undefined;
    this._userGroups.set(parsed?.groups ?? []);
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
    // 2026-05-14: auto-pan RAF loop'u memory leak bırakmasın.
    this.stopAutoPanLoop();
  }

  onWeekStartChange(weekStart = this.weekStart): void {
    const monday = this.normalizeToMonday(weekStart);
    this.weekStart = monday;

    const nextDays = this.buildWeekDays(monday);
    this.days.set(nextDays);

    if (!nextDays.some((day) => day.id === this.selectedDay)) {
      this.selectedDay = nextDays[0]?.id ?? monday;
    }

    void this.loadWeekSettings(monday);
    this.loadPlan(monday);
  }

  /** 2026-05-25: hafta bazlı time range — admin edit sayfası persist eder;
   *  ana grid bu signal'a göre dinamik üretilir. Kayıt yoksa default 07:00-03:00. */
  private async loadWeekSettings(weekStart: string): Promise<void> {
    try {
      const dto = await firstValueFrom(
        this.api.get<{ timeRangeStart: string; timeRangeEnd: string; persisted: boolean }>(
          `/studio-plans/${weekStart}/settings`,
        ),
      );
      this.weekTimeRangeStart.set(dto.timeRangeStart);
      this.weekTimeRangeEnd.set(dto.timeRangeEnd);
    } catch {
      // Sessiz fallback — default range zaten signal'da
      this.weekTimeRangeStart.set(STUDIO_PLAN_DEFAULT_START);
      this.weekTimeRangeEnd.set(STUDIO_PLAN_DEFAULT_END);
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
      // 2026-05-14: 15 dk slot dönüşümü — list export'a `Süre (dk)` kolonu
      // eklendi (`durationMinutes = slotCount * STUDIO_PLAN_SLOT_MINUTES`).
      // `Slot Sayısı` operatör için referans bilgi olarak korundu.
      worksheet.columns = [
        { header: 'Gün', key: 'dayLabel', width: 12 },
        { header: 'Tarih', key: 'dayDate', width: 14 },
        { header: 'Stüdyo', key: 'studio', width: 14 },
        { header: 'Başlangıç', key: 'startTime', width: 12 },
        { header: 'Bitiş', key: 'endTime', width: 12 },
        { header: 'Program', key: 'program', width: 35 },
        { header: 'Renk', key: 'colorLabel', width: 14 },
        { header: 'Slot Sayısı', key: 'slotCount', width: 12 },
        { header: 'Süre (dk)', key: 'durationMinutes', width: 12 },
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
      // ──────────────────────────────────────────────────────────────────────
      // 2026-05-25: Excel export layout referans Excel→PDF çıktısına uyacak
      // şekilde yeniden tasarlandı. Referans:
      //   `STÜDYO PLAN 25.05.2026 - 01.06.2026.pdf` (Microsoft Excel for M365)
      //
      // Yapı (referansla bire bir):
      //   - 8 gün (Pazartesi → ertesi haftanın Pazartesi günü dahil)
      //   - Her gün için 8 alt-kolon: [Saat] [Slot] [STD1] [STD2] [STD3] [STD4]
      //     [BEIN GURME] [OUTSIDE] — toplam 64 kolon
      //   - 3 satır header: tarih (dd.MM.yy), gün adı (İngilizce büyük),
      //     "TIME" + dikey (textRotation 90) stüdyo başlıkları
      //   - 4 × 15 dk slot per saat: saat kolonu 4 satır merged + slot kolonu
      //     "00 - 15'", "15' - 30'", "30' - 45", "45' - 00'"
      //   - Mor header (#43206D), beyaz bold yazı
      //   - Page setup: A3 landscape, fitToPage 1×1, küçük margin
      // PDF butonu (`exportPlan` → window.print) dokunulmadı; bu yalnız
      // ExcelJS workbook table-branch refactoru. Liste view (`viewMode='list'`)
      // de dokunulmadı.
      // ──────────────────────────────────────────────────────────────────────
      const baseDays = this.visibleDays();
      // 8. gün — sonraki haftanın Pazartesi (referans pattern: Mon-Mon span)
      const nextMonday = (() => {
        const last = baseDays[baseDays.length - 1];
        if (!last) return null;
        const [y, m, d] = last.id.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d + 1));
        const iso = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
        return { id: iso, label: 'Pazartesi', date: iso.split('-').reverse().join('.') };
      })();
      const days = nextMonday ? [...baseDays, nextMonday] : baseDays;
      // Export-only: studio listesine OUTSIDE eklenir (referansta var; domain'de
      // gerçek stüdyo değil, sadece export grid'i için sahte kolon — boş kalır).
      const exportStudios = [...this.studios, 'OUTSIDE'];
      const SUB_COLS_PER_DAY = 2 + exportStudios.length; // [saat][slot] + N stüdyo = 8
      const totalCols = days.length * SUB_COLS_PER_DAY;

      const timeSlots = this.timeSlots();
      const SLOTS_PER_HOUR = 60 / STUDIO_PLAN_SLOT_MINUTES; // 4
      const hourCount = timeSlots.length / SLOTS_PER_HOUR;

      // 2026-05-25 referans PDF rect örneklemesi:
      //   - Saat col + header bg: #6F2F9F (parlak mor) — pdfplumber rect rgb
      //     (0.439, 0.188, 0.627). Mevcut #43206D yerine düzeltildi.
      //   - Saat 8 alternating bg: #D8E2BC (rgb 0.847, 0.894, 0.737). Mevcut
      //     #E8F0D8 yerine düzeltildi.
      const HEADER_BG = 'FF6F2F9F';
      const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true };
      const SLOT_BG_EVEN = 'FFFFFFFF';      // beyaz (referans saat 7 satırları)
      const SLOT_BG_ODD  = 'FFD8E2BC';      // açık sarı-yeşil (referans saat 8 satırları)
      const BORDER = {
        top:    { style: 'thin' as const, color: { argb: 'FF666666' } },
        left:   { style: 'thin' as const, color: { argb: 'FF666666' } },
        bottom: { style: 'thin' as const, color: { argb: 'FF666666' } },
        right:  { style: 'thin' as const, color: { argb: 'FF666666' } },
      };

      // İngilizce gün adı (referansla aynı: MONDAY, TUESDAY, ...)
      const enDay = (id: string): string => {
        const [y, m, d] = id.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        return ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][dt.getUTCDay()];
      };
      // dd.MM.yy formatı (referans: 25.05.26)
      const shortDate = (id: string): string => {
        const [y, m, d] = id.split('-');
        return `${d}.${m}.${y.slice(2)}`;
      };

      // ── Header Row 1: tarih (dd.MM.yy) — her gün için 6 stüdyo üstüne merged
      const row1 = worksheet.addRow(new Array(totalCols).fill(''));
      // ── Header Row 2: İngilizce gün adı — her gün için 6 stüdyo üstüne merged
      const row2 = worksheet.addRow(new Array(totalCols).fill(''));
      // ── Header Row 3: TIME (2 col merged) + dikey stüdyo başlıkları
      const row3 = worksheet.addRow(new Array(totalCols).fill(''));

      for (let di = 0; di < days.length; di++) {
        const day = days[di];
        const colStart = di * SUB_COLS_PER_DAY + 1;
        const timeColStart = colStart;
        const slotCol = colStart + 1;
        const studio1Col = colStart + 2;
        const dayBlockEnd = colStart + SUB_COLS_PER_DAY - 1;

        // Row 1: tarih sadece stüdyo başlıklarının üstünde merged
        row1.getCell(studio1Col).value = shortDate(day.id);
        worksheet.mergeCells(1, studio1Col, 1, dayBlockEnd);

        // Row 2: gün adı stüdyo başlıklarının üstünde merged
        row2.getCell(studio1Col).value = enDay(day.id);
        worksheet.mergeCells(2, studio1Col, 2, dayBlockEnd);

        // Row 3: "TIME" merged 2-col (saat+slot kolonlarının üstü)
        row3.getCell(timeColStart).value = 'TIME';
        worksheet.mergeCells(3, timeColStart, 3, slotCol);

        // Row 3: stüdyo başlıkları dikey
        for (let si = 0; si < exportStudios.length; si++) {
          const cell = row3.getCell(studio1Col + si);
          const name = exportStudios[si];
          // Referans pattern: "BEIN SPORTS / STUDIO 1" — domain Turkish naming'i
          // operasyonel export label'ına dönüştürülür (sadece export, in-app
          // state'i etkilemez).
          cell.value = this.exportStudioLabel(name);
        }
      }

      // Tüm header satırlarına ortak stil (mor BG + beyaz bold)
      for (const row of [row1, row2, row3]) {
        for (let i = 1; i <= totalCols; i++) {
          const cell = row.getCell(i);
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
          cell.font = { ...HEADER_FONT, size: row === row1 ? 14 : row === row2 ? 11 : 9, name: 'Arial' };
          cell.alignment = row === row3
            ? { horizontal: 'center', vertical: 'middle', textRotation: 90, wrapText: true }
            : { horizontal: 'center', vertical: 'middle', wrapText: true };
          cell.border = BORDER;
        }
      }
      // Row 3 "TIME" merged hücresi dikey değil, yatay olsun
      row3.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
      row1.height = 28;
      row2.height = 22;
      row3.height = 90; // dikey stüdyo başlıkları için

      // ── Data rows: her saat için 4 slot
      const SLOT_LABELS = ['00 - 15′', '15′ - 30′', '30′ - 45', '45′ - 00′'];
      for (let hi = 0; hi < hourCount; hi++) {
        const hourBase = timeSlots[hi * SLOTS_PER_HOUR];                  // "06:00", "07:00", ...
        const hourNum = parseInt(hourBase.split(':')[0], 10);
        const isEven = hi % 2 === 0;
        const rowBg = isEven ? SLOT_BG_EVEN : SLOT_BG_ODD;

        for (let s = 0; s < SLOTS_PER_HOUR; s++) {
          const slotIdx = hi * SLOTS_PER_HOUR + s;
          const time = timeSlots[slotIdx];
          const row = worksheet.addRow(new Array(totalCols).fill(''));
          row.height = 14;

          for (let di = 0; di < days.length; di++) {
            const day = days[di];
            const colStart = di * SUB_COLS_PER_DAY + 1;
            const hourCol = colStart;
            const slotCol = colStart + 1;
            const studio1Col = colStart + 2;

            // Saat kolonu: ilk slot satırına büyük rakam, sonra merged 4 satır
            const hourCell = row.getCell(hourCol);
            if (s === 0) {
              hourCell.value = hourNum;
            }
            hourCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
            hourCell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 14, name: 'Arial' };
            hourCell.alignment = { horizontal: 'center', vertical: 'middle' };
            hourCell.border = BORDER;

            // Slot kolonu: "00 - 15'" vs.
            // 2026-05-25 düzeltme: referans PDF'te TIME alanı iki sub-col birlikte
            // tek mor bant (saat rakamı + slot label aynı HEADER_BG, beyaz text).
            // Alternating rowBg sadece stüdyo data hücrelerinde — slot col DAHİL DEĞİL.
            const slotCell = row.getCell(slotCol);
            slotCell.value = SLOT_LABELS[s];
            slotCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
            slotCell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 9, name: 'Arial' };
            slotCell.alignment = { horizontal: 'center', vertical: 'middle' };
            slotCell.border = BORDER;

            // Stüdyo hücreleri
            for (let si = 0; si < exportStudios.length; si++) {
              const studio = exportStudios[si];
              const cell = row.getCell(studio1Col + si);
              cell.border = BORDER;
              cell.font = { size: 8, name: 'Arial' };
              cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
              // OUTSIDE export-only sahte kolon — assignment'ları yok
              if (studio !== 'OUTSIDE') {
                const key = this.cellKey(day.id, studio, time);
                const assignment = this.cells()[key];
                if (assignment) {
                  cell.value = assignment.program;
                  const argb = this.hexToArgb(assignment.color);
                  if (argb !== 'FFFFFFFF') {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
                  } else {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
                  }
                } else {
                  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
                }
              } else {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
              }
            }
          }
        }

        // Aynı saat blokunda her gün için saat kolonunu merged (4 satır)
        const blockStart = 4 + hi * SLOTS_PER_HOUR;
        for (let di = 0; di < days.length; di++) {
          const colStart = di * SUB_COLS_PER_DAY + 1;
          const hourCol = colStart;
          worksheet.mergeCells(blockStart, hourCol, blockStart + SLOTS_PER_HOUR - 1, hourCol);
        }
      }

      // ── Aynı program merge — her gün × her stüdyo kolonu için ardışık aynı
      // (program+renk) hücreleri merged. Saat/slot kolonları merged değil.
      const DATA_ROW_OFFSET = 4; // header 3 satır + 1-based
      for (let di = 0; di < days.length; di++) {
        const day = days[di];
        const colStart = di * SUB_COLS_PER_DAY + 1;
        for (let si = 0; si < exportStudios.length; si++) {
          const studio = exportStudios[si];
          if (studio === 'OUTSIDE') continue;
          const studioCol = colStart + 2 + si;

          let mergeStart = -1;
          let mergeProgram = '';
          let mergeColor = '';
          for (let i = 0; i <= timeSlots.length; i++) {
            const time = timeSlots[i];
            const key = i < timeSlots.length ? this.cellKey(day.id, studio, time) : '';
            const assignment = i < timeSlots.length ? this.cells()[key] : undefined;
            const sameAsCurrent = assignment && assignment.program === mergeProgram && assignment.color === mergeColor;
            if (sameAsCurrent) continue;
            if (mergeStart !== -1 && i - mergeStart > 1) {
              worksheet.mergeCells(
                DATA_ROW_OFFSET + mergeStart, studioCol,
                DATA_ROW_OFFSET + i - 1, studioCol,
              );
              const mergedCell = worksheet.getRow(DATA_ROW_OFFSET + mergeStart).getCell(studioCol);
              mergedCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            }
            mergeStart = assignment ? i : -1;
            mergeProgram = assignment?.program ?? '';
            mergeColor = assignment?.color ?? '';
          }
        }
      }

      // ── Column widths (referans pattern: saat kolonu dar, stüdyo orta)
      for (let di = 0; di < days.length; di++) {
        const colStart = di * SUB_COLS_PER_DAY + 1;
        // Saat (sadece 1-2 hane rakam)
        worksheet.getColumn(colStart).width = 4;
        // Slot (örn. "00 - 15'" 8 karakter)
        worksheet.getColumn(colStart + 1).width = 8.5;
        // Stüdyolar (dikey textRotation 90; içerik program adı wrap)
        for (let si = 0; si < exportStudios.length; si++) {
          worksheet.getColumn(colStart + 2 + si).width = 5;
        }
      }

      // ── Footer: renk legend (referans pattern — alt kenarda renkli kutular)
      const legendRowIdx = 3 + timeSlots.length + 1;  // 1 satır boşluk
      const legend = this.colors();
      if (legend.length > 0) {
        const legendRow = worksheet.addRow(new Array(totalCols).fill(''));
        legendRow.height = 18;
        // 2 sub-col genişlikte renk kutu + 4 sub-col label
        const PAIR = 6;
        const PAIR_COLOR_WIDTH = 2;
        for (let i = 0; i < legend.length; i++) {
          const baseCol = 1 + i * PAIR;
          if (baseCol + PAIR - 1 > totalCols) break;
          // Renk kutusu
          const colorCell = legendRow.getCell(baseCol);
          colorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.hexToArgb(legend[i].value) } };
          colorCell.border = BORDER;
          worksheet.mergeCells(legendRowIdx, baseCol, legendRowIdx, baseCol + PAIR_COLOR_WIDTH - 1);
          // Label
          const labelCell = legendRow.getCell(baseCol + PAIR_COLOR_WIDTH);
          labelCell.value = legend[i].label;
          labelCell.font = { size: 9, bold: true, name: 'Arial', color: { argb: 'FF1F1B2D' } };
          labelCell.alignment = { horizontal: 'left', vertical: 'middle' };
          worksheet.mergeCells(legendRowIdx, baseCol + PAIR_COLOR_WIDTH, legendRowIdx, baseCol + PAIR - 1);
        }
      }

      // ── Page setup: A3 landscape, fitToPage 1×1, küçük margin
      // A3 = ECMA-376 paperSize 8; ExcelJS enum'da explicit yok → numeric cast.
      worksheet.pageSetup = {
        paperSize: 8 as unknown as ExcelJS.Worksheet['pageSetup']['paperSize'],
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 1,
        horizontalCentered: true,
        verticalCentered: true,
        margins: {
          left: 0.2, right: 0.2, top: 0.3, bottom: 0.3,
          header: 0.1, footer: 0.1,
        },
      };
      worksheet.views = [{ showGridLines: false }];
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.buildExportFileName();
    a.click();
    window.URL.revokeObjectURL(url);
  }

  /** Referans dosya adı pattern: "STÜDYO PLAN <start> - <end>.xlsx"
   *  (referans PDF: "STÜDYO PLAN 25.05.2026 - 01.06.2026.pdf"). 8 günlük
   *  Pazartesi→Pazartesi aralığı; list view tek tarih kullanır. */
  private buildExportFileName(): string {
    if (this.viewMode() === 'list') {
      return `Stüdyo-Planı-${this.weekStart}.xlsx`;
    }
    const days = this.visibleDays();
    if (days.length === 0) return `Stüdyo-Planı-${this.weekStart}.xlsx`;
    const first = days[0];
    const last = days[days.length - 1];
    const [ly, lm, ld] = last.id.split('-').map(Number);
    const nextMon = new Date(Date.UTC(ly, lm - 1, ld + 1));
    const fmt = (id: string) => id.split('-').reverse().join('.');
    const fmtDt = `${String(nextMon.getUTCDate()).padStart(2,'0')}.${String(nextMon.getUTCMonth()+1).padStart(2,'0')}.${nextMon.getUTCFullYear()}`;
    return `STÜDYO PLAN ${fmt(first.id)} - ${fmtDt}.xlsx`;
  }

  /** Domain stüdyo adı → referans export label.
   *  "Stüdyo 1"   → "BEIN SPORTS / STUDIO 1"
   *  "beIN Gurme" → "BEIN GURME / STUDIO"
   *  "OUTSIDE"    → "OUTSIDE"  (export-only sahte kolon)
   */
  private exportStudioLabel(name: string): string {
    if (name === 'OUTSIDE') return 'OUTSIDE';
    if (/^st[üu]dyo\s*(\d+)$/i.test(name)) {
      const n = name.match(/(\d+)/)?.[1] ?? '';
      return `BEIN SPORTS / STUDIO ${n}`;
    }
    if (/gurme/i.test(name)) return 'BEIN GURME / STUDIO';
    return name.toUpperCase();
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
    const active = document.fullscreenElement?.id === 'studio-plan-export';
    this.fullscreenActive.set(active);
    if (!active) {
      // 2026-05-14: fullscreen kapanınca auto-pan loop'u temizle.
      this.autoPanState = { dx: 0, dy: 0 };
      this.stopAutoPanLoop();
    }
  }

  async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement?.id === 'studio-plan-export') {
      await document.exitFullscreen();
      return;
    }
    await document.getElementById('studio-plan-export')?.requestFullscreen();
  }

  // ── 2026-05-14: Fullscreen edit mode'da mouse-edge auto-pan ───────────────
  //
  // Pointer fullscreen container'ın kenarına yaklaştıkça yatay (ve opsiyonel
  // dikey) scroll otomatik tetiklenir. Sadece:
  //   - fullscreenActive() === true
  //   - viewMode() === 'table' (liste mode kapsam dışı)
  //   - canEdit() === true (readonly görüntüleyici için anlamsız)
  //   - touch/coarse pointer DEĞİL
  // koşullarında çalışır. Native scroll ile çakışmaz (kenarda değilse no-op).
  //
  // Reduced-motion tercih edilmişse hız 1/3'e iner; tamamen kapanmaz (yine
  // operasyonel fayda korunur).

  @ViewChild('planShell', { static: false }) planShellRef?: ElementRef<HTMLDivElement>;
  // 2026-05-14: Fullscreen toolbar/tablo split — gerçek scroll wrapper'ı bu.
  // Auto-pan rect ve scrollLeft/Top hesabı buna bağlı.
  @ViewChild('planShellScroll', { static: false }) planShellScrollRef?: ElementRef<HTMLDivElement>;

  private autoPanFrame: number | null = null;
  private autoPanState: { dx: number; dy: number } = { dx: 0, dy: 0 };
  private readonly autoPanEdgePx  = 80;
  private readonly autoPanMaxSpd  = 22;

  private readonly isCoarsePointer =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;

  private readonly prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  @HostListener('document:pointermove', ['$event'])
  onPointerMoveForAutoPan(ev: PointerEvent): void {
    if (!this.fullscreenActive())     return;
    if (this.isCoarsePointer)         return;
    if (this.viewMode() === 'list')   return;
    if (!this.canEdit())              return;

    // 2026-05-14: fullscreen'de gerçek scroll context `.plan-shell-scroll`;
    // toolbar dışarıda flex item — rect ve scrollLeft/Top onun üzerinden.
    const el = this.planShellScrollRef?.nativeElement ?? this.planShellRef?.nativeElement;
    if (!el) return;

    const r = el.getBoundingClientRect();
    const x = ev.clientX;
    const y = ev.clientY;

    // Pointer container dışında → state sıfır + loop kapanır.
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) {
      if (this.autoPanState.dx !== 0 || this.autoPanState.dy !== 0) {
        this.autoPanState = { dx: 0, dy: 0 };
      }
      return;
    }

    const distLeft  = x - r.left;
    const distRight = r.right - x;
    const distTop   = y - r.top;
    const distBot   = r.bottom - y;

    const maxSpeed = this.prefersReducedMotion ? this.autoPanMaxSpd / 3 : this.autoPanMaxSpd;
    const speedFor = (d: number): number => Math.max(0, (this.autoPanEdgePx - d) / this.autoPanEdgePx) * maxSpeed;

    let dx = 0;
    if (distRight < this.autoPanEdgePx)      dx = +speedFor(distRight);
    else if (distLeft < this.autoPanEdgePx)  dx = -speedFor(distLeft);

    let dy = 0;
    if (distBot < this.autoPanEdgePx)        dy = +speedFor(distBot);
    else if (distTop < this.autoPanEdgePx)   dy = -speedFor(distTop);

    this.autoPanState = { dx, dy };
    if (dx !== 0 || dy !== 0) this.ensureAutoPanLoop();
  }

  @HostListener('document:pointerleave')
  onPointerLeaveForAutoPan(): void {
    this.autoPanState = { dx: 0, dy: 0 };
  }

  private ensureAutoPanLoop(): void {
    if (this.autoPanFrame !== null) return;
    if (typeof window === 'undefined') return;
    const tick = (): void => {
      const el = this.planShellScrollRef?.nativeElement ?? this.planShellRef?.nativeElement;
      const { dx, dy } = this.autoPanState;
      if (!el || (dx === 0 && dy === 0)) {
        this.autoPanFrame = null;
        return;
      }
      const beforeL = el.scrollLeft;
      const beforeT = el.scrollTop;
      const maxL = el.scrollWidth  - el.clientWidth;
      const maxT = el.scrollHeight - el.clientHeight;
      el.scrollLeft = Math.max(0, Math.min(maxL, beforeL + dx));
      el.scrollTop  = Math.max(0, Math.min(maxT, beforeT + dy));
      // Scroll limit hit + state aynıysa CPU israfı önle: aynı pozisyondan
      // ileri gidemiyorsa loop sonraki frame'de kendini kapatır.
      this.autoPanFrame = window.requestAnimationFrame(tick);
    };
    this.autoPanFrame = window.requestAnimationFrame(tick);
  }

  private stopAutoPanLoop(): void {
    if (this.autoPanFrame !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this.autoPanFrame);
      this.autoPanFrame = null;
    }
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
    return formatIstanbulTime(value);
  }

  private endTimeForSlotIndex(index: number): string {
    if (index < this.timeSlots().length) return this.timeSlots()[index];
    return this.weekTimeRangeEnd();
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
