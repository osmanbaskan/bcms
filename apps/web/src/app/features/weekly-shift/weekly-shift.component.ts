import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ApiService } from '../../core/services/api.service';

interface ShiftDay {
  index: number;
  name: string;
  date: string;
}

interface ShiftType {
  code: string;
  label: string;
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
                            <div class="cell-editor" [class.leave-mode]="hasLeave(cell(user, day.index))" [class.time-mode]="hasTime(cell(user, day.index))">
                              @if (hasSelection(cell(user, day.index)) && group.canEdit) {
                                <button class="clear-cell" mat-icon-button type="button" aria-label="Hücreyi temizle"
                                        (click)="clearCell(user, day.index)">
                                  <mat-icon>close</mat-icon>
                                </button>
                              }
                              @if (!hasLeave(cell(user, day.index))) {
                              <div class="time-row">
                                <mat-form-field appearance="outline">
                                  <mat-label>Giriş</mat-label>
                                  <mat-select [disabled]="!group.canEdit"
                                              [ngModel]="cell(user, day.index).startTime"
                                              (ngModelChange)="setCell(user, day.index, 'startTime', $event)">
                                    <mat-option value="">Boş</mat-option>
                                    @for (time of startTimes; track time) {
                                      <mat-option [value]="time">{{ time }}</mat-option>
                                    }
                                  </mat-select>
                                </mat-form-field>
                                <mat-form-field appearance="outline">
                                  <mat-label>Çıkış</mat-label>
                                  <mat-select [disabled]="!group.canEdit"
                                              [ngModel]="cell(user, day.index).endTime"
                                              (ngModelChange)="setCell(user, day.index, 'endTime', $event)">
                                    <mat-option value="">Boş</mat-option>
                                    @for (time of endTimes; track time) {
                                      <mat-option [value]="time">{{ time }}</mat-option>
                                    }
                                  </mat-select>
                                </mat-form-field>
                              </div>
                              }
                              @if (!hasTime(cell(user, day.index))) {
                              <mat-form-field appearance="outline" class="shift-type-field">
                                <mat-label>İzin</mat-label>
                                <mat-select [disabled]="!group.canEdit"
                                            [ngModel]="cell(user, day.index).type"
                                            (ngModelChange)="setCell(user, day.index, 'type', $event)">
                                  @for (type of plan()!.shiftTypes; track type.code) {
                                    <mat-option [value]="type.code">{{ type.label }}</mat-option>
                                  }
                                </mat-select>
                              </mat-form-field>
                              }
                            </div>
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
    .page { display:flex; flex-direction:column; gap:14px; }
    .toolbar { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; padding:12px 16px 0; flex-wrap:wrap; }
    h1 { margin:0; font-size:48px; font-weight:600; }
    p { margin:4px 0 0; color:#9ca3af; }
    .week-controls { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .week-controls mat-form-field { width:164px; }
    .loading { display:flex; justify-content:center; padding:60px; }
    .group-section { border-top:1px solid #283241; padding:12px 12px 4px; }
    .group-header { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:10px; }
    .group-header h2 { margin:0; font-size:36px; font-weight:600; }
    .group-header span { color:#9ca3af; font-size:24px; }
    .group-actions { display:flex; align-items:center; gap:10px; }
    .mode { font-size:24px; color:#fca5a5; }
    .mode.editable { color:#86efac; }
    .empty { padding:18px; color:#8a94a6; border:1px dashed #334155; }
    .table-wrap { overflow:auto; border:1px solid #263241; }
    .shift-table { width:100%; border-collapse:collapse; table-layout:fixed; min-width:0; }
    th, td { border-bottom:1px solid #263241; border-right:1px solid #263241; }
    th { background:#111827; color:#dbeafe; padding:4px; text-align:left; vertical-align:top; }
    td { padding:3px; text-align:center; vertical-align:middle; }
    .person-col { position:sticky; left:0; z-index:1; width:135px; min-width:135px; background:#0f172a; }
    th.person-col { z-index:2; }
    .person-name { font-weight:600; font-size:24px; line-height:1.25; text-align:center; }
    .person-meta { display:flex; align-items:center; gap:6px; margin-top:3px; color:#9ca3af; font-size:20px; flex-wrap:wrap; }
    .supervisor { color:#f3e8ff; background:#581c87; border-radius:10px; padding:2px 7px; }
    .day-name { font-weight:600; font-size:24px; }
    .day-date { color:#94a3b8; font-size:20px; margin-top:2px; }
    .cell-editor { position:relative; display:flex; flex-direction:column; gap:3px; min-width:0; }
    .cell-editor mat-form-field { width:100%; }
    .time-row { display:grid; grid-template-columns:1fr 1fr; gap:3px; }
    .shift-type-field { margin-top:1px; }
    .cell-editor.leave-mode .shift-type-field,
    .cell-editor.time-mode .time-row { min-height:72px; display:flex; align-items:stretch; }
    .cell-editor.leave-mode .shift-type-field ::ng-deep .mat-mdc-text-field-wrapper,
    .cell-editor.time-mode .time-row mat-form-field ::ng-deep .mat-mdc-text-field-wrapper { min-height:64px; align-items:center; }
    .clear-cell {
      position:absolute; top:2px; right:2px; z-index:3;
      width:20px; height:20px; padding:0; color:#cbd5e1; background:rgba(15,23,42,.84);
    }
    .clear-cell mat-icon { font-size:15px; width:15px; height:15px; line-height:15px; }
    .cell-editor ::ng-deep .mat-mdc-form-field-infix {
      min-height:68px;
      padding-top:12px;
      padding-bottom:12px;
      display:flex;
      align-items:center;
    }
    .cell-editor ::ng-deep .mat-mdc-text-field-wrapper {
      padding-left:4px;
      padding-right:4px;
    }
    /* Material varsayılan mat-mdc-form-field min-width:180px zorlaması iptal —
       table-layout:fixed bu sayede kolonları viewport'a sığdırabilir.
       Font ve yükseklik bilinçli olarak dokunulmadı. */
    .cell-editor ::ng-deep .mat-mdc-form-field {
      width:100%; min-width:0;
    }
    .cell-editor ::ng-deep .mat-mdc-select-value,
    .cell-editor ::ng-deep .mat-mdc-floating-label {
      font-size:22px;
      text-align:center;
      font-weight:700;
    }
    .cell-editor ::ng-deep .mat-mdc-select-value-text {
      display:flex;
      justify-content:center;
      font-weight:700;
    }
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

  setCell(user: ShiftUser, dayIndex: number, field: keyof ShiftCell, value: string) {
    const key = String(dayIndex);
    const existing = user.assignments[key] ?? { startTime: null, endTime: null, type: '' };
    const updated: ShiftCell = { ...existing, [field]: value || null };

    if (field === 'type') {
      updated.type = value || '';
      if (updated.type) {
        updated.startTime = null;
        updated.endTime = null;
      }
    }
    if ((field === 'startTime' || field === 'endTime') && value) {
      updated.type = '';
    }

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

  hasTime(cell: ShiftCell): boolean {
    return Boolean(cell.startTime || cell.endTime);
  }

  hasLeave(cell: ShiftCell): boolean {
    return Boolean(cell.type);
  }

  hasSelection(cell: ShiftCell): boolean {
    return this.hasTime(cell) || this.hasLeave(cell);
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

  private shiftCellDisplay(cell: ShiftCell): string {
    const type = cell.type ?? '';
    if (!type || type === 'WORK') {
      const start = cell.startTime ?? '';
      const end = cell.endTime ?? '';
      if (start && end) return `${start} - ${end}`;
      if (start) return start;
      if (end) return end;
      return '';
    }
    return this.shiftTypeLabel(type);
  }

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
    if (!type || type === 'WORK') {
      const start = cell.startTime ?? '';
      const end = cell.endTime ?? '';
      if (start && end) return `<span style="font-weight:700;color:#22c55e;">${start} – ${end}</span>`;
      if (start) return `<span style="font-weight:700;color:#22c55e;">${start}</span>`;
      if (end) return `<span style="font-weight:700;color:#22c55e;">${end}</span>`;
      return '<span style="color:#475569;">—</span>';
    }
    const label = this.shiftTypeLabel(type);
    const color = this.shiftTypeBadgeColor(type);
    return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${color}22;color:${color};font-weight:700;font-size:9px;border:1px solid ${color}44;">${this.escapeHtml(label)}</span>`;
  }

  private printableHtml(data: ShiftResponse): string {
    const weekStartTR = this.formatDateTR(data.weekStart);
    const weekEnd = new Date(`${data.weekStart}T00:00:00`);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const weekEndStr = this.formatDateTR(weekEnd.toISOString().slice(0, 10));

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

    const sections = data.groups.map((group) => `
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
        <div class="footer">BCMS · ${new Date().toLocaleString('tr-TR')}</div>
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
