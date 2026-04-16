import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatBadgeModule } from '@angular/material/badge';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatExpansionModule } from '@angular/material/expansion';

import { ApiService } from '../../../core/services/api.service';
import type { Incident, ChannelSignalSummary } from '@bcms/shared';

interface CreateIncidentForm {
  eventType:   string;
  description: string;
  severity:    'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  tcIn:        string;
}

@Component({
  selector: 'app-monitoring-dashboard',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatCardModule, MatIconModule, MatButtonModule, MatBadgeModule,
    MatDividerModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatSnackBarModule, MatTooltipModule, MatProgressBarModule, MatExpansionModule,
  ],
  template: `
    <div class="page-container">
      <div class="dashboard-header">
        <h1>Monitoring Paneli</h1>
        <div class="header-right">
          <span class="refresh-info">Her 30s güncellenir</span>
          <button mat-stroked-button (click)="load()">
            <mat-icon>refresh</mat-icon> Yenile
          </button>
          <button mat-flat-button color="accent" (click)="simulate()" [disabled]="simulating()">
            <mat-icon>science</mat-icon>
            {{ simulating() ? 'Simüle ediliyor…' : 'Sinyal Simülasyonu' }}
          </button>
        </div>
      </div>

      <!-- ── Sinyal Telemetri Kartları ─────────────────────────────────── -->
      <h2 class="section-title">
        <mat-icon>cell_tower</mat-icon> Kanal Sinyal Durumu
      </h2>
      <div class="signal-grid">
        @for (s of signals(); track s.channelId) {
          <mat-card [class]="'signal-card sig-' + signalStatus(s)">
            <mat-card-header>
              <mat-icon mat-card-avatar [class]="'sig-icon sig-' + signalStatus(s)">
                {{ signalStatus(s) === 'OK' ? 'signal_cellular_alt' :
                   signalStatus(s) === 'DEGRADED' ? 'signal_cellular_2_bar' : 'signal_cellular_off' }}
              </mat-icon>
              <mat-card-title>{{ s.channelName }}</mat-card-title>
              <mat-card-subtitle>{{ s.channelType }}</mat-card-subtitle>
            </mat-card-header>
            <mat-card-content>
              @if (s.telemetry) {
                <div class="sig-metrics">
                  <div class="sig-metric">
                    <span class="sig-label">Sinyal</span>
                    <span class="sig-value">{{ s.telemetry.signalDb | number:'1.1-1' }} dBm</span>
                    <mat-progress-bar
                      [mode]="'determinate'"
                      [value]="dbToPercent(s.telemetry.signalDb)"
                      [color]="signalStatus(s) === 'OK' ? 'primary' : 'warn'">
                    </mat-progress-bar>
                  </div>
                  <div class="sig-metric">
                    <span class="sig-label">SNR</span>
                    <span class="sig-value">{{ s.telemetry.snr | number:'1.1-1' }} dB</span>
                  </div>
                  <div class="sig-metric">
                    <span class="sig-label">Ses</span>
                    <span class="sig-value">{{ s.telemetry.audioLufs | number:'1.1-1' }} LUFS</span>
                  </div>
                  <div class="sig-metric">
                    <span class="sig-label">BER</span>
                    <span class="sig-value mono">{{ s.telemetry.ber | number:'1.0-2' }}</span>
                  </div>
                </div>
                <small class="sig-time">{{ s.telemetry.measuredAt | date:'HH:mm:ss' }} — {{ s.telemetry.source }}</small>
              } @else {
                <p class="no-data">Henüz veri yok</p>
              }
            </mat-card-content>
          </mat-card>
        }

        @if (signals().length === 0) {
          <div class="empty-state">
            <mat-icon>satellite_alt</mat-icon>
            <p>Aktif kanal bulunamadı</p>
          </div>
        }
      </div>

      <!-- ── Aktif İncidentlar ─────────────────────────────────────────── -->
      <div class="section-header">
        <h2 class="section-title">
          <mat-icon>warning</mat-icon> Aktif Olaylar
          @if (activeIncidents().length > 0) {
            <span class="badge-count">{{ activeIncidents().length }}</span>
          }
        </h2>

        <!-- Hızlı Incident Oluştur -->
        <mat-expansion-panel class="create-panel">
          <mat-expansion-panel-header>
            <mat-panel-title>
              <mat-icon>add_alert</mat-icon>&nbsp;Olay Kaydet
            </mat-panel-title>
          </mat-expansion-panel-header>

          <div class="create-form">
            <mat-form-field appearance="outline">
              <mat-label>Olay Tipi</mat-label>
              <input matInput [(ngModel)]="form.eventType" placeholder="SIGNAL_LOSS, AUDIO_FAIL…" />
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Açıklama</mat-label>
              <input matInput [(ngModel)]="form.description" />
            </mat-form-field>
            <mat-form-field appearance="outline" class="narrow">
              <mat-label>Önem</mat-label>
              <mat-select [(ngModel)]="form.severity">
                <mat-option value="INFO">INFO</mat-option>
                <mat-option value="WARNING">WARNING</mat-option>
                <mat-option value="ERROR">ERROR</mat-option>
                <mat-option value="CRITICAL">CRITICAL</mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline" class="narrow">
              <mat-label>TC-In (HH:MM:SS:FF)</mat-label>
              <input matInput [(ngModel)]="form.tcIn" placeholder="00:00:00:00" />
            </mat-form-field>
            <button mat-flat-button color="warn"
                    [disabled]="!form.eventType.trim()"
                    (click)="createIncident()">
              <mat-icon>add</mat-icon> Kaydet
            </button>
          </div>
        </mat-expansion-panel>
      </div>

      @if (activeIncidents().length > 0) {
        <div class="incidents-list">
          @for (inc of activeIncidents(); track inc.id) {
            <div class="incident-row" [class]="'sev-' + inc.severity">
              <mat-icon class="sev-icon">{{ severityIcon(inc.severity) }}</mat-icon>
              <span class="inc-sev">{{ inc.severity }}</span>
              <span class="inc-type">{{ inc.eventType }}</span>
              <span class="inc-desc">{{ inc.description }}</span>
              <span class="inc-tc mono">{{ inc.tcIn ?? '' }}</span>
              <small class="inc-time">{{ inc.createdAt | date:'HH:mm:ss' }}</small>
              <button mat-icon-button
                      matTooltip="Çözüldü olarak işaretle"
                      (click)="resolveIncident(inc.id)">
                <mat-icon>check_circle_outline</mat-icon>
              </button>
            </div>
          }
        </div>
      } @else {
        <p class="no-incidents">Aktif olay yok</p>
      }

      <!-- ── Çözülen Olaylar (Son 10) ──────────────────────────────────── -->
      @if (resolvedIncidents().length > 0) {
        <mat-expansion-panel class="resolved-panel">
          <mat-expansion-panel-header>
            <mat-panel-title>
              <mat-icon>task_alt</mat-icon>&nbsp;Çözülen Olaylar (son 10)
            </mat-panel-title>
          </mat-expansion-panel-header>
          <div class="incidents-list resolved">
            @for (inc of resolvedIncidents(); track inc.id) {
              <div class="incident-row resolved-row">
                <mat-icon>check_circle</mat-icon>
                <span class="inc-type">{{ inc.eventType }}</span>
                <span class="inc-desc">{{ inc.description }}</span>
                <small>{{ inc.resolvedAt | date:'HH:mm' }} — {{ inc.resolvedBy }}</small>
              </div>
            }
          </div>
        </mat-expansion-panel>
      }
    </div>
  `,
  styles: [`
    .page-container  { max-width: 1200px; margin: 0 auto; }
    .dashboard-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:24px; }
    .header-right    { display:flex; align-items:center; gap:12px; }
    .refresh-info    { font-size:0.8rem; color:#888; }

    .section-title   { display:flex; align-items:center; gap:8px; margin:24px 0 12px; font-size:1.1rem; }
    .badge-count     { background:#f44336; color:#fff; border-radius:50%; width:22px; height:22px;
                       display:inline-flex; align-items:center; justify-content:center; font-size:0.75rem; }
    .section-header  { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
    .section-header h2 { margin:0; }
    .create-panel    { flex:1; max-width:700px; }
    .create-form     { display:flex; flex-wrap:wrap; gap:12px; align-items:center; padding-top:8px; }
    .create-form mat-form-field { flex:1; min-width:160px; }
    .create-form .narrow { flex:0 0 160px; }

    /* Signal cards */
    .signal-grid   { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:16px; margin-bottom:24px; }
    .signal-card   { border-top:3px solid transparent; transition:border-color 0.3s; }
    .sig-OK        { border-color:#4caf50; }
    .sig-DEGRADED  { border-color:#ff9800; }
    .sig-LOST, .sig-NONE { border-color:#f44336; }

    .sig-icon      { font-size:24px !important; width:24px !important; height:24px !important; }
    .sig-icon.sig-OK       { color:#4caf50; }
    .sig-icon.sig-DEGRADED { color:#ff9800; }
    .sig-icon.sig-LOST, .sig-icon.sig-NONE { color:#f44336; animation:blink 1s step-start infinite; }

    .sig-metrics   { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:8px 0; }
    .sig-metric    { display:flex; flex-direction:column; gap:2px; }
    .sig-label     { font-size:0.7rem; text-transform:uppercase; opacity:0.5; }
    .sig-value     { font-size:0.95rem; font-weight:500; }
    .sig-time      { font-size:0.72rem; color:#888; }
    .no-data       { color:#666; font-size:0.85rem; margin:8px 0; }
    .mono          { font-family:monospace; }

    /* Incidents */
    .incidents-list  { display:flex; flex-direction:column; gap:4px; margin-bottom:16px; }
    .incident-row    {
      display:flex; align-items:center; gap:10px; padding:8px 12px;
      border-radius:4px; font-size:0.85rem;
    }
    .sev-CRITICAL { background:rgba(183,28,28,0.2); }
    .sev-ERROR    { background:rgba(244,67,54,0.12); }
    .sev-WARNING  { background:rgba(255,152,0,0.12); }
    .sev-INFO     { background:rgba(33,150,243,0.08); }
    .resolved-row { background:rgba(255,255,255,0.04); opacity:0.7; }

    .sev-icon    { font-size:18px !important; width:18px !important; height:18px !important; }
    .inc-sev     { font-weight:700; font-size:0.72rem; min-width:64px; }
    .inc-type    { font-weight:600; min-width:130px; }
    .inc-desc    { flex:1; color:#ccc; }
    .inc-tc      { min-width:90px; color:#aaa; }
    .inc-time    { color:#888; min-width:60px; }

    .no-incidents  { color:#666; font-style:italic; padding:8px 0; }
    .resolved-panel { margin-top:8px; }

    .empty-state { grid-column:1/-1; display:flex; flex-direction:column; align-items:center;
                   gap:8px; padding:48px; color:#555; }
    .empty-state mat-icon { font-size:48px; width:48px; height:48px; }

    @keyframes blink { 50% { opacity:0; } }
  `],
})
export class MonitoringDashboardComponent implements OnInit, OnDestroy {
  signals          = signal<ChannelSignalSummary[]>([]);
  activeIncidents  = signal<Incident[]>([]);
  resolvedIncidents = signal<Incident[]>([]);
  simulating       = signal(false);

  form: CreateIncidentForm = {
    eventType:   '',
    description: '',
    severity:    'WARNING',
    tcIn:        '',
  };

  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(private api: ApiService, private snack: MatSnackBar) {}

  ngOnInit() {
    this.load();
    this.refreshTimer = setInterval(() => this.load(), 30_000);
  }

  ngOnDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  load() {
    this.api.get<ChannelSignalSummary[]>('/signals/latest').subscribe({
      next: (data) => this.signals.set(data),
      error: () => {},
    });

    this.api.get<Incident[]>('/incidents', { resolved: 'false' }).subscribe({
      next: (data) => this.activeIncidents.set(data),
      error: () => {},
    });

    this.api.get<Incident[]>('/incidents', { resolved: 'true' }).subscribe({
      next: (data) => this.resolvedIncidents.set(data.slice(0, 10)),
      error: () => {},
    });
  }

  simulate() {
    this.simulating.set(true);
    this.api.post<unknown>('/signals/simulate', {}).subscribe({
      next: () => {
        this.snack.open('Simülasyon tamamlandı', 'Kapat', { duration: 2000 });
        this.simulating.set(false);
        this.load();
      },
      error: (err) => {
        this.snack.open(`Hata: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 4000 });
        this.simulating.set(false);
      },
    });
  }

  createIncident() {
    if (!this.form.eventType.trim()) return;
    const body: Record<string, string> = {
      eventType: this.form.eventType,
      severity:  this.form.severity,
    };
    if (this.form.description) body['description'] = this.form.description;
    if (this.form.tcIn)        body['tcIn']        = this.form.tcIn;

    this.api.post<Incident>('/incidents', body).subscribe({
      next: () => {
        this.snack.open('Olay kaydedildi', 'Kapat', { duration: 2000 });
        this.form = { eventType: '', description: '', severity: 'WARNING', tcIn: '' };
        this.load();
      },
      error: (err) => {
        this.snack.open(`Hata: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 4000 });
      },
    });
  }

  resolveIncident(id: number) {
    this.api.patch<Incident>(`/incidents/${id}/resolve`, {}).subscribe({
      next: () => {
        this.snack.open('Olay çözüldü olarak işaretlendi', 'Kapat', { duration: 2000 });
        this.load();
      },
      error: (err) => {
        this.snack.open(`Hata: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 4000 });
      },
    });
  }

  signalStatus(s: ChannelSignalSummary): string {
    return s.telemetry?.status ?? 'NONE';
  }

  dbToPercent(db?: number): number {
    if (db == null) return 0;
    // 45 dBm → 0%, 70 dBm → 100%
    return Math.min(100, Math.max(0, ((db - 45) / 25) * 100));
  }

  severityIcon(sev: string): string {
    const map: Record<string, string> = {
      CRITICAL: 'dangerous', ERROR: 'error', WARNING: 'warning', INFO: 'info',
    };
    return map[sev] ?? 'info';
  }
}
