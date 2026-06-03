import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ApiService } from '../../core/services/api.service';
import { formatIstanbulDate, formatIstanbulDateTime } from '../../core/time/tz.helpers';

interface ShiftDay {
  index: number;
  name: string;
  date: string;
}

interface ShiftType {
  code: string;
  label: string;
  /** true → tam gün izin/tatil (giriş-çıkış yok); backend SHIFT_TYPES'tan gelir. */
  timeless?: boolean;
}

interface ShiftCell {
  id?: number;
  startTime: string | null;
  endTime: string | null;
  type: string;
}

interface ShiftUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  userType: 'staff' | 'supervisor';
  groups: string[];
  assignments: Record<string, ShiftCell>;
}

interface ShiftGroup {
  name: string;
  canEdit: boolean;
  users: ShiftUser[];
}

interface ShiftResponse {
  weekStart: string;
  days: ShiftDay[];
  shiftTypes: ShiftType[];
  groups: ShiftGroup[];
}

const START_TIMES = ['05:00', '06:00', '07:45', '10:00', '12:00', '14:45', '16:30', '23:30'];
const END_TIMES = ['06:15', '13:15', '15:00', '16:45', '20:00', '22:00', '23:45', 'Y.SONU'];

@Component({
  selector: 'app-weekly-shift',
  standalone: true,
  // R6 (audit #2a): state signal-tabanlı (shifts/saving/filtreler signal;
  // computed türevler). 3 subscribe (put/get) + 2 setTimeout hepsi signal.set
  // ile günceller → OnPush'ta CD tetiklenir. Imperatif cdr/detectChanges yok;
  // scroll-sync ayrı directive (CD'den bağımsız DOM senkronu).
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSnackBarModule,
  ],
  template: `
    <section class="page">
      <header class="toolbar">
        <div>
          <h1>Haftalık Shift</h1>
          <p>Gruplara göre haftalık personel planı</p>
        </div>
        <div class="week-controls">
          <button mat-icon-button (click)="moveWeek(-1)" aria-label="Önceki hafta">
            <mat-icon>chevron_left</mat-icon>
          </button>
          <mat-form-field appearance="outline">
            <mat-label>Hafta Başlangıcı</mat-label>
            <input matInput type="date" [ngModel]="weekStart()" (ngModelChange)="setWeek($event)">
          </mat-form-field>
          <button mat-icon-button (click)="moveWeek(1)" aria-label="Sonraki hafta">
            <mat-icon>chevron_right</mat-icon>
          </button>
          <button mat-stroked-button (click)="load()">
            <mat-icon>refresh</mat-icon>
            Yenile
          </button>
          <button mat-stroked-button [disabled]="exporting()" (click)="exportExcel()">
            <mat-icon>table_view</mat-icon>
            Excel
          </button>
          <button mat-stroked-button [disabled]="exporting()" (click)="exportPdf()">
            <mat-icon>picture_as_pdf</mat-icon>
            PDF
          </button>
        </div>
      </header>

      @if (loading()) {
        <div class="loading"><mat-spinner diameter="42"></mat-spinner></div>
      } @else if (plan()) {
        @for (group of plan()!.groups; track group.name) {
          <section class="group-section">
            <div class="group-header">
              <div>
                <h2>{{ group.name }}</h2>
                <span>{{ group.users.length }} personel</span>
              </div>
              <div class="group-actions">
                <span class="mode" [class.editable]="group.canEdit">
                  {{ group.canEdit ? 'Düzenlenebilir' : 'Salt okunur' }}
                </span>
                <button mat-raised-button color="primary" [disabled]="!group.canEdit || savingGroup() === group.name"
                        (click)="saveGroup(group)">
                  <mat-icon>save</mat-icon>
                  {{ savingGroup() === group.name ? 'Kaydediliyor' : 'Kaydet' }}
                </button>
              </div>
            </div>

            @if (group.users.length === 0) {
              <div class="empty">Bu grupta personel yok.</div>
            } @else {
              <div class="table-wrap">
                <table class="shift-table">
                  <thead>
                    <tr>
                      <th class="person-col">Personel</th>
                      @for (day of plan()!.days; track day.index) {
                        <th>
                          <div class="day-name">{{ day.name }}</div>
                          <div class="day-date">{{ formatDateTR(day.date) }}</div>
                        </th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    @for (user of group.users; track user.id) {
                      <tr>
                        <td class="person-col">
                          <div class="person-name">{{ user.displayName }}</div>
                        </td>
                        @for (day of plan()!.days; track day.index) {
                          <td>
                            @let c = cell(user, day.index);
                            @if (isEditing(user, day.index)) {
                              <!-- Inline editör: tip seç → timeless değilse giriş-çıkış açılır -->
                              <div class="cell-edit">
                                <select class="ce-select ce-type" [disabled]="!group.canEdit"
                                        [ngModel]="c.type"
                                        (ngModelChange)="setCell(user, day.index, 'type', $event)">
                                  <option value="">Mesai</option>
                                  @for (t of plan()!.shiftTypes; track t.code) {
                                    <option [value]="t.code">{{ t.label }}</option>
                                  }
                                </select>
                                @if (!isTimelessType(c.type)) {
                                  <div class="ce-times">
                                    <!-- Giriş: liste ya da "Elle gir…" → type=time (HH:MM zorunlu) -->
                                    @if (manualStart()) {
                                      <div class="ce-manual">
                                        <input class="ce-input" type="time" [disabled]="!group.canEdit"
                                               aria-label="Giriş saati (ss:dd)"
                                               [ngModel]="c.startTime"
                                               (ngModelChange)="setCell(user, day.index, 'startTime', $event)">
                                        <button type="button" class="ce-mini" title="Listeden seç"
                                                (click)="backToList(user, day.index, 'startTime')">⌄</button>
                                      </div>
                                    } @else {
                                      <select class="ce-select" [disabled]="!group.canEdit"
                                              [ngModel]="c.startTime"
                                              (ngModelChange)="onTimeSelect(user, day.index, 'startTime', $event)">
                                        <option [ngValue]="null">Giriş</option>
                                        @for (time of startTimes; track time) { <option [value]="time">{{ time }}</option> }
                                        <option value="__manual__">Elle gir…</option>
                                      </select>
                                    }
                                    <!-- Çıkış: liste ya da "Elle gir…" → type=time (HH:MM zorunlu) -->
                                    @if (manualEnd()) {
                                      <div class="ce-manual">
                                        <input class="ce-input" type="time" [disabled]="!group.canEdit"
                                               aria-label="Çıkış saati (ss:dd)"
                                               [ngModel]="c.endTime"
                                               (ngModelChange)="setCell(user, day.index, 'endTime', $event)">
                                        <button type="button" class="ce-mini" title="Listeden seç"
                                                (click)="backToList(user, day.index, 'endTime')">⌄</button>
                                      </div>
                                    } @else {
                                      <select class="ce-select" [disabled]="!group.canEdit"
                                              [ngModel]="c.endTime"
                                              (ngModelChange)="onTimeSelect(user, day.index, 'endTime', $event)">
                                        <option [ngValue]="null">Çıkış</option>
                                        @for (time of endTimes; track time) { <option [value]="time">{{ time }}</option> }
                                        <option value="__manual__">Elle gir…</option>
                                      </select>
                                    }
                                  </div>
                                }
                                <div class="ce-actions">
                                  <button type="button" class="ce-btn ce-clear" (click)="clearCell(user, day.index)">Sil</button>
                                  <button type="button" class="ce-btn ce-done" (click)="closeEditor()">Tamam</button>
                                </div>
                              </div>
                            } @else {
                              <!-- Kompakt çip: izin = renkli rozet, saatli = "GG–GG" -->
                              <button type="button" class="chip"
                                      [class.chip--empty]="cellEmpty(c)"
                                      [style.--chip-color]="chipColor(c)"
                                      [disabled]="!group.canEdit && cellEmpty(c)"
                                      (click)="group.canEdit && openEditor(user, day.index)">
                                @if (cellEmpty(c)) {
                                  <span class="chip-add">{{ group.canEdit ? '+' : '—' }}</span>
                                } @else {
                                  @if (chipLabel(c)) { <span class="chip-label">{{ chipLabel(c) }}</span> }
                                  @if (chipTime(c)) { <span class="chip-time">{{ chipTime(c) }}</span> }
                                }
                              </button>
                            }
                          </td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>
        }
      }
    </section>
  `,
  styles: [`
    /* beINport UI V2 — page header restyle */
    .page { display:flex; flex-direction:column; gap: var(--bp-sp-4); padding: var(--bp-sp-6) var(--bp-sp-8) var(--bp-sp-8); }
    .toolbar { display:flex; justify-content:space-between; gap: var(--bp-sp-3); align-items:flex-start; padding: 0; flex-wrap:wrap; }
    h1 {
      margin: 0;
      font-family: var(--bp-font-display);
      font-size: var(--bp-text-3xl);
      font-weight: var(--bp-fw-semibold);
      letter-spacing: var(--bp-ls-tight);
      color: var(--bp-fg-1);
    }
    p { margin: 4px 0 0; color: var(--bp-fg-3); font-size: 12.5px; }
    .week-controls { display:flex; align-items:center; gap: var(--bp-sp-2); flex-wrap:wrap; }
    .week-controls mat-form-field { width: 164px; }
    .loading { display:flex; justify-content:center; padding: 60px; }
    .group-section {
      border-top: 1px solid var(--bp-line-2);
      padding: var(--bp-sp-3) 0 var(--bp-sp-1);
      margin-top: var(--bp-sp-2);
    }
    .group-header {
      display:flex; justify-content:space-between; align-items:center; gap: var(--bp-sp-4);
      margin-bottom: var(--bp-sp-3);
    }
    .group-header h2 {
      margin: 0;
      font-family: var(--bp-font-display);
      font-size: var(--bp-text-2xl);
      font-weight: var(--bp-fw-semibold);
      letter-spacing: var(--bp-ls-tight);
      color: var(--bp-fg-1);
    }
    .group-header span { color: var(--bp-fg-3); font-size: 12.5px; }
    .group-actions { display:flex; align-items:center; gap: var(--bp-sp-3); }
    .mode {
      font-size: 11px;
      font-weight: var(--bp-fw-bold);
      letter-spacing: var(--bp-ls-status);
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: var(--bp-r-sm);
      background: var(--bp-status-REJECTED-bg);
      color: var(--bp-status-REJECTED-fg);
    }
    .mode.editable {
      background: var(--bp-status-COMPLETED-bg);
      color: var(--bp-status-COMPLETED-fg);
    }
    .empty {
      padding: var(--bp-sp-4);
      color: var(--bp-fg-3);
      border: 1px dashed var(--bp-line-2);
      border-radius: var(--bp-r-md);
      text-align: center;
      font-size: 13px;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--bp-line-2);
      border-radius: var(--bp-r-lg);
      background: var(--bp-bg-2);
    }
    .shift-table { width: 100%; border-collapse: collapse; table-layout: fixed; min-width: 0; }
    th, td {
      border-bottom: 1px solid var(--bp-line-2);
      border-right: 1px solid var(--bp-line-2);
    }
    th {
      background: var(--bp-bg-3);
      color: var(--bp-fg-2);
      padding: 8px;
      text-align: left;
      vertical-align: top;
      font-size: 11px;
      font-weight: var(--bp-fw-bold);
      letter-spacing: var(--bp-ls-eyebrow);
      text-transform: uppercase;
    }
    td { padding: 4px; text-align: center; vertical-align: middle; color: var(--bp-fg-1); }
    .person-col {
      position: sticky;
      left: 0;
      z-index: 1;
      width: 135px;
      min-width: 135px;
      background: var(--bp-bg-1);
    }
    th.person-col { z-index: 2; background: var(--bp-bg-3); }
    .person-name {
      font-weight: var(--bp-fw-semibold);
      font-size: 13.5px;
      line-height: 1.25;
      text-align: center;
      color: var(--bp-fg-1);
    }
    .person-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      color: var(--bp-fg-3);
      font-size: 11px;
      flex-wrap: wrap;
      justify-content: center;
    }
    .supervisor {
      color: var(--bp-acc-purple);
      background: rgba(124, 58, 237, 0.18);
      border-radius: var(--bp-r-pill);
      padding: 2px 8px;
      font-size: 9.5px;
      font-weight: var(--bp-fw-bold);
      letter-spacing: var(--bp-ls-status);
      text-transform: uppercase;
    }
    .day-name {
      font-weight: var(--bp-fw-semibold);
      font-size: 12px;
      color: var(--bp-fg-1);
    }
    .day-date {
      color: var(--bp-fg-3);
      font-size: 11px;
      margin-top: 2px;
      font-family: var(--bp-font-mono);
    }
    /* ─── Kompakt çip (varsayılan görünüm) ─── */
    .chip {
      width:100%; box-sizing:border-box;
      display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px;
      min-height:34px; padding:4px 6px;
      border:1px solid var(--chip-color, var(--bp-line-2));
      background:var(--bp-bg-3);
      border-radius:var(--bp-r-md);
      color:var(--bp-fg-1); font-family:inherit; line-height:1.15;
      cursor:pointer; transition:background var(--bp-dur-fast);
    }
    .chip:hover:not(:disabled) { background:var(--bp-row-hover); }
    .chip:disabled { cursor:default; }
    .chip--empty {
      border:1px dashed var(--bp-line-2); background:transparent; color:var(--bp-fg-4); min-height:30px;
    }
    .chip-label { font-size:11px; font-weight:var(--bp-fw-bold); color:var(--chip-color); letter-spacing:0.02em; text-align:center; }
    .chip-time { font-size:12px; font-family:var(--bp-font-mono); font-weight:var(--bp-fw-medium); color:var(--bp-fg-1); }
    .chip-add { font-size:16px; color:var(--bp-fg-4); line-height:1; }

    /* ─── Inline editör (tıklanan hücre) ─── */
    .cell-edit { display:flex; flex-direction:column; gap:4px; padding:1px; }
    .ce-select {
      width:100%; box-sizing:border-box;
      background:var(--bp-bg-1); color:var(--bp-fg-1);
      border:1px solid var(--bp-line); border-radius:var(--bp-r-sm);
      padding:4px 6px; font-size:12px; font-family:inherit; color-scheme:dark;
    }
    .ce-type { font-weight:var(--bp-fw-semibold); }
    .ce-times { display:grid; grid-template-columns:1fr 1fr; gap:4px; }
    .ce-manual { display:flex; align-items:center; gap:2px; min-width:0; }
    .ce-input {
      flex:1; min-width:0; box-sizing:border-box;
      background:var(--bp-bg-1); color:var(--bp-fg-1);
      border:1px solid var(--bp-purple-300); border-radius:var(--bp-r-sm);
      padding:3px 5px; font-size:12px; font-family:var(--bp-font-mono); color-scheme:dark;
    }
    .ce-mini {
      flex:0 0 auto; width:18px; height:24px; padding:0; line-height:1;
      border:1px solid var(--bp-line); background:var(--bp-bg-3); color:var(--bp-fg-3);
      border-radius:var(--bp-r-sm); cursor:pointer; font-size:12px;
    }
    .ce-actions { display:flex; gap:4px; justify-content:flex-end; }
    .ce-btn {
      border:1px solid var(--bp-line); background:var(--bp-bg-3); color:var(--bp-fg-2);
      border-radius:var(--bp-r-sm); padding:3px 9px; font-size:11px; cursor:pointer; font-family:inherit;
    }
    .ce-btn.ce-done { background:var(--bp-purple-700); color:#fff; border-color:transparent; font-weight:var(--bp-fw-semibold); }
    .ce-btn.ce-clear { color:var(--bp-fg-3); }
  `],
})
export class WeeklyShiftComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly snack = inject(MatSnackBar);

  loading = signal(true);
  plan = signal<ShiftResponse | null>(null);
  weekStart = signal(this.currentMonday());
  savingGroup = signal('');
  exporting = signal(false);
  /** Düzenlenen hücre anahtarı `${userId}:${dayIndex}`; null = hepsi çip modunda. */
  editing = signal<string | null>(null);
  /** Düzenlenen hücrede Giriş / Çıkış "Elle gir…" (manuel HH:MM) modunda mı. */
  manualStart = signal(false);
  manualEnd = signal(false);
  startTimes = START_TIMES;
  endTimes = END_TIMES;

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    this.api.get<ShiftResponse>('/weekly-shifts', { weekStart: this.weekStart() }).subscribe({
      next: (data) => {
        this.weekStart.set(data.weekStart);
        this.plan.set(data);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.snack.open('Shift planı yüklenemedi', 'Kapat', { duration: 3000 });
      },
    });
  }

  setWeek(value: string) {
    if (!value) return;
    this.weekStart.set(this.toMonday(value));
    this.load();
  }

  moveWeek(direction: number) {
    const d = new Date(`${this.weekStart()}T00:00:00`);
    d.setDate(d.getDate() + direction * 7);
    this.weekStart.set(this.formatDate(d));
    this.load();
  }

  cell(user: ShiftUser, dayIndex: number): ShiftCell {
    const key = String(dayIndex);
    return user.assignments[key] ?? { startTime: null, endTime: null, type: '' };
  }

  setCell(user: ShiftUser, dayIndex: number, field: keyof ShiftCell, value: string | null) {
    const key = String(dayIndex);
    const existing = user.assignments[key] ?? { startTime: null, endTime: null, type: '' };
    const updated: ShiftCell = { ...existing, [field]: value || null };

    if (field === 'type') {
      updated.type = value || '';
      // Timeless tip (izin/tatil) → giriş-çıkış temizlenir. Timed tip
      // (Gece/Evden/Dış Görev) + tipsiz mesai → mevcut saatler korunur.
      if (this.isTimelessType(updated.type)) {
        updated.startTime = null;
        updated.endTime = null;
      }
    }
    // Saat girişi tipi temizlemez — timed tipler saatle birlikte yaşar.

    this.updateUserAssignment(user, key, updated);
  }

  clearCell(user: ShiftUser, dayIndex: number) {
    this.updateUserAssignment(user, String(dayIndex), { startTime: null, endTime: null, type: '' });
  }

  private updateUserAssignment(user: ShiftUser, key: string, cell: ShiftCell) {
    this.plan.update((current) => {
      if (!current) return current;
      return {
        ...current,
        groups: current.groups.map((g) => ({
          ...g,
          users: g.users.map((u) =>
            u.id === user.id ? { ...u, assignments: { ...u.assignments, [key]: cell } } : u
          ),
        })),
      };
    });
  }

  // ─── Çip + inline editör ──────────────────────────────────────────────
  private editKey(user: ShiftUser, dayIndex: number): string {
    return `${user.id}:${dayIndex}`;
  }
  isEditing(user: ShiftUser, dayIndex: number): boolean {
    return this.editing() === this.editKey(user, dayIndex);
  }
  openEditor(user: ShiftUser, dayIndex: number): void {
    // Mevcut değer önceden tanımlı listede yoksa (elle girilmiş) manuel modda aç.
    const c = this.cell(user, dayIndex);
    const s = c.startTime;
    const e = c.endTime;
    this.manualStart.set(s != null && s !== '' && !START_TIMES.includes(s));
    this.manualEnd.set(e != null && e !== '' && !END_TIMES.includes(e));
    this.editing.set(this.editKey(user, dayIndex));
  }
  closeEditor(): void {
    this.editing.set(null);
    this.manualStart.set(false);
    this.manualEnd.set(false);
  }

  /** Saat dropdown seçimi — "Elle gir…" sentinel'i manuel (type=time) moda geçirir. */
  onTimeSelect(user: ShiftUser, dayIndex: number, field: 'startTime' | 'endTime', value: string | null): void {
    if (value === '__manual__') {
      if (field === 'startTime') this.manualStart.set(true); else this.manualEnd.set(true);
      return; // sentinel hücreye yazılmaz; input HH:MM'i zorlayacak
    }
    this.setCell(user, dayIndex, field, value);
  }

  /** Manuel moddan listeye dön — değeri temizle, dropdown placeholder'a düşsün. */
  backToList(user: ShiftUser, dayIndex: number, field: 'startTime' | 'endTime'): void {
    if (field === 'startTime') this.manualStart.set(false); else this.manualEnd.set(false);
    this.setCell(user, dayIndex, field, null);
  }

  /** Tip kodu tam-gün (izin/tatil) mı — backend shiftTypes.timeless'tan okunur. */
  isTimelessType(code: string): boolean {
    if (!code) return false;
    return this.plan()?.shiftTypes.find((t) => t.code === code)?.timeless === true;
  }

  cellEmpty(cell: ShiftCell): boolean {
    return !cell.type && !cell.startTime && !cell.endTime;
  }
  chipColor(cell: ShiftCell): string {
    if (cell.type) return this.shiftTypeBadgeColor(cell.type);
    if (cell.startTime || cell.endTime) return '#22c55e'; // tipsiz mesai
    return '#64748b';
  }
  chipLabel(cell: ShiftCell): string {
    return cell.type ? this.shiftTypeLabel(cell.type) : '';
  }
  chipTime(cell: ShiftCell): string {
    if (this.isTimelessType(cell.type)) return '';
    const s = cell.startTime ?? '';
    const e = cell.endTime ?? '';
    if (s && e) return `${s}–${e}`;
    return s || e || '';
  }

  saveGroup(group: ShiftGroup) {
    const assignments = group.users.flatMap((user) =>
      Object.entries(user.assignments)
        .filter(([, cell]) => !!(cell.type || cell.startTime || cell.endTime))
        .map(([dayIndex, cell]) => ({
          userId: user.id,
          userName: user.displayName,
          dayIndex: Number(dayIndex),
          startTime: cell.startTime,
          endTime: cell.endTime,
          type: cell.type || '',
        })),
    );

    this.savingGroup.set(group.name);
    this.api.put(`/weekly-shifts/${encodeURIComponent(group.name)}`, {
      weekStart: this.weekStart(),
      assignments,
    }).subscribe({
      next: () => {
        this.savingGroup.set('');
        this.snack.open(`${group.name} shift planı kaydedildi`, 'Kapat', { duration: 3000 });
        this.load();
      },
      error: (err) => {
        this.savingGroup.set('');
        this.snack.open(err?.error?.message ?? 'Shift planı kaydedilemedi', 'Kapat', { duration: 4000 });
      },
    });
  }

  exportExcel() {
    this.exporting.set(true);
    this.api.getBlob('/weekly-shifts/export', { weekStart: this.weekStart() }).subscribe({
      next: (blob) => {
        this.downloadBlob(blob, `weekly-shift_${this.weekStart()}.xlsx`);
        this.exporting.set(false);
      },
      error: (err) => {
        this.exporting.set(false);
        this.snack.open(err?.error?.message ?? 'Excel export alınamadı', 'Kapat', { duration: 4000 });
      },
    });
  }

  exportPdf() {
    const data = this.plan();
    if (!data) return;
    const win = window.open('', '_blank', 'width=1200,height=800');
    if (!win) {
      this.snack.open('PDF penceresi açılamadı', 'Kapat', { duration: 3000 });
      return;
    }
    win.opener = null;
    win.document.write(this.printableHtml(data));
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
  }

  shiftTypeLabel(code: string): string {
    if (!code || code === 'WORK') return '';
    return this.plan()?.shiftTypes.find((type) => type.code === code)?.label ?? code;
  }

  formatDateTR(dateStr: string): string {
    const [y, m, d] = dateStr.split('-');
    return `${d}.${m}.${y}`;
  }

  // LOW-FE-004 fix (2026-05-05): unused method silindi. Template artık
  // doğrudan startTime/endTime/type'a bakıyor.

  private downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  private shiftTypeBadgeColor(code: string): string {
    const map: Record<string, string> = {
      OFF_DAY: '#3b82f6',
      HOME: '#10b981',
      OUTSIDE: '#f59e0b',
      NIGHT: '#6366f1',
      SIC_CER: '#ef4444',
      HOLIDAY: '#8b5cf6',
      ANNUAL: '#06b6d4',
    };
    return map[code] ?? '#64748b';
  }

  private shiftCellPdf(cell: ShiftCell): string {
    const type = cell.type ?? '';
    const start = cell.startTime ?? '';
    const end = cell.endTime ?? '';
    const timeStr = start && end ? `${start} – ${end}` : (start || end || '');
    if (!type || type === 'WORK') {
      if (timeStr) return `<span style="font-weight:700;color:#22c55e;">${this.escapeHtml(timeStr)}</span>`;
      return '<span style="color:#475569;">—</span>';
    }
    const label = this.shiftTypeLabel(type);
    const color = this.shiftTypeBadgeColor(type);
    // Timed tip (saatli): rozet + saat; timeless: sadece rozet.
    const timePart = !this.isTimelessType(type) && timeStr
      ? `<span style="margin-left:5px;color:#cbd5e1;font-weight:600;">${this.escapeHtml(timeStr)}</span>` : '';
    return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${color}22;color:${color};font-weight:700;font-size:9px;border:1px solid ${color}44;">${this.escapeHtml(label)}</span>${timePart}`;
  }

  private printableHtml(data: ShiftResponse): string {
    const weekStartTR = this.formatDateTR(data.weekStart);
    // weekStart "YYYY-MM-DD" Türkiye-naive gün; +6 gün ekle, yine Türkiye-naive
    // string olarak kalsın. Date.UTC ile browser TZ'sinden bağımsız.
    const [y, m, d] = data.weekStart.split('-').map(Number);
    const weekEnd = new Date(Date.UTC(y, m - 1, d + 6));
    const weekEndYmd = `${weekEnd.getUTCFullYear()}-${String(weekEnd.getUTCMonth() + 1).padStart(2, '0')}-${String(weekEnd.getUTCDate()).padStart(2, '0')}`;
    const weekEndStr = this.formatDateTR(weekEndYmd);

    const styles = `
      <style>
        @page { size: A4 landscape; margin: 0; }
        * { box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          color: #e2e8f0;
          background: #0b1120;
          margin: 0;
          padding: 0;
          font-size: 10px;
        }

        .header-card {
          background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%);
          border-radius: 10px;
          padding: 18px 24px;
          margin-bottom: 18px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border: 1px solid #1e3a5f;
        }
        .header-title {
          font-size: 22px;
          font-weight: 700;
          color: #fff;
          letter-spacing: 0.5px;
        }
        .header-date {
          font-size: 13px;
          color: #94a3b8;
          font-weight: 600;
        }
        .header-date span {
          color: #38bdf8;
        }

        .group-section {
          margin-bottom: 20px;
          page-break-inside: avoid;
        }
        .group-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 8px;
        }
        .group-bar {
          width: 4px;
          height: 22px;
          background: #38bdf8;
          border-radius: 2px;
        }
        .group-name {
          font-size: 14px;
          font-weight: 700;
          color: #f1f5f9;
        }
        .group-count {
          font-size: 10px;
          color: #64748b;
          margin-left: auto;
        }

        table {
          width: 100%;
          border-collapse: separate;
          border-spacing: 0;
          border-radius: 8px;
          overflow: hidden;
          border: 1px solid #1e293b;
        }
        thead th {
          background: #1e293b;
          color: #cbd5e1;
          padding: 8px 6px;
          font-size: 9px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.4px;
          border-bottom: 2px solid #334155;
        }
        thead th:first-child {
          text-align: left;
          padding-left: 12px;
          width: 140px;
        }
        thead th .day-date {
          display: block;
          font-size: 8px;
          color: #64748b;
          margin-top: 2px;
          font-weight: 500;
        }
        tbody td {
          padding: 7px 6px;
          font-size: 9.5px;
          border-bottom: 1px solid #1e293b;
          text-align: center;
          vertical-align: middle;
        }
        tbody td:first-child {
          text-align: left;
          padding-left: 12px;
          font-weight: 700;
          color: #f8fafc;
          background: #0f172a;
        }
        tbody tr:nth-child(even) td {
          background: #111827;
        }
        tbody tr:nth-child(odd) td {
          background: #0b1120;
        }
        tbody tr:hover td {
          background: #1e293b;
        }

        .footer {
          margin-top: 16px;
          text-align: center;
          font-size: 8px;
          color: #475569;
        }
      </style>
    `;

    const sections = data.groups.filter((g) => g.users.length > 0).map((group) => `
      <div class="group-section">
        <div class="group-header">
          <div class="group-bar"></div>
          <div class="group-name">${this.escapeHtml(group.name)}</div>
          <div class="group-count">${group.users.length} personel</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Personel</th>
              ${data.days.map((day) => `<th>${this.escapeHtml(day.name)}<span class="day-date">${this.formatDateTR(day.date)}</span></th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${group.users.map((user) => `
              <tr>
                <td>${this.escapeHtml(user.displayName)}</td>
                ${data.days.map((day) => {
                  const cell = user.assignments[String(day.index)] ?? { startTime: '', endTime: '', type: '' };
                  return `<td>${this.shiftCellPdf(cell)}</td>`;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `).join('');

    return `<!doctype html>
    <html>
      <head>
        <title>Haftalık Shift</title>
        <meta charset="utf-8">
        ${styles}
      </head>
      <body>
        <div class="header-card">
          <div class="header-title">📅 Haftalık Shift Planı</div>
          <div class="header-date"><span>${weekStartTR}</span> → <span>${weekEndStr}</span></div>
        </div>
        ${sections}
        <div class="footer">BCMS · ${formatIstanbulDateTime(new Date())}</div>
      </body>
    </html>`;
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char] ?? char));
  }

  private currentMonday(): string {
    return this.toMonday(this.formatDate(new Date()));
  }

  private toMonday(value: string): string {
    const d = new Date(`${value}T00:00:00`);
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    return this.formatDate(d);
  }

  private formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}
