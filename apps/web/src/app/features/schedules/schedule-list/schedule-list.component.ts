import {
  Component, HostListener, OnDestroy, OnInit, signal, computed, inject,
} from '@angular/core';
import { KeycloakService } from 'keycloak-angular';
import { Router } from '@angular/router';
import { environment } from '../../../../environments/environment';
import { isSkipAuthAllowed } from '../../../core/auth/skip-auth';
import { formatIstanbulDateTr, formatIstanbulTime, istanbulDayRangeUtc, istanbulTodayDate } from '../../../core/time/tz.helpers';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialogModule, MatDialog, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatCardModule } from '@angular/material/card';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatDividerModule } from '@angular/material/divider';

import { ScheduleService, ScheduleFilter } from '../../../core/services/schedule.service';
import { ApiService } from '../../../core/services/api.service';
import { PERMISSIONS, GROUP } from '@bcms/shared';
import type { Schedule } from '@bcms/shared';
import type { BcmsTokenParsed } from '../../../core/types/auth';
import { LivePlanEntryAddDialogComponent } from './live-plan-entry-add-dialog.component';
import { LivePlanEntryEditDialogComponent } from './live-plan-entry-edit-dialog.component';

// Mutation restore (2026-05-10): Canlı Yayın Plan mutation aksiyonları
// (Yeni / Düzenle / Teknik / Çoğalt / Sil) eski konumlarına geri getirildi;
// command path canonical `/api/v1/live-plan*` endpoint'lerine bağlı (legacy
// `/schedules` mutation YOK, JSON/metadata YOK).
//   - Add → POST /live-plan veya /live-plan/from-opta (LivePlanEntryAddDialog)
//   - Edit → PATCH /live-plan/:id + If-Match (LivePlanEntryEditDialog)
//   - Technical → router.navigate(['/live-plan', s.id])  (M5-B10b form orada)
//   - Duplicate → POST /live-plan/:id/duplicate
//   - Delete → DELETE /live-plan/:id + If-Match (hard-delete)
//   - ReportIssue → mevcut /api/v1/incidents/report (korunur)
// Permission: livePlan.write/delete (PERMISSIONS map; rbac.ts:72-76).

function hasGroup(userGroups: string[], required: string[]): boolean {
  if (userGroups.includes(GROUP.Admin)) return true;
  return required.length === 0 || required.some((g) => userGroups.includes(g));
}

interface Channel { id: number; name: string; type: string; }

const LEAGUE_COLORS = new Map<string, string>([
  ['turkish super lig', '#244b35'],
  ['turkish 1. lig', '#574024'],
  ['english premier league', '#432a64'],
  ['french ligue 1', '#1f4a62'],
  ['formula 1', '#682332'],
  ['turkiye basketbol ligi', '#4d4a24'],
  ['türkiye basketbol ligi', '#4d4a24'],
]);

const FALLBACK_LEAGUE_COLORS = [
  '#25445f', '#3f3f68', '#5a324d', '#31513c',
  '#5b432c', '#4a385f', '#225050', '#5c3333',
];

function normalizeLeagueName(name: unknown): string {
  return String(name ?? '').trim().toLocaleLowerCase('tr-TR');
}

function leagueBackground(name: unknown): string {
  const normalized = normalizeLeagueName(name);
  if (!normalized) return '';

  const explicit = LEAGUE_COLORS.get(normalized);
  if (explicit) return explicit;

  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_LEAGUE_COLORS[hash % FALLBACK_LEAGUE_COLORS.length];
}

function transmissionEndDate(schedule: Schedule): Date {
  // SCHED-B5a (Y5-1): live-plan datasource'unda metadata.transStart/transEnd
  // alanları yok (mapper boş metadata döndürür). transmissionEndDate canonical
  // endTime üstünden hesaplanır.
  return new Date(schedule.endTime);
}

// ── Sorun Bildir Dialog ───────────────────────────────────────────────────────
@Component({
  selector: 'app-report-issue-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatFormFieldModule, MatInputModule,
    MatButtonModule, MatIconModule,
    MatDialogModule, MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title>Sorun Bildir</h2>
    <mat-dialog-content>
      <div class="ctx">
        <div><span style="color:var(--bp-fg-3)">İçerik:</span>&nbsp;<strong>{{ data.schedule.title }}</strong></div>
        <div><span style="color:var(--bp-fg-3)">Tarih:</span>&nbsp;{{ formatDate(data.schedule.startTime) }}</div>
        <div><span style="color:var(--bp-fg-3)">Saat:</span>&nbsp;{{ formatTime(data.schedule.startTime) }} – {{ formatTime(data.schedule.endTime) }}</div>
      </div>

      <mat-form-field appearance="outline" style="width:100%">
        <mat-label>Açıklama</mat-label>
        <textarea matInput
                  [(ngModel)]="description"
                  rows="5"
                  maxlength="2000"
                  placeholder="Yayında yaşanan sorunu kısaca açıklayın…"></textarea>
        <mat-hint align="end">{{ description.length }}/2000</mat-hint>
      </mat-form-field>

      @if (errorMsg()) {
        <p style="color:#f44336;font-size:12px;margin:4px 0 0">{{ errorMsg() }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>İptal</button>
      <button mat-raised-button color="warn"
              [disabled]="saving() || !description.trim()"
              (click)="save()">
        @if (saving()) { <mat-spinner diameter="18" style="display:inline-block"></mat-spinner> }
        @else { Gönder }
      </button>
    </mat-dialog-actions>
  `,
})
export class ReportIssueDialogComponent {
  data      = inject<{ schedule: Schedule }>(MAT_DIALOG_DATA);
  dialogRef = inject(MatDialogRef<ReportIssueDialogComponent>);
  api       = inject(ApiService);
  saving    = signal(false);
  errorMsg  = signal('');
  description = '';

  formatDate(iso: string): string {
    return formatIstanbulDateTr(iso);
  }
  formatTime(iso: string): string {
    return formatIstanbulTime(iso);
  }

  save() {
    if (!this.description.trim()) return;
    this.saving.set(true);
    this.errorMsg.set('');
    const s = this.data.schedule;
    this.api.post('/incidents/report', {
      scheduleId:  s.id,
      title:       s.title,
      startTime:   s.startTime,
      endTime:     s.endTime,
      channel:     '',
      description: this.description.trim(),
    }).subscribe({
      next:  () => { this.saving.set(false); this.dialogRef.close(true); },
      error: (e) => {
        this.saving.set(false);
        this.errorMsg.set(e?.error?.message ?? 'Sorun bildirilemedi, tekrar deneyin.');
      },
    });
  }
}

// ── Ana Liste Bileşeni ────────────────────────────────────────────────────────
@Component({
  selector: 'app-schedule-list',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatTableModule, MatButtonModule, MatIconModule,
    MatInputModule, MatFormFieldModule,
    MatProgressSpinnerModule, MatSnackBarModule, MatTooltipModule,
    MatDialogModule, MatCardModule, MatPaginatorModule,
    MatDividerModule,
  ],
  template: `
    <div id="live-plan-fullscreen" class="page-container">

      <!-- Üst Bar -->
      <div class="top-bar">
        <div class="date-nav">
          <button mat-icon-button (click)="prevDay()" matTooltip="Önceki gün">
            <mat-icon>chevron_left</mat-icon>
          </button>
          <input class="date-input" type="date" [(ngModel)]="selectedDate" (change)="load()">
          <button mat-icon-button (click)="nextDay()" matTooltip="Sonraki gün">
            <mat-icon>chevron_right</mat-icon>
          </button>
          <button mat-stroked-button (click)="goToday()" class="today-btn">Bugün</button>
        </div>

        <div class="top-actions">
          <button mat-stroked-button (click)="toggleFullscreen()" matTooltip="Tam ekran">
            <mat-icon>{{ fullscreenActive() ? 'fullscreen_exit' : 'fullscreen' }}</mat-icon>
            {{ fullscreenActive() ? 'Tam Ekrandan Çık' : 'Tam Ekran' }}
          </button>
          @if (canAdd()) {
            <button mat-raised-button color="primary" (click)="openAddDialog()">
              <mat-icon>add</mat-icon> Yeni Ekle
            </button>
          }
        </div>
      </div>

      <!-- Tablo -->
      @if (loading()) {
        <div class="spinner-container"><mat-spinner diameter="40"></mat-spinner></div>
      } @else {
        <div class="table-wrapper">
          <table class="broadcast-table">
            <thead>
              <tr>
                <th>Saat</th>
                <th>Yayın Adı</th>
                <th colspan="2">Trans. Saati</th>
                <th>Mod Tipi /<br>Coding Tipi</th>
                <th>IRD</th>
                <th>Fiber</th>
                <th>Demod</th>
                <th>Kayıt Yeri</th>
                <th>TIE</th>
                <th>Sanal</th>
                <th>HDVG</th>
                <th>Int</th>
                <th>Off Tube</th>
                <th>Dil</th>
                <th>Kanal</th>
                <th>Lig / Hafta</th>
                <th>Açıklama ve Notlar</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @if (schedules().length === 0) {
                <tr>
                  <td colspan="19" class="no-data">Bu tarih için kayıt bulunamadı</td>
                </tr>
              }
              @for (s of schedules(); track s.id; let odd = $odd) {
                <tr [class.row-odd]="odd" [class.row-even]="!odd"
                    [class.has-league-color]="scheduleLeagueName(s) && !isTransmissionFinished(s)"
                    [class.transmission-finished]="isTransmissionFinished(s)"
                    [style.background]="scheduleRowColor(s)">
                  <td class="td-time">{{ s.startTime | date:'HH:mm' }}</td>
                  <td class="td-title">
                    <span class="content-main">{{ s.title }}</span>
                  </td>
                  <td class="td-trans">{{ s.startTime | date:'HH:mm' }}</td>
                  <td class="td-trans">{{ s.endTime   | date:'HH:mm' }}</td>
                  <td class="td-mod">
                    <div>{{ s.technicalDetails?.modulationTypeName ?? '—' }}</div>
                    <div class="td-mod-sub">{{ s.technicalDetails?.videoCodingName ?? '—' }}</div>
                  </td>
                  <td class="td-mono td-stack">{{ techStack3(s.technicalDetails?.ird1Name, s.technicalDetails?.ird2Name, s.technicalDetails?.ird3Name) }}</td>
                  <td class="td-mono td-stack">{{ techStack2(s.technicalDetails?.fiber1Name, s.technicalDetails?.fiber2Name) }}</td>
                  <td class="td-mono">{{ s.technicalDetails?.demodName ?? '—' }}</td>
                  <td class="td-mono td-record-location">{{ formatRecordingPorts(s) }}</td>
                  <td class="td-mono">{{ s.technicalDetails?.tieName ?? '—' }}</td>
                  <td class="td-mono">{{ s.technicalDetails?.virtualResourceName ?? '—' }}</td>
                  <td class="td-mono">{{ s.technicalDetails?.hdvgResourceName ?? '—' }}</td>
                  <td class="td-mono">{{ techStack2(s.technicalDetails?.int1ResourceName, s.technicalDetails?.int2ResourceName) }}</td>
                  <td class="td-mono">{{ s.technicalDetails?.offTubeName ?? '—' }}</td>
                  <td class="td-lang">{{ langPair(s.technicalDetails?.languageName, s.technicalDetails?.secondLanguageName) }}</td>
                  <td class="td-channel">{{ channelTriplet(s) }}</td>
                  <td class="td-league">{{ s.leagueName ?? '—' }}</td>
                  <td class="td-notes">{{ s.operationNotes ?? '—' }}</td>
                  <td class="td-actions">
                    @if (canEdit()) {
                      <button mat-icon-button
                              matTooltip="Düzenle"
                              (click)="openEditDialog(s)">
                        <mat-icon>edit</mat-icon>
                      </button>
                    }
                    @if (canTechnicalEdit()) {
                      <button mat-icon-button
                              matTooltip="Teknik Detayları Düzenle"
                              (click)="openTechnicalDialog(s)">
                        <mat-icon>settings_input_component</mat-icon>
                      </button>
                    }
                    @if (canDuplicate()) {
                      <button mat-icon-button
                              matTooltip="Materyali çoğalt"
                              (click)="duplicateSchedule(s)">
                        <mat-icon>add</mat-icon>
                      </button>
                    }
                    @if (canReportIssue()) {
                      <button mat-icon-button
                              matTooltip="Sorun Bildir"
                              style="color:#ff7043"
                              (click)="openReportIssueDialog(s)">
                        <mat-icon>report_problem</mat-icon>
                      </button>
                    }
                    @if (canDelete()) {
                      <button mat-icon-button color="warn"
                              matTooltip="Sil"
                              (click)="deleteSchedule(s)">
                        <mat-icon>delete</mat-icon>
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        <div class="table-footer">
          <span class="record-count">{{ total() }} kayıt</span>
          <mat-paginator
            [length]="total()"
            [pageSize]="pageSize"
            [pageSizeOptions]="[50, 100, 200]"
            (page)="onPage($event)">
          </mat-paginator>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }

    .page-container { padding: var(--bp-sp-6) var(--bp-sp-8) var(--bp-sp-8); }
    #live-plan-fullscreen:fullscreen {
      display:flex;
      flex-direction:column;
      height:100vh;
      background: var(--bp-bg-1);
      overflow:hidden;
      zoom:100%;
      padding: 0;
    }
    #live-plan-fullscreen:fullscreen .top-bar,
    #live-plan-fullscreen:fullscreen .table-footer {
      flex:0 0 auto;
    }
    #live-plan-fullscreen:fullscreen .table-wrapper {
      flex:1 1 auto;
      height:auto;
      min-height:0;
      overflow:auto;
    }
    #live-plan-fullscreen:fullscreen .broadcast-table thead th {
      position:sticky;
      top:0;
      z-index:5;
    }

    .top-bar {
      display:flex; align-items:center; gap: var(--bp-sp-3); flex-wrap:wrap;
      padding: var(--bp-sp-3) var(--bp-sp-4);
      background: var(--bp-bg-2);
      border: 1px solid var(--bp-line-2);
      border-radius: var(--bp-r-lg);
      margin-bottom: var(--bp-sp-3);
    }
    .date-nav { display:flex; align-items:center; gap: 4px; }
    .date-input {
      background: var(--bp-bg-0);
      color: var(--bp-fg-1);
      border: 1px solid var(--bp-line-2);
      border-radius: var(--bp-r-sm);
      padding: 6px 10px;
      font-size: 12.5px;
      font-family: var(--bp-font-mono);
      outline: none;
      cursor: pointer;
    }
    .date-input::-webkit-calendar-picker-indicator { filter: invert(1); cursor: pointer; }
    .today-btn { margin-left: 4px; font-size: 12px; min-width: 60px; }
    .top-actions { margin-left: auto; display: flex; align-items: center; gap: var(--bp-sp-2); flex-wrap: wrap; }

    .table-wrapper {
      overflow-x: auto;
      background: var(--bp-bg-2);
      border: 1px solid var(--bp-line-2);
      border-radius: var(--bp-r-lg);
    }
    .broadcast-table {
      width: max-content; min-width: 100%; border-collapse: collapse;
      font-size: 12.5px;
    }
    .broadcast-table thead tr { background: var(--bp-bg-0); }
    .broadcast-table thead th {
      padding: 8px 10px; text-align: center;
      border-bottom: 1px solid var(--bp-line-2);
      border-right: 1px solid var(--bp-line-2);
      white-space: normal;
      font-weight: var(--bp-fw-bold);
      font-size: 10.5px;
      line-height: 1.2;
      letter-spacing: var(--bp-ls-eyebrow);
      color: var(--bp-purple-300);
      text-transform: uppercase;
    }
    .broadcast-table thead th:last-child { border-right: 0; }
    .broadcast-table tbody tr {
      border-bottom: 1px solid var(--bp-line-2);
      transition: background var(--bp-dur-fast);
    }
    .broadcast-table tbody tr:last-child { border-bottom: 0; }
    .broadcast-table tbody tr:hover { background: rgba(124, 58, 237, 0.08); }
    .broadcast-table tbody tr.has-league-color:hover { filter: brightness(1.10); }
    .broadcast-table tbody tr.transmission-finished:hover { filter: brightness(1.06); }
    .row-even { background: var(--bp-bg-2); }
    .row-odd  { background: var(--bp-bg-3); }

    .broadcast-table td {
      padding: 6px 8px;
      border-right: 1px solid var(--bp-line-2);
      vertical-align: middle;
      color: var(--bp-fg-1);
    }
    .broadcast-table td:last-child { border-right: 0; }
    .broadcast-table tbody td:not(.td-actions) {
      font-size: 13px;
      font-weight: var(--bp-fw-medium);
      line-height: 1.25;
      text-align: center;
    }
    .no-data { text-align: center; padding: 32px; color: var(--bp-fg-3); font-size: 13px; }

    .td-time {
      font-weight: var(--bp-fw-bold);
      color: var(--bp-purple-300);
      font-family: var(--bp-font-mono);
      white-space: nowrap;
      min-width: 56px;
    }
    .td-title { min-width: 200px; max-width: 280px; }
    .content-main { font-weight: var(--bp-fw-semibold); display: block; color: var(--bp-fg-1); }
    .td-trans {
      white-space: nowrap;
      color: var(--bp-fg-3);
      font-family: var(--bp-font-mono);
      min-width: 50px;
      text-align: center;
    }
    .td-mono { font-family: var(--bp-font-mono); color: var(--bp-fg-2); text-align: center; }
    .td-mod  { font-family: var(--bp-font-mono); color: var(--bp-fg-2); text-align: center; line-height: 1.18; }
    .td-mod-sub { color: var(--bp-fg-3); font-size: 0.85em; }
    .td-stack { line-height: 1.20; }
    .td-stack > div { white-space: nowrap; }
    .td-stack > div + div { margin-top: 1px; color: var(--bp-fg-3); }
    .td-lang { text-align: center; color: var(--bp-fg-2); white-space: nowrap; }
    .td-channel {
      color: var(--bp-purple-300);
      font-weight: var(--bp-fw-semibold);
      white-space: nowrap;
      min-width: 110px;
    }
    .td-league {
      color: var(--bp-fg-3);
      white-space: normal;
      font-size: 11px !important;
      font-weight: var(--bp-fw-medium) !important;
      line-height: 1.18;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      max-width: 120px;
      min-width: 80px;
    }
    .td-notes {
      min-width: 320px;
      max-width: 480px;
      color: var(--bp-fg-2);
      white-space: normal;
      text-align: left !important;
    }
    .td-record-location { color: var(--bp-fg-2); }
    .td-actions { width: 200px; padding: 2px 4px; text-align: center; white-space: nowrap; }

    .table-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--bp-sp-2) var(--bp-sp-4);
      margin-top: var(--bp-sp-3);
      background: var(--bp-bg-2);
      border: 1px solid var(--bp-line-2);
      border-radius: var(--bp-r-lg);
    }
    .record-count { font-size: 12px; color: var(--bp-fg-3); }
    .spinner-container { display: flex; justify-content: center; padding: 64px; }
  `],
})
export class ScheduleListComponent implements OnInit, OnDestroy {
  private scheduleSvc = inject(ScheduleService);
  private api         = inject(ApiService);
  private snack       = inject(MatSnackBar);
  private dialog      = inject(MatDialog);
  private keycloak    = inject(KeycloakService);
  private router      = inject(Router);

  channels         = signal<Channel[]>([]);
  schedules        = signal<Schedule[]>([]);
  total            = signal(0);
  loading          = signal(false);
  currentTime      = signal(Date.now());
  selectedDate     = istanbulTodayDate();
  fullscreenActive = signal(false);
  private _userGroups = signal<string[]>([]);

  // Mutation restore (2026-05-10): canonical livePlan permission keys.
  canAdd            = computed(() => hasGroup(this._userGroups(), PERMISSIONS.livePlan.write));
  canEdit           = computed(() => hasGroup(this._userGroups(), PERMISSIONS.livePlan.write));
  canTechnicalEdit  = computed(() => hasGroup(this._userGroups(), PERMISSIONS.livePlan.write));
  canDuplicate      = computed(() => hasGroup(this._userGroups(), PERMISSIONS.livePlan.write));
  canDelete         = computed(() => hasGroup(this._userGroups(), PERMISSIONS.livePlan.delete));
  canReportIssue    = computed(() => hasGroup(this._userGroups(), PERMISSIONS.incidents.reportIssue));

  pageSize = 100;
  page     = 1;
  private clockTimer?: ReturnType<typeof setInterval>;

  ngOnInit() {
    this.clockTimer = setInterval(() => this.currentTime.set(Date.now()), 60_000);
    if (isSkipAuthAllowed()) {
      this._userGroups.set([GROUP.SystemEng]);
    } else {
      const parsed = this.keycloak.getKeycloakInstance().tokenParsed as BcmsTokenParsed | undefined;
      const groups: string[] = parsed?.groups ?? [];
      this._userGroups.set(groups);
    }
    this.api.get<Channel[]>('/channels/catalog').subscribe({
      next: (res) => this.channels.set(Array.isArray(res) ? res : []),
    });
    this.load();
  }

  ngOnDestroy() {
    if (this.clockTimer) clearInterval(this.clockTimer);
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange() {
    this.fullscreenActive.set(document.fullscreenElement?.id === 'live-plan-fullscreen');
  }

  async toggleFullscreen() {
    if (document.fullscreenElement?.id === 'live-plan-fullscreen') {
      await document.exitFullscreen();
      return;
    }
    await document.getElementById('live-plan-fullscreen')?.requestFullscreen();
  }

  scheduleLeagueName(_s: Schedule): string {
    return '';
  }

  scheduleRowColor(s: Schedule): string {
    return this.isTransmissionFinished(s) ? '#55595f' : leagueBackground('');
  }

  isTransmissionFinished(s: Schedule): boolean {
    return transmissionEndDate(s).getTime() <= this.currentTime();
  }

  channelName(channelId: number | null | undefined): string {
    if (channelId == null) return '—';
    return this.channels().find((c) => c.id === channelId)?.name ?? '—';
  }

  formatRecordingPorts(s: Schedule): string {
    const primary = (s as Schedule & { recordingPort?: string | null }).recordingPort?.trim();
    const backup  = (s as Schedule & { backupRecordingPort?: string | null }).backupRecordingPort?.trim();
    if (primary && backup) return `${primary} - ${backup}`;
    if (primary) return primary;
    return '';
  }

  /** 2026-05-11: liste display yardımcıları — technicalDetails alanlarını
   *  görsel kompakt formata sokar. Tüm değerler null ise "—" döner. */
  channelTriplet(s: Schedule): string {
    const parts = [s.channel1Id, s.channel2Id, s.channel3Id]
      .map((id) => this.channelName(id));
    if (parts.every((p) => p === '—')) return '—';
    return parts.join(' / ');
  }

  techStack2(a: string | null | undefined, b: string | null | undefined): string {
    const vals = [a, b].filter((v): v is string => !!v && v.length > 0);
    return vals.length ? vals.join(' / ') : '—';
  }

  techStack3(a: string | null | undefined, b: string | null | undefined, c: string | null | undefined): string {
    const vals = [a, b, c].filter((v): v is string => !!v && v.length > 0);
    return vals.length ? vals.join(' / ') : '—';
  }

  langPair(main: string | null | undefined, second: string | null | undefined): string {
    if (!main && !second) return '—';
    if (main && second)   return `${main} / ${second}`;
    return (main ?? second) as string;
  }

  load() {
    this.loading.set(true);
    const { from, to } = istanbulDayRangeUtc(this.selectedDate);

    const params: ScheduleFilter = { from, to, page: this.page, pageSize: this.pageSize };

    this.scheduleSvc.getSchedules(params).subscribe({
      next: (res) => {
        const localMins = (iso: string) => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };
        const sorted = [...res.data].sort((a, b) => localMins(a.startTime) - localMins(b.startTime));
        this.schedules.set(sorted);
        this.total.set(res.total);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  prevDay() {
    const d = new Date(this.selectedDate);
    d.setDate(d.getDate() - 1);
    this.selectedDate = d.toISOString().slice(0, 10);
    this.page = 1; this.load();
  }

  nextDay() {
    const d = new Date(this.selectedDate);
    d.setDate(d.getDate() + 1);
    this.selectedDate = d.toISOString().slice(0, 10);
    this.page = 1; this.load();
  }

  goToday() {
    this.selectedDate = istanbulTodayDate();
    this.page = 1; this.load();
  }

  // ── Mutation aksiyonları (2026-05-10 mutation restore) ────────────────
  // Canonical command path: /api/v1/live-plan*. Legacy /schedules YOK.

  openAddDialog() {
    const ref = this.dialog.open(LivePlanEntryAddDialogComponent, {
      width: '720px',
      maxWidth: '98vw',
      panelClass: 'dark-dialog',
    });
    ref.afterClosed().subscribe((created) => {
      if (created) {
        this.snack.open('Yayın kaydı eklendi', 'Kapat', { duration: 3000 });
        this.load();
      }
    });
  }

  openEditDialog(s: Schedule) {
    const ref = this.dialog.open(LivePlanEntryEditDialogComponent, {
      data: { schedule: s },
      width: '720px',
      maxWidth: '98vw',
      panelClass: 'dark-dialog',
    });
    ref.afterClosed().subscribe((result) => {
      if (result?.stale) {
        this.load();
        return;
      }
      if (result) {
        this.snack.open('Yayın kaydı güncellendi', 'Kapat', { duration: 3000 });
        this.load();
      }
    });
  }

  openTechnicalDialog(s: Schedule) {
    // Mutation restore (2026-05-10) — Teknik buton M5-B10b form route'una
    // navigate eder. Disabled/no-op DEĞİL; gerçek aksiyon (route navigate).
    this.router.navigate(['/live-plan', s.id]);
  }

  duplicateSchedule(s: Schedule) {
    const ref = this.snack.open(`"${s.title}" çoğaltılacak`, 'Çoğalt', { duration: 5000 });
    ref.onAction().subscribe(() => {
      this.scheduleSvc.duplicateLivePlanEntry(s.id).subscribe({
        next:  () => {
          this.snack.open('Yayın kaydı çoğaltıldı', 'Kapat', { duration: 2500 });
          this.load();
        },
        error: (e) => {
          const msg = e?.status === 409
            ? 'Aynı eventKey ile aktif kayıt var; yeni duplicate oluşturulamadı'
            : (e?.error?.message ?? e?.message ?? 'Çoğaltma başarısız');
          this.snack.open(msg, 'Kapat', { duration: 4000 });
        },
      });
    });
  }

  deleteSchedule(s: Schedule) {
    const ref = this.snack.open(`"${s.title}" silinecek`, 'Sil', { duration: 5000 });
    ref.onAction().subscribe(() => {
      this.scheduleSvc.deleteLivePlanEntry(s.id, s.version).subscribe({
        next:  () => {
          this.snack.open('Yayın kaydı silindi', 'Kapat', { duration: 2000 });
          this.load();
        },
        error: (e) => {
          const msg = e?.status === 412
            ? 'Kayıt başka biri tarafından güncellendi; lütfen yenileyip tekrar deneyin'
            : (e?.error?.message ?? e?.message ?? 'Silme başarısız');
          this.snack.open(msg, 'Kapat', { duration: 4000 });
          if (e?.status === 412) this.load();
        },
      });
    });
  }

  openReportIssueDialog(s: Schedule) {
    const ref = this.dialog.open(ReportIssueDialogComponent, {
      data: { schedule: s },
      width: '560px',
      maxWidth: '98vw',
      panelClass: 'dark-dialog',
    });
    ref.afterClosed().subscribe((ok) => {
      if (ok) this.snack.open('Sorun bildirildi', 'Kapat', { duration: 3000 });
    });
  }

  onPage(e: PageEvent) {
    this.page     = e.pageIndex + 1;
    this.pageSize = e.pageSize;
    this.load();
  }
}
