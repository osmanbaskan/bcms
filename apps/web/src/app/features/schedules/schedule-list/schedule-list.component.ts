import {
  Component, OnInit, signal, inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';

import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialogModule, MatDialog, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatChipsModule } from '@angular/material/chips';
import { MatCardModule } from '@angular/material/card';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatDividerModule } from '@angular/material/divider';

import { ScheduleService } from '../../../core/services/schedule.service';
import { ApiService } from '../../../core/services/api.service';
import type { Schedule, OptaCompetition, OptaMatch } from '@bcms/shared';

interface Channel { id: number; name: string; type: string; }

// ── Kayıt Ekle Dialog ─────────────────────────────────────────────────────────
@Component({
  selector: 'app-schedule-add-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ReactiveFormsModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule, MatDialogModule,
    MatProgressSpinnerModule, MatDividerModule,
  ],
  template: `
    <h2 mat-dialog-title>Yeni Yayın Kaydı Ekle</h2>
    <mat-dialog-content>
      <form [formGroup]="form" class="dialog-form">

        <!-- ── OPTA Fikstür Seçimi ──────────────────────────────────────── -->
        <div class="section-header">
          <mat-icon>sports_soccer</mat-icon>
          <span>OPTA Fikstüründen Seç <em>(opsiyonel)</em></span>
        </div>
        <div class="form-row">
          <mat-form-field>
            <mat-label>Lig / Turnuva</mat-label>
            <mat-select [value]="optaCompId()"
                        (selectionChange)="onOptaCompChange($event.value)"
                        [disabled]="optaCompsLoading()">
              <mat-option [value]="null">— Seçin —</mat-option>
              @for (c of optaComps(); track c.id) {
                <mat-option [value]="c.id">{{ c.name }}</mat-option>
              }
            </mat-select>
            @if (optaCompsLoading()) { <mat-hint>Yükleniyor…</mat-hint> }
          </mat-form-field>

          <mat-form-field>
            <mat-label>Sezon</mat-label>
            <mat-select [value]="optaSeason()"
                        (selectionChange)="onOptaSeasonChange($event.value)"
                        [disabled]="optaSeasons().length === 0">
              <mat-option [value]="null">— Seçin —</mat-option>
              @for (s of optaSeasons(); track s) {
                <mat-option [value]="s">{{ s }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>

        @if (optaMatchesLoading()) {
          <div class="loading-row">
            <mat-spinner diameter="18"></mat-spinner><span>Maçlar yükleniyor…</span>
          </div>
        }
        @if (optaMatches().length > 0) {
          <div class="form-row">
            <mat-form-field class="full-width">
              <mat-label>Maç</mat-label>
              <mat-select [value]="selectedOptaMatchId()"
                          (selectionChange)="onOptaMatchSelect($event.value)">
                <mat-option [value]="null">— Maç seçin —</mat-option>
                @for (m of optaMatches(); track m.matchId) {
                  <mat-option [value]="m.matchId">
                    {{ m.homeTeamName }} - {{ m.awayTeamName }}
                    &nbsp;({{ m.matchDate | date:'dd MMM yyyy HH:mm' }})
                  </mat-option>
                }
              </mat-select>
            </mat-form-field>
          </div>
        }

        <mat-divider style="margin:8px 0 12px"></mat-divider>

        <!-- ── Temel Alanlar ─────────────────────────────────────────────── -->
        <div class="form-row">
          <mat-form-field>
            <mat-label>Kanal *</mat-label>
            <mat-select formControlName="channelId">
              @for (ch of data.channels; track ch.id) {
                <mat-option [value]="ch.id">{{ ch.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Tarih *</mat-label>
            <input matInput type="date" formControlName="date">
          </mat-form-field>
        </div>
        <div class="form-row">
          <mat-form-field>
            <mat-label>Saat (Başlangıç) *</mat-label>
            <input matInput type="time" formControlName="startTime" step="1">
          </mat-form-field>
          <mat-form-field>
            <mat-label>Saat (Bitiş) *</mat-label>
            <input matInput type="time" formControlName="endTime" step="1">
          </mat-form-field>
        </div>
        <div class="form-row">
          <mat-form-field>
            <mat-label>Trans. Başlangıç</mat-label>
            <input matInput type="time" formControlName="transStart" step="1">
          </mat-form-field>
          <mat-form-field>
            <mat-label>Trans. Bitiş</mat-label>
            <input matInput type="time" formControlName="transEnd" step="1">
          </mat-form-field>
        </div>
        <div class="form-row">
          <mat-form-field class="full-width">
            <mat-label>Yayın Adı *</mat-label>
            <input matInput formControlName="contentName" placeholder="İçerik adı">
          </mat-form-field>
        </div>
        <div class="form-row">
          <mat-form-field class="full-width">
            <mat-label>Başlık (Opsiyonel)</mat-label>
            <input matInput formControlName="title" placeholder="Başlık">
          </mat-form-field>
        </div>
        <div class="form-row">
          <mat-form-field>
            <mat-label>HDVG</mat-label>
            <input matInput formControlName="houseNumber">
          </mat-form-field>
          <mat-form-field>
            <mat-label>Int</mat-label>
            <input matInput formControlName="intField">
          </mat-form-field>
          <mat-form-field>
            <mat-label>Off Tube</mat-label>
            <input matInput formControlName="offTube">
          </mat-form-field>
        </div>
        <div class="form-row">
          <mat-form-field>
            <mat-label>Dil</mat-label>
            <mat-select formControlName="language">
              <mat-option value="Yok">Yok</mat-option>
              <mat-option value="TR">Türkçe</mat-option>
              <mat-option value="Eng">İngilizce</mat-option>
              <mat-option value="FR">Fransızca</mat-option>
              <mat-option value="ES">İspanyolca</mat-option>
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Lig</mat-label>
            <input matInput formControlName="league" placeholder="Premier League, TSL...">
          </mat-form-field>
        </div>
        <div class="form-row">
          <mat-form-field class="full-width">
            <mat-label>Açıklama ve Notlar</mat-label>
            <textarea matInput formControlName="notes" rows="2"></textarea>
          </mat-form-field>
        </div>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>İptal</button>
      <button mat-raised-button color="primary"
              [disabled]="form.invalid || saving()"
              (click)="save()">
        {{ saving() ? 'Kaydediliyor…' : 'Kaydet' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .dialog-form  { display:flex; flex-direction:column; gap:0; min-width:540px; }
    .form-row     { display:flex; gap:12px; }
    .form-row mat-form-field { flex:1; }
    .full-width   { width:100%; }
    .section-header {
      display:flex; align-items:center; gap:6px;
      font-size:13px; color:#aaa; margin-bottom:4px;
    }
    .section-header em { color:#666; font-style:normal; }
    .section-header mat-icon { font-size:18px; height:18px; width:18px; }
    .loading-row { display:flex; align-items:center; gap:8px; color:#aaa; font-size:12px; margin-bottom:8px; }
  `],
})
export class ScheduleAddDialogComponent {
  data      = inject<{ channels: Channel[] }>(MAT_DIALOG_DATA);
  dialogRef = inject(MatDialogRef<ScheduleAddDialogComponent>);
  api       = inject(ApiService);
  fb        = inject(FormBuilder);
  saving    = signal(false);

  // OPTA sinyalleri
  optaComps           = signal<OptaCompetition[]>([]);
  optaCompsLoading    = signal(false);
  optaCompId          = signal<string | null>(null);
  optaSeasons         = signal<string[]>([]);
  optaSeason          = signal<string | null>(null);
  optaMatches         = signal<OptaMatch[]>([]);
  optaMatchesLoading  = signal(false);
  selectedOptaMatchId = signal<string | null>(null);

  form = this.fb.group({
    channelId:   [null as number | null, Validators.required],
    date:        [new Date().toISOString().slice(0, 10), Validators.required],
    startTime:   ['', Validators.required],
    endTime:     ['', Validators.required],
    transStart:  [''],
    transEnd:    [''],
    contentName: ['', Validators.required],
    title:       [''],
    houseNumber: [''],
    intField:    [''],
    offTube:     [''],
    language:    ['Yok'],
    league:      [''],
    notes:       [''],
  });

  constructor() {
    // Dialog açılınca OPTA competition listesini yükle
    this.optaCompsLoading.set(true);
    this.api.get<OptaCompetition[]>('/opta/competitions').subscribe({
      next:  (c) => { this.optaComps.set(c); this.optaCompsLoading.set(false); },
      error: ()  => { this.optaCompsLoading.set(false); },
    });
  }

  onOptaCompChange(compId: string | null) {
    this.optaCompId.set(compId);
    this.optaSeason.set(null);
    this.optaMatches.set([]);
    this.selectedOptaMatchId.set(null);
    if (!compId) { this.optaSeasons.set([]); return; }

    const seasons = [...(this.optaComps().find((c) => c.id === compId)?.seasons ?? [])].sort().reverse();
    this.optaSeasons.set(seasons);
    if (seasons.length === 1) this.onOptaSeasonChange(seasons[0]);
  }

  onOptaSeasonChange(season: string | null) {
    this.optaSeason.set(season);
    this.optaMatches.set([]);
    this.selectedOptaMatchId.set(null);
    if (!season || !this.optaCompId()) return;

    this.optaMatchesLoading.set(true);
    this.api.get<OptaMatch[]>(`/opta/matches?competitionId=${this.optaCompId()}&season=${season}`).subscribe({
      next:  (ms) => { this.optaMatches.set(ms); this.optaMatchesLoading.set(false); },
      error: ()   => { this.optaMatchesLoading.set(false); },
    });
  }

  onOptaMatchSelect(matchId: string | null) {
    this.selectedOptaMatchId.set(matchId);
    const match = this.optaMatches().find((m) => m.matchId === matchId);
    if (!match) return;

    // Yayın Adı: "HomeTeam - AwayTeam"
    this.form.patchValue({ contentName: `${match.homeTeamName} - ${match.awayTeamName}` });
    // Lig: competition adı
    this.form.patchValue({ league: match.competitionName });
    // Tarih ve başlangıç saatini doldur
    const dt = new Date(match.matchDate);
    this.form.patchValue({
      date:      dt.toISOString().slice(0, 10),
      startTime: `${pad(dt.getHours())}:${pad(dt.getMinutes())}:00`,
      endTime:   `${pad((dt.getHours() + 2) % 24)}:${pad(dt.getMinutes())}:00`,
    });
  }

  save() {
    if (this.form.invalid) return;
    const v = this.form.value;
    const toISO = (time: string) => new Date(`${v.date}T${time}+03:00`).toISOString();

    const body = {
      channelId: v.channelId!,
      startTime: toISO(v.startTime!),
      endTime:   toISO(v.endTime!),
      title:     v.contentName!,
      metadata: {
        contentName:    v.contentName,
        transStart:     v.transStart  || undefined,
        transEnd:       v.transEnd    || undefined,
        houseNumber:    v.houseNumber || undefined,
        intField:       v.intField    || undefined,
        offTube:        v.offTube     || undefined,
        language:       v.language    || 'Yok',
        league:         v.league      || undefined,
        description:    v.notes       || undefined,
        optaMatchId:    this.selectedOptaMatchId() || undefined,
      },
    };

    this.saving.set(true);
    this.api.post<Schedule>('/schedules', body).subscribe({
      next:  (s) => { this.saving.set(false); this.dialogRef.close(s); },
      error: (e) => { this.saving.set(false); console.error(e); },
    });
  }
}

function pad(n: number) { return String(n).padStart(2, '0'); }

// ── Ana Liste Bileşeni ────────────────────────────────────────────────────────
@Component({
  selector: 'app-schedule-list',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatTableModule, MatButtonModule, MatIconModule,
    MatInputModule, MatSelectModule, MatFormFieldModule,
    MatProgressSpinnerModule, MatSnackBarModule, MatTooltipModule,
    MatDialogModule, MatChipsModule, MatCardModule, MatPaginatorModule,
  ],
  template: `
    <div class="page-container">

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

        <div class="top-filters">
          <mat-form-field class="channel-filter" subscriptSizing="dynamic">
            <mat-label>Kanal</mat-label>
            <mat-select [(ngModel)]="selectedChannelId" (selectionChange)="load()">
              <mat-option [value]="null">Tümü</mat-option>
              @for (ch of channels(); track ch.id) {
                <mat-option [value]="ch.id">{{ ch.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>

        <div class="top-actions">
          <button mat-raised-button color="primary" (click)="openAddDialog()">
            <mat-icon>add</mat-icon> Yeni Ekle
          </button>
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
                <th>HDVG</th>
                <th>Int</th>
                <th>Off Tube</th>
                <th>Dil</th>
                <th>Kanal</th>
                <th>Lig</th>
                <th>Açıklama ve Notlar</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @if (schedules().length === 0) {
                <tr>
                  <td colspan="12" class="no-data">Bu tarih için kayıt bulunamadı</td>
                </tr>
              }
              @for (s of schedules(); track s.id; let odd = $odd) {
                <tr [class.row-odd]="odd" [class.row-even]="!odd">
                  <td class="td-time">{{ s.startTime | date:'HH:mm' }}</td>
                  <td class="td-title">
                    <span class="content-main">{{ s.metadata?.['contentName'] || s.title }}</span>
                  </td>
                  <td class="td-trans">{{ s.startTime | date:'HH:mm' }}</td>
                  <td class="td-trans">{{ s.endTime | date:'HH:mm' }}</td>
                  <td class="td-mono">{{ s.metadata?.['houseNumber'] ?? '' }}</td>
                  <td class="td-mono">{{ s.metadata?.['intField'] ?? '' }}</td>
                  <td class="td-mono">{{ s.metadata?.['offTube'] ?? '' }}</td>
                  <td class="td-lang">{{ s.metadata?.['language'] ?? 'Yok' }}</td>
                  <td class="td-channel">{{ s.channel?.name ?? '—' }}</td>
                  <td class="td-league">{{ s.metadata?.['league'] ?? '' }}</td>
                  <td class="td-notes">{{ s.metadata?.['description'] || s.title }}</td>
                  <td class="td-actions">
                    <button mat-icon-button color="warn"
                            matTooltip="Sil"
                            (click)="deleteSchedule(s)">
                      <mat-icon>delete</mat-icon>
                    </button>
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

    .page-container { padding:0; }

    /* ── Üst bar ── */
    .top-bar {
      display:flex; align-items:center; gap:16px; flex-wrap:wrap;
      padding:12px 16px;
      background:#1a1a2e;
      border-bottom:1px solid rgba(255,255,255,0.08);
      margin-bottom:0;
    }
    .date-nav {
      display:flex; align-items:center; gap:4px;
    }
    .date-input {
      background:#2d2d44; color:#fff; border:1px solid rgba(255,255,255,0.2);
      border-radius:4px; padding:6px 10px; font-size:0.9rem;
      outline:none; cursor:pointer;
    }
    .date-input::-webkit-calendar-picker-indicator { filter:invert(1); cursor:pointer; }
    .today-btn { margin-left:4px; font-size:0.8rem; min-width:60px; }
    .channel-filter { min-width:180px; }
    .top-filters { flex:1; }
    .top-actions { margin-left:auto; }

    /* ── Tablo ── */
    .table-wrapper {
      overflow-x:auto;
    }
    .broadcast-table {
      width:100%; border-collapse:collapse;
      font-size:0.82rem;
    }
    .broadcast-table thead tr {
      background:#8b0000;
      color:#fff;
    }
    .broadcast-table thead th {
      padding:8px 10px; text-align:left;
      border:1px solid rgba(255,255,255,0.15);
      white-space:nowrap; font-weight:600;
    }
    .broadcast-table tbody tr {
      border-bottom:1px solid rgba(255,255,255,0.06);
      transition:background 0.15s;
    }
    .broadcast-table tbody tr:hover { background:rgba(255,255,255,0.06) !important; }
    .row-even { background:#1e1e2e; }
    .row-odd  { background:#242436; }

    .broadcast-table td {
      padding:6px 10px; border:1px solid rgba(255,255,255,0.06);
      vertical-align:middle; color:rgba(255,255,255,0.87);
    }
    .no-data { text-align:center; padding:32px; color:#666; }

    /* ── Özel hücreler ── */
    .td-time    { font-weight:700; color:#fff; white-space:nowrap; min-width:52px; }
    .td-title   { min-width:180px; max-width:240px; }
    .content-main { font-weight:500; display:block; }
    .td-trans   { white-space:nowrap; color:#aaa; min-width:48px; text-align:center; }
    .td-mono    { font-family:monospace; font-size:0.78rem; color:#90a4ae; text-align:center; }
    .td-lang    { text-align:center; color:#bdbdbd; white-space:nowrap; }
    .td-channel { color:#ffd600; font-weight:600; white-space:nowrap; min-width:110px; }
    .td-league  { color:#aaa; white-space:nowrap; }
    .td-notes   { max-width:260px; color:#bdbdbd; font-size:0.78rem; }
    .td-actions { width:40px; padding:2px 4px; text-align:center; }

    /* ── Footer ── */
    .table-footer {
      display:flex; align-items:center; justify-content:space-between;
      padding:4px 16px;
      border-top:1px solid rgba(255,255,255,0.08);
    }
    .record-count { font-size:0.82rem; color:#777; }
    .spinner-container { display:flex; justify-content:center; padding:64px; }
  `],
})
export class ScheduleListComponent implements OnInit {
  private scheduleSvc = inject(ScheduleService);
  private api         = inject(ApiService);
  private snack       = inject(MatSnackBar);
  private dialog      = inject(MatDialog);

  channels          = signal<Channel[]>([]);
  schedules         = signal<Schedule[]>([]);
  total             = signal(0);
  loading           = signal(false);
  selectedChannelId: number | null = null;
  selectedDate = new Date().toISOString().slice(0, 10);

  pageSize = 100;
  page     = 1;

  ngOnInit() {
    this.api.get<Channel[]>('/channels').subscribe({
      next: (res) => this.channels.set(Array.isArray(res) ? res : []),
    });
    this.load();
  }

  load() {
    this.loading.set(true);
    const from = new Date(`${this.selectedDate}T00:00:00+03:00`).toISOString();
    const to   = new Date(`${this.selectedDate}T23:59:59+03:00`).toISOString();

    const params: Record<string, string | number> = { from, to, page: this.page, pageSize: this.pageSize, source: 'manual' };
    if (this.selectedChannelId) params['channel'] = this.selectedChannelId;

    this.scheduleSvc.getSchedules(params as any).subscribe({
      next: (res) => {
        this.schedules.set(res.data);
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
    this.selectedDate = new Date().toISOString().slice(0, 10);
    this.page = 1; this.load();
  }

  openAddDialog() {
    const ref = this.dialog.open(ScheduleAddDialogComponent, {
      data: { channels: this.channels() },
      width: '600px',
      panelClass: 'dark-dialog',
    });
    ref.afterClosed().subscribe((result) => {
      if (result) {
        this.snack.open('Kayıt eklendi', 'Kapat', { duration: 3000 });
        this.load();
      }
    });
  }

  deleteSchedule(s: Schedule) {
    const snackRef = this.snack.open(
      `"${(s.metadata as any)?.['contentName'] || s.title}" silinecek`,
      'Sil',
      { duration: 5000 },
    );
    snackRef.onAction().subscribe(() => {
      this.api.delete(`/schedules/${s.id}`).subscribe({
        next: () => {
          this.snack.open('Silindi', '', { duration: 2000 });
          this.load();
        },
        error: (e) => this.snack.open(`Hata: ${e?.error?.message ?? e.message}`, 'Kapat', { duration: 4000 }),
      });
    });
  }

  onPage(e: PageEvent) {
    this.page     = e.pageIndex + 1;
    this.pageSize = e.pageSize;
    this.load();
  }
}
