import {
  Component, OnInit, OnDestroy, signal, computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTableModule } from '@angular/material/table';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialogModule } from '@angular/material/dialog';

import { ApiService } from '../../../core/services/api.service';
import type { Schedule, TimelineEvent } from '@bcms/shared';

const TC_EVENT_TYPES = ['NOTE', 'GO_LIVE', 'END', 'CUT', 'INSERT', 'FAULT', 'RECOVERY'];

@Component({
  selector: 'app-mcr-panel',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatCardModule, MatIconModule, MatButtonModule, MatTableModule, MatChipsModule,
    MatDividerModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatExpansionModule, MatSnackBarModule, MatTooltipModule, MatDialogModule,
  ],
  template: `
    <div class="page-container">

      <!-- ── MCR Başlığı + Saat ─────────────────────────────────────── -->
      <div class="mcr-header">
        <div class="mcr-title">
          <mat-icon>videocam</mat-icon>
          <h1>MCR — Master Control Room</h1>
        </div>
        <div class="clocks">
          <div class="clock-block">
            <span class="clock-label">UTC</span>
            <span class="clock-value">{{ utcTime() }}</span>
          </div>
          <div class="clock-block local">
            <span class="clock-label">Yerel</span>
            <span class="clock-value">{{ localTime() }}</span>
          </div>
        </div>
        <button mat-stroked-button (click)="loadAll()">
          <mat-icon>refresh</mat-icon>
        </button>
      </div>

      <!-- ── ON AIR + NEXT kartları ─────────────────────────────────── -->
      <div class="live-row">

        <!-- ON AIR -->
        <div class="live-section">
          <h2 class="section-label on-air-label">
            <span class="dot on"></span> ON AIR
          </h2>
          @if (onAir().length > 0) {
            @for (s of onAir(); track s.id) {
              <mat-card class="live-card on-air-card" [class.selected]="selectedId() === s.id"
                        (click)="selectSchedule(s)">
                <mat-card-header>
                  <mat-card-title>{{ s.channel?.name }}</mat-card-title>
                  <mat-card-subtitle>{{ s.title }}</mat-card-subtitle>
                </mat-card-header>
                <mat-card-content>
                  <div class="tc-row">
                    <span class="tc-val">{{ s.startTime | date:'HH:mm:ss' }}</span>
                    <span class="tc-sep">—</span>
                    <span class="tc-val">{{ s.endTime | date:'HH:mm:ss' }}</span>
                  </div>
                  <div class="elapsed" *ngIf="elapsed(s) as el">
                    <mat-icon>timer</mat-icon> {{ el }}
                  </div>
                </mat-card-content>
                <mat-card-actions>
                  <button mat-flat-button color="warn" (click)="endProgram(s, $event)">
                    <mat-icon>stop</mat-icon> Bitir
                  </button>
                  <button mat-icon-button matTooltip="Timeline" (click)="selectSchedule(s)">
                    <mat-icon>timeline</mat-icon>
                  </button>
                </mat-card-actions>
              </mat-card>
            }
          } @else {
            <div class="empty-live">Yayında program yok</div>
          }
        </div>

        <!-- NEXT -->
        <div class="live-section">
          <h2 class="section-label next-label">
            <span class="dot next"></span> NEXT (2 saat)
          </h2>
          @if (next().length > 0) {
            @for (s of next(); track s.id) {
              <mat-card class="live-card next-card" [class.selected]="selectedId() === s.id"
                        (click)="selectSchedule(s)">
                <mat-card-header>
                  <mat-card-title>{{ s.channel?.name }}</mat-card-title>
                  <mat-card-subtitle>{{ s.title }}</mat-card-subtitle>
                </mat-card-header>
                <mat-card-content>
                  <div class="tc-row">
                    <span class="tc-val">{{ s.startTime | date:'HH:mm:ss' }}</span>
                    <span class="tc-sep">—</span>
                    <span class="tc-val">{{ s.endTime | date:'HH:mm:ss' }}</span>
                  </div>
                  <small class="countdown">{{ countdown(s) }}</small>
                </mat-card-content>
                <mat-card-actions>
                  <button mat-flat-button color="primary" (click)="goLive(s, $event)">
                    <mat-icon>play_arrow</mat-icon> Go Live
                  </button>
                </mat-card-actions>
              </mat-card>
            }
          } @else {
            <div class="empty-live">Yaklaşan program yok</div>
          }
        </div>
      </div>

      <!-- ── Timeline Panel (seçili schedule) ──────────────────────── -->
      @if (selectedSchedule()) {
        <mat-expansion-panel class="timeline-panel" [expanded]="true">
          <mat-expansion-panel-header>
            <mat-panel-title>
              <mat-icon>timeline</mat-icon>&nbsp;
              Timeline — {{ selectedSchedule()!.title }}
              <span class="channel-badge">{{ selectedSchedule()!.channel?.name }}</span>
            </mat-panel-title>
          </mat-expansion-panel-header>

          <div class="timeline-content">
            <!-- Mevcut eventler -->
            <div class="timeline-events">
              @for (ev of timelineEvents(); track ev.id) {
                <div class="tl-event" [class]="'tl-' + ev.type">
                  <span class="tl-tc mono">{{ ev.tc }}</span>
                  <span class="tl-type">{{ ev.type }}</span>
                  <span class="tl-note">{{ ev.note }}</span>
                  <small class="tl-by">{{ ev.createdBy }}</small>
                </div>
              }
              @if (timelineEvents().length === 0) {
                <p class="no-events">Henüz olay kaydı yok</p>
              }
            </div>

            <!-- Yeni event ekle -->
            <div class="add-event-form">
              <mat-form-field appearance="outline" class="narrow">
                <mat-label>TC (HH:MM:SS:FF)</mat-label>
                <input matInput [(ngModel)]="newEvent.tc" placeholder="00:00:00:00" />
              </mat-form-field>
              <mat-form-field appearance="outline" class="narrow">
                <mat-label>Tip</mat-label>
                <mat-select [(ngModel)]="newEvent.type">
                  @for (t of tcEventTypes; track t) {
                    <mat-option [value]="t">{{ t }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline" class="wide">
                <mat-label>Not</mat-label>
                <input matInput [(ngModel)]="newEvent.note" />
              </mat-form-field>
              <button mat-flat-button color="primary" (click)="addTimelineEvent()">
                <mat-icon>add</mat-icon> Ekle
              </button>
            </div>
          </div>
        </mat-expansion-panel>
      }

      <!-- ── Rundown Tablosu ─────────────────────────────────────────── -->
      <div class="rundown-header">
        <h2 class="section-title"><mat-icon>view_list</mat-icon> Günlük Rundown</h2>
        <mat-form-field appearance="outline" class="date-field">
          <mat-label>Tarih</mat-label>
          <input matInput type="date" [(ngModel)]="rundownDate" (change)="loadRundown()" />
        </mat-form-field>
      </div>

      <mat-table [dataSource]="rundown()" class="rundown-table">
        <ng-container matColumnDef="channel">
          <mat-header-cell *matHeaderCellDef>Kanal</mat-header-cell>
          <mat-cell *matCellDef="let s">
            <span class="ch-badge">{{ s.channel?.name }}</span>
          </mat-cell>
        </ng-container>
        <ng-container matColumnDef="startTime">
          <mat-header-cell *matHeaderCellDef>Başlangıç</mat-header-cell>
          <mat-cell *matCellDef="let s" class="mono">{{ s.startTime | date:'HH:mm:ss' }}</mat-cell>
        </ng-container>
        <ng-container matColumnDef="endTime">
          <mat-header-cell *matHeaderCellDef>Bitiş</mat-header-cell>
          <mat-cell *matCellDef="let s" class="mono">{{ s.endTime | date:'HH:mm:ss' }}</mat-cell>
        </ng-container>
        <ng-container matColumnDef="duration">
          <mat-header-cell *matHeaderCellDef>Süre</mat-header-cell>
          <mat-cell *matCellDef="let s">{{ duration(s) }}</mat-cell>
        </ng-container>
        <ng-container matColumnDef="title">
          <mat-header-cell *matHeaderCellDef>Program</mat-header-cell>
          <mat-cell *matCellDef="let s">{{ s.title }}</mat-cell>
        </ng-container>
        <ng-container matColumnDef="status">
          <mat-header-cell *matHeaderCellDef>Durum</mat-header-cell>
          <mat-cell *matCellDef="let s">
            <span [class]="'status-badge ' + s.status">{{ s.status }}</span>
          </mat-cell>
        </ng-container>
        <ng-container matColumnDef="actions">
          <mat-header-cell *matHeaderCellDef></mat-header-cell>
          <mat-cell *matCellDef="let s">
            @if (s.status === 'CONFIRMED') {
              <button mat-icon-button color="primary" matTooltip="Go Live"
                      (click)="goLive(s, $event)">
                <mat-icon>play_arrow</mat-icon>
              </button>
            }
            @if (s.status === 'ON_AIR') {
              <button mat-icon-button color="warn" matTooltip="Bitir"
                      (click)="endProgram(s, $event)">
                <mat-icon>stop</mat-icon>
              </button>
            }
            <button mat-icon-button matTooltip="Timeline" (click)="selectSchedule(s)">
              <mat-icon>timeline</mat-icon>
            </button>
          </mat-cell>
        </ng-container>

        <mat-header-row *matHeaderRowDef="rundownCols"></mat-header-row>
        <mat-row *matRowDef="let row; columns: rundownCols"
                 [class.row-on-air]="row.status === 'ON_AIR'"
                 [class.row-selected]="selectedId() === row.id"
                 (click)="selectSchedule(row)">
        </mat-row>
        <tr class="mat-row" *matNoDataRow>
          <td class="mat-cell no-data" [attr.colspan]="rundownCols.length">Bu tarihe ait kayıt yok</td>
        </tr>
      </mat-table>
    </div>
  `,
  styles: [`
    /* beINport UI V2 — page header + clock restyle */
    .page-container { padding: var(--bp-sp-6) var(--bp-sp-8) var(--bp-sp-8); }

    /* Header + clock */
    .mcr-header { display:flex; align-items:center; justify-content:space-between; margin-bottom: var(--bp-sp-6); }
    .mcr-title  { display:flex; align-items:center; gap: var(--bp-sp-2); }
    .mcr-title h1 {
      margin: 0;
      font-family: var(--bp-font-display);
      font-size: var(--bp-text-3xl);
      font-weight: var(--bp-fw-semibold);
      letter-spacing: var(--bp-ls-tight);
      color: var(--bp-fg-1);
    }
    .clocks { display:flex; gap: var(--bp-sp-6); }
    .clock-block { display:flex; flex-direction:column; align-items:center; }
    .clock-label { font-size: 9.5px; text-transform: uppercase; letter-spacing: var(--bp-ls-eyebrow); color: var(--bp-fg-3); font-weight: var(--bp-fw-bold); }
    .clock-value { font-family: var(--bp-font-mono); font-size: 22px; font-weight: var(--bp-fw-bold); letter-spacing: 2px; color: var(--bp-fg-1); }
    .local .clock-value { color: var(--bp-fg-2); }

    /* Live row */
    .live-row { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-bottom:24px; }
    .live-section {}
    .section-label { display:flex; align-items:center; gap:8px; margin-bottom:12px; font-size:0.9rem; font-weight:700; text-transform:uppercase; letter-spacing:1px; }
    .dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
    .dot.on   { background:#f44336; box-shadow:0 0 6px #f44336; animation:pulse 1s infinite; }
    .dot.next { background:#ff9800; }
    .on-air-label { color:#dc2626; }    /* red-600 — daha koyu, light mode'da okunur */
    .next-label   { color:#b45309; }    /* amber-700 — koyu turuncu, kontrastlı */

    .live-card { margin-bottom:8px; cursor:pointer; border:1px solid transparent; transition:border-color 0.2s; }
    .live-card.selected { border-color:#90caf9; }
    .on-air-card { border-left:4px solid #f44336; }
    .next-card   { border-left:4px solid #ff9800; }
    .tc-row { display:flex; align-items:center; gap:8px; font-family:monospace; font-size:1.1rem; margin:4px 0; }
    .tc-sep { opacity:0.5; }
    .elapsed { display:flex; align-items:center; gap:4px; font-size:0.8rem; color:#aaa; }
    .countdown { font-size:0.8rem; color:#ff9800; }
    .empty-live { color:#555; padding:24px; text-align:center; border:1px dashed #333; border-radius:4px; }

    /* Timeline */
    .timeline-panel { margin-bottom:24px; }
    .channel-badge { background:#1565c0; padding:2px 8px; border-radius:10px; font-size:0.75rem; margin-left:8px; }
    .timeline-content { display:flex; flex-direction:column; gap:12px; }
    .timeline-events { display:flex; flex-direction:column; gap:4px; max-height:260px; overflow-y:auto; }
    .tl-event { display:flex; align-items:center; gap:12px; padding:6px 10px; border-radius:4px; font-size:0.85rem; background:rgba(255,255,255,0.04); }
    .tl-GO_LIVE  { border-left:3px solid #4caf50; }
    .tl-END      { border-left:3px solid #f44336; }
    .tl-FAULT    { border-left:3px solid #ff9800; }
    .tl-RECOVERY { border-left:3px solid #2196f3; }
    .tl-NOTE     { border-left:3px solid #757575; }
    .tl-tc   { min-width:90px; font-family:monospace; }
    .tl-type { font-weight:600; min-width:90px; font-size:0.78rem; }
    .tl-note { flex:1; color:#ccc; }
    .tl-by   { color:#777; font-size:0.72rem; }
    .no-events { color:#555; font-style:italic; }
    .add-event-form { display:flex; gap:12px; align-items:center; flex-wrap:wrap; padding-top:8px; border-top:1px solid var(--bp-line-2); }
    .add-event-form .narrow { flex:0 0 160px; }
    .add-event-form .wide   { flex:1; min-width:200px; }

    /* Rundown */
    .rundown-header { display:flex; align-items:center; justify-content:space-between; margin:24px 0 12px; }
    .section-title  { display:flex; align-items:center; gap:8px; margin:0; }
    .date-field     { width:180px; }
    .rundown-table  { width:100%; }
    .mono { font-family:monospace; }
    .ch-badge { background:#37474f; padding:2px 8px; border-radius:10px; font-size:0.78rem; }
    .row-on-air  { background:rgba(244,67,54,0.08); }
    .row-selected { background:rgba(144,202,249,0.06); }
    .no-data { padding:24px; text-align:center; color:#555; }

    .status-badge {
      padding: 3px 8px;
      border-radius: var(--bp-r-pill);
      font-size: 9.5px;
      font-weight: var(--bp-fw-bold);
      letter-spacing: var(--bp-ls-status);
      text-transform: uppercase;
    }
    .status-badge.DRAFT      { background:#37474f; color:#cfd8dc; }
    .status-badge.CONFIRMED  { background:#1565c0; color:#fff; }
    .status-badge.ON_AIR     { background:#b71c1c; color:#fff; }
    .status-badge.COMPLETED  { background:#2e7d32; color:#fff; }
    .status-badge.CANCELLED  { background:#424242; color:#9e9e9e; }

    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  `],
})
export class McrPanelComponent implements OnInit, OnDestroy {
  rundownCols = ['channel', 'startTime', 'endTime', 'duration', 'title', 'status', 'actions'];
  tcEventTypes = TC_EVENT_TYPES;

  onAir    = signal<Schedule[]>([]);
  next     = signal<Schedule[]>([]);
  rundown  = signal<Schedule[]>([]);

  selectedSchedule = signal<Schedule | null>(null);
  selectedId       = computed(() => this.selectedSchedule()?.id ?? null);
  timelineEvents   = signal<TimelineEvent[]>([]);

  utcTime   = signal('');
  localTime = signal('');

  rundownDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  newEvent = { tc: '', type: 'NOTE', note: '' };

  private clockTimer?: ReturnType<typeof setInterval>;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(private api: ApiService, private snack: MatSnackBar) {}

  ngOnInit() {
    this.tickClock();
    this.clockTimer   = setInterval(() => this.tickClock(), 1000);
    this.refreshTimer = setInterval(() => this.loadLive(), 30_000);
    this.loadAll();
  }

  ngOnDestroy() {
    clearInterval(this.clockTimer);
    clearInterval(this.refreshTimer);
  }

  loadAll() {
    this.loadLive();
    this.loadRundown();
  }

  loadLive() {
    this.api.get<Schedule[]>('/playout/current').subscribe({
      next: (d) => this.onAir.set(d),
      error: (err) => this.snack.open(`Yayın yüklenemedi: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 3000 }),
    });
    this.api.get<Schedule[]>('/playout/next').subscribe({
      next: (d) => this.next.set(d),
      error: (err) => this.snack.open(`Yaklaşan program yüklenemedi: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 3000 }),
    });
  }

  loadRundown() {
    this.api.get<Schedule[]>('/playout/rundown', { date: this.rundownDate }).subscribe({
      next: (d) => this.rundown.set(d),
      error: (err) => this.snack.open(`Rundown yüklenemedi: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 3000 }),
    });
  }

  selectSchedule(s: Schedule) {
    this.selectedSchedule.set(s);
    this.api.get<TimelineEvent[]>(`/playout/${s.id}/timeline`).subscribe({
      next: (evs) => this.timelineEvents.set(evs),
      error: (err) => this.snack.open(`Timeline yüklenemedi: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 3000 }),
    });
  }

  goLive(s: Schedule, event: Event) {
    event.stopPropagation();
    this.api.post<Schedule>(`/playout/${s.id}/go-live`, {}).subscribe({
      next: () => {
        this.snack.open(`${s.title} — YAYINDA`, 'Kapat', { duration: 3000 });
        this.loadAll();
      },
      error: (err) => {
        this.snack.open(`Hata: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 4000 });
      },
    });
  }

  endProgram(s: Schedule, event: Event) {
    event.stopPropagation();
    this.api.post<Schedule>(`/playout/${s.id}/end`, {}).subscribe({
      next: () => {
        this.snack.open(`${s.title} — TAMAMLANDI`, 'Kapat', { duration: 3000 });
        if (this.selectedId() === s.id) this.selectedSchedule.set(null);
        this.loadAll();
      },
      error: (err) => {
        this.snack.open(`Hata: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 4000 });
      },
    });
  }

  addTimelineEvent() {
    const sel = this.selectedSchedule();
    if (!sel) return;
    this.api.post<TimelineEvent>(`/playout/${sel.id}/timeline`, {
      tc:   this.newEvent.tc || undefined,
      type: this.newEvent.type,
      note: this.newEvent.note || undefined,
    }).subscribe({
      next: () => {
        this.snack.open('Olay eklendi', 'Kapat', { duration: 2000 });
        this.newEvent = { tc: '', type: 'NOTE', note: '' };
        this.selectSchedule(sel);
      },
      error: (err) => {
        this.snack.open(`Hata: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 4000 });
      },
    });
  }

  // ── Yardımcılar ────────────────────────────────────────────────────────────
  private tickClock() {
    const now = new Date();
    this.utcTime.set(
      now.toUTCString().split(' ').slice(4, 5)[0] ?? now.toISOString().split('T')[1].slice(0, 8),
    );
    this.localTime.set(
      now.toTimeString().slice(0, 8),
    );
  }

  elapsed(s: Schedule): string {
    const diff = Date.now() - new Date(s.startTime).getTime();
    if (diff < 0) return '';
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    const sec = Math.floor((diff % 60_000) / 1000);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  }

  countdown(s: Schedule): string {
    const diff = new Date(s.startTime).getTime() - Date.now();
    if (diff <= 0) return 'Başlamalı!';
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    return h > 0 ? `${h}s ${m}dk` : `${m} dakika sonra`;
  }

  duration(s: Schedule): string {
    const diff = new Date(s.endTime).getTime() - new Date(s.startTime).getTime();
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    return h > 0 ? `${h}s ${m}dk` : `${m}dk`;
  }
}
