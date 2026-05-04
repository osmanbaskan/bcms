import { Component, OnInit, OnDestroy, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { interval, Subscription } from 'rxjs';

import { KpiComponent } from '../../core/ui/kpi.component';
import { CardComponent } from '../../core/ui/card.component';
import { StatusTagComponent } from '../../core/ui/status-tag.component';
import { SevTagComponent } from '../../core/ui/sev-tag.component';
import { PageHeaderComponent } from '../../core/ui/page-header.component';
import { ScheduleService } from '../../core/services/schedule.service';
import { ApiService } from '../../core/services/api.service';

interface ScheduleRow {
  id: number;
  date: string;
  startTime: string;
  endTime: string;
  channelId?: number | null;
  title: string;
  status: string;
  channel?: { id: number; name: string } | null;
  league?: { id: number; name: string; code: string } | null;
}

interface IngestPort {
  id: number;
  name: string;
  active?: boolean;
  status?: string;
}

interface StudioSlot {
  id: number;
  studio: string;
  programName: string;
  startTime: string;
  endTime: string;
}

/**
 * Dashboard — beINport Genel Bakış pattern (UI V2 Aşama 2A).
 * KPI rail + Hero (canlı yayın) + Shift + Broadcast list + Studios + Ports + Alerts (placeholder).
 *
 * Pattern kaynağı: /home/ubuntu/website/beINport/genel-bakis.html
 *
 * KORUMA: BCMS API'lerine sadece read-only sorgu yapılır. Yetkiler default ([] — auth user).
 */
@Component({
  selector: 'bp-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    KpiComponent,
    CardComponent,
    StatusTagComponent,
    SevTagComponent,
    PageHeaderComponent,
  ],
  template: `
    <bp-page-header
      [title]="'Bugünün operasyonu'"
      [eyebrow]="todayEyebrow()"
    ></bp-page-header>

    <div class="dashboard">
      <!-- ─── KPI Rail ────────────────────────────────────────────────── -->
      <div class="kpi-rail">
        <bp-kpi [accent]="true"
                label="Şu an canlı"
                [value]="kpiLive()"
                [sub]="kpiTodayTotal() + ' yayın bugün toplam'"></bp-kpi>
        <bp-kpi label="Aktif port"
                [value]="kpiActivePorts()"
                [unit]="'/' + kpiTotalPorts()"
                [sub]="(kpiTotalPorts() - kpiActivePorts()) + ' boş/bekleme'"></bp-kpi>
        <bp-kpi label="Stüdyo programı"
                [value]="kpiStudios()"
                [sub]="'bugün'"></bp-kpi>
        <bp-kpi label="Ekip · vardiya"
                [value]="kpiShiftCount()"
                [sub]="'bu hafta'"></bp-kpi>
        <bp-kpi label="Aktif uyarı"
                [value]="kpiAlerts()"
                [sub]="'placeholder · Aşama 3'"></bp-kpi>
      </div>

      <!-- ─── Hero + Shift row ───────────────────────────────────────── -->
      <div class="row hero-row">
        <div class="hero">
          @if (heroBroadcast(); as h) {
            <div class="hero-content">
              <div>
                <div class="hero-badge"><span class="hero-dot"></span>ŞU AN CANLI · {{ h.startTime }}</div>
                <div class="hero-teams">
                  <span>{{ h.title }}</span>
                </div>
                <div class="hero-meta">
                  {{ h.league?.name ?? 'Lig bilgisi yok' }}@if (h.channel) { · {{ h.channel.name }} }
                </div>
                <div class="hero-actions">
                  <a class="hero-btn" [routerLink]="['/schedules', h.id]">Detaya git →</a>
                  <button class="hero-btn-ghost" type="button">Sorun bildir</button>
                </div>
              </div>
            </div>
          } @else {
            <div class="hero-empty">
              <div class="hero-empty-title">Şu an yayında bir program yok</div>
              <div class="hero-empty-sub">Bugünün yayın akışı aşağıda</div>
            </div>
          }
        </div>

        <bp-card title="Vardiyam" [padded]="true">
          <a card-action class="link-action" routerLink="/weekly-shift">Tümü →</a>
          <div class="shift-empty">
            <div class="placeholder-eyebrow">PLACEHOLDER · Aşama 3</div>
            <div class="placeholder-text">Vardiya kartı henüz bağlanmadı</div>
            <a class="link-action" routerLink="/weekly-shift">Haftalık shift →</a>
          </div>
        </bp-card>
      </div>

      <!-- ─── Broadcasts + Studios row ───────────────────────────────── -->
      <div class="row broadcasts-row">
        <bp-card [title]="'Bugünün yayın akışı'"
                 [count]="todayBroadcasts().length + ' yayın'">
          <a card-action class="link-action" routerLink="/schedules">Tümü →</a>
          <div class="broadcast-list">
            @if (loadingBroadcasts()) {
              <div class="empty">Yükleniyor…</div>
            } @else {
              @for (m of todayBroadcasts().slice(0, 14); track m.id) {
                <a class="broadcast-row" [routerLink]="['/schedules', m.id]">
                  <div class="row-time">{{ m.startTime }}</div>
                  <div class="row-league">{{ m.league?.name ?? '—' }}</div>
                  <div class="row-title">{{ m.title }}</div>
                  <div class="row-channel">{{ m.channel?.name ?? '—' }}</div>
                  <div class="row-status"><bp-status-tag [state]="m.status"></bp-status-tag></div>
                </a>
              } @empty {
                <div class="empty">Bugün için yayın yok.</div>
              }
            }
          </div>
        </bp-card>

        <bp-card [title]="'Stüdyo programı'" [count]="todayStudios().length + ' kayıt'">
          <a card-action class="link-action" routerLink="/studio-plan">Tümü →</a>
          <div class="studio-list">
            @if (loadingStudios()) {
              <div class="empty">Yükleniyor…</div>
            } @else {
              @for (p of todayStudios().slice(0, 7); track p.id) {
                <div class="studio-row">
                  <div class="studio-bar"></div>
                  <div class="studio-text">
                    <div class="studio-name">{{ p.programName || '(boş slot)' }}</div>
                    <div class="studio-meta">{{ p.studio }}</div>
                  </div>
                  <div class="studio-time">
                    <div class="studio-start">{{ p.startTime }}</div>
                    <div class="studio-end">{{ p.endTime }}</div>
                  </div>
                </div>
              } @empty {
                <div class="empty">Bugün için stüdyo programı yok.</div>
              }
            }
          </div>
        </bp-card>
      </div>

      <!-- ─── Ports grid + Alerts row ────────────────────────────────── -->
      <div class="row bottom-row">
        <bp-card [title]="'Ingest portları'"
                 [count]="kpiActivePorts() + '/' + kpiTotalPorts() + ' aktif'">
          <a card-action class="link-action" routerLink="/ingest">Detay →</a>
          <div class="ports-grid">
            @if (loadingPorts()) {
              <div class="empty">Yükleniyor…</div>
            } @else if (ports().length === 0) {
              <div class="empty">Tanımlı port yok.</div>
            } @else {
              @for (p of ports(); track p.id) {
                <div class="port-cell"
                     [class.active]="p.active"
                     [class.idle]="!p.active"
                     [title]="p.name + (p.active ? ' · aktif' : ' · pasif')">
                  {{ portShortName(p.name) }}
                </div>
              }
            }
          </div>
          <div class="ports-legend">
            <span><i class="dot active"></i>Aktif</span>
            <span><i class="dot idle"></i>Pasif</span>
          </div>
        </bp-card>

        <bp-card [title]="'Son uyarılar'" [count]="'placeholder'">
          <a card-action class="link-action" routerLink="/audit-logs">Audit log →</a>
          <div class="alerts-empty">
            <div class="placeholder-eyebrow">PLACEHOLDER · Aşama 3</div>
            <div class="placeholder-text">Alert sistemi henüz BCMS'te yok.</div>
            <div class="placeholder-sub">
              Prometheus alerts (audit-internal) Aşama 3'te bu kart'a bağlanır.
            </div>
          </div>
        </bp-card>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .dashboard {
      padding: 0 32px 32px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* ─── KPI rail ─────────────────────────────────────────────────── */
    .kpi-rail {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 12px;
    }

    /* ─── Layout rows ──────────────────────────────────────────────── */
    .row { display: grid; gap: 16px; }
    .hero-row { grid-template-columns: 1fr 320px; }
    .broadcasts-row { grid-template-columns: 1.6fr 1fr; }
    .bottom-row { grid-template-columns: 1fr 1fr; }

    /* ─── Hero ─────────────────────────────────────────────────────── */
    .hero {
      background: linear-gradient(135deg, #4c1d95 0%, #2e1065 60%, #1a1b20 100%);
      border: 1px solid rgba(167, 139, 250, 0.20);
      border-radius: var(--bp-r-xl);
      padding: 24px 28px;
      position: relative;
      overflow: hidden;
      min-height: 220px;
      display: flex;
      align-items: stretch;
    }
    .hero-content { display: flex; align-items: flex-end; flex: 1; }
    .hero-badge {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      font-size: 10.5px;
      font-weight: var(--bp-fw-bold);
      letter-spacing: 0.10em;
      color: #fff;
      background: rgba(239, 68, 68, 0.20);
      border: 1px solid rgba(239, 68, 68, 0.50);
      padding: 4px 10px;
      border-radius: 14px;
    }
    .hero-dot {
      width: 6px;
      height: 6px;
      border-radius: 3px;
      background: #ef4444;
      box-shadow: 0 0 8px #ef4444;
      animation: bp-pulse var(--bp-dur-pulse) infinite;
    }
    .hero-teams {
      font-family: var(--bp-font-display);
      font-size: 28px;
      font-weight: var(--bp-fw-semibold);
      letter-spacing: var(--bp-ls-tight);
      margin-top: 12px;
      line-height: 1.1;
      color: #fff;
    }
    .hero-meta {
      font-size: var(--bp-text-sm);
      color: rgba(255, 255, 255, 0.65);
      margin-top: 10px;
      font-family: var(--bp-font-mono);
      letter-spacing: 0.04em;
    }
    .hero-actions { display: flex; gap: 8px; margin-top: 18px; }
    .hero-btn {
      background: #fff;
      color: var(--bp-purple-700);
      border: 0;
      padding: 9px 16px;
      border-radius: var(--bp-r-md);
      font-size: 12.5px;
      font-weight: var(--bp-fw-semibold);
      cursor: pointer;
      text-decoration: none;
      font-family: inherit;
    }
    .hero-btn-ghost {
      background: rgba(255, 255, 255, 0.10);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.20);
      padding: 9px 16px;
      border-radius: var(--bp-r-md);
      font-size: 12.5px;
      cursor: pointer;
      font-family: inherit;
    }
    .hero-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      color: rgba(255, 255, 255, 0.85);
    }
    .hero-empty-title { font-size: 20px; font-weight: var(--bp-fw-semibold); font-family: var(--bp-font-display); }
    .hero-empty-sub { font-size: 13px; color: rgba(255, 255, 255, 0.65); margin-top: 6px; }

    /* ─── Card slot link action ───────────────────────────────────── */
    .link-action {
      font-size: 11px;
      color: var(--bp-purple-300);
      text-decoration: none;
      white-space: nowrap;
    }

    /* ─── Shift placeholder ───────────────────────────────────────── */
    .shift-empty, .alerts-empty {
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-start;
    }
    .placeholder-eyebrow {
      font-size: 9.5px;
      letter-spacing: 0.10em;
      font-weight: var(--bp-fw-bold);
      background: var(--bp-status-PENDING-bg);
      border: 1px solid var(--bp-status-PENDING-fg);
      color: var(--bp-status-PENDING-fg);
      padding: 3px 8px;
      border-radius: 4px;
    }
    .placeholder-text { font-size: 13px; color: var(--bp-fg-2); }
    .placeholder-sub { font-size: 11.5px; color: var(--bp-fg-3); line-height: 1.5; }

    /* ─── Broadcast list ──────────────────────────────────────────── */
    .broadcast-list { display: flex; flex-direction: column; }
    .broadcast-row {
      display: flex;
      gap: 12px;
      padding: 10px 18px;
      align-items: center;
      border-bottom: 1px solid var(--bp-line-2);
      text-decoration: none;
      color: inherit;
      transition: background var(--bp-dur-fast);
    }
    .broadcast-row:last-child { border-bottom: 0; }
    .broadcast-row:hover { background: rgba(255, 255, 255, 0.03); }
    .row-time {
      font-family: var(--bp-font-mono);
      font-size: 13px;
      color: var(--bp-purple-300);
      font-weight: var(--bp-fw-medium);
      width: 50px;
    }
    .row-league {
      font-size: 9.5px;
      letter-spacing: 0.10em;
      color: var(--bp-fg-3);
      font-weight: var(--bp-fw-semibold);
      width: 130px;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .row-title { flex: 1; font-size: 13px; color: var(--bp-fg-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row-channel {
      font-family: var(--bp-font-mono);
      font-size: 11.5px;
      color: var(--bp-fg-2);
      width: 80px;
      text-align: right;
    }
    .row-status { width: 80px; text-align: right; }

    /* ─── Studio list ─────────────────────────────────────────────── */
    .studio-list { display: flex; flex-direction: column; }
    .studio-row {
      display: flex;
      gap: 12px;
      padding: 11px 18px;
      align-items: center;
      border-bottom: 1px solid var(--bp-line-2);
    }
    .studio-row:last-child { border-bottom: 0; }
    .studio-bar { width: 3px; height: 32px; border-radius: 2px; flex-shrink: 0; background: var(--bp-purple-400); }
    .studio-text { flex: 1; min-width: 0; }
    .studio-name {
      font-size: 13px;
      font-weight: var(--bp-fw-medium);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .studio-meta { font-size: 11px; color: var(--bp-fg-3); margin-top: 2px; }
    .studio-time { text-align: right; }
    .studio-start { font-family: var(--bp-font-mono); font-size: 12px; color: var(--bp-purple-300); }
    .studio-end { font-family: var(--bp-font-mono); font-size: 10px; color: var(--bp-fg-4); margin-top: 2px; }

    /* ─── Ports grid ──────────────────────────────────────────────── */
    .ports-grid {
      padding: 18px;
      display: grid;
      grid-template-columns: repeat(10, 1fr);
      gap: 6px;
    }
    .port-cell {
      aspect-ratio: 1;
      border-radius: 4px;
      display: grid;
      place-items: center;
      font-size: 9px;
      font-family: var(--bp-font-mono);
      color: #fff;
    }
    .port-cell.active { background: var(--bp-purple-500); }
    .port-cell.idle { background: var(--bp-bg-3); opacity: 0.4; }
    .ports-legend {
      padding: 0 18px 16px;
      display: flex;
      gap: 14px;
      font-size: 11px;
      color: var(--bp-fg-3);
    }
    .ports-legend i {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 2px;
      margin-right: 5px;
      vertical-align: middle;
    }
    .ports-legend i.active { background: var(--bp-purple-500); }
    .ports-legend i.idle { background: var(--bp-bg-3); opacity: 0.6; }

    /* ─── Empty + loading ─────────────────────────────────────────── */
    .empty { padding: 32px; text-align: center; color: var(--bp-fg-3); font-size: 13px; }

    /* ─── Responsive ──────────────────────────────────────────────── */
    @media (max-width: 1100px) {
      .kpi-rail { grid-template-columns: repeat(2, 1fr); }
      .hero-row, .broadcasts-row, .bottom-row { grid-template-columns: 1fr; }
      .ports-grid { grid-template-columns: repeat(8, 1fr); }
    }
    @media (max-width: 700px) {
      .dashboard { padding: 0 16px 16px; }
      .kpi-rail { grid-template-columns: 1fr; }
    }
  `],
})
export class DashboardComponent implements OnInit, OnDestroy {
  private scheduleSvc = inject(ScheduleService);
  private api = inject(ApiService);

  todayDate = signal('');
  todayEyebrow = computed(() => {
    const date = this.todayDate();
    return date ? `${date} · BUGÜNÜN OPERASYONU` : 'BUGÜNÜN OPERASYONU';
  });

  // ─── State ───────────────────────────────────────────────────────────────
  loadingBroadcasts = signal(true);
  loadingStudios = signal(true);
  loadingPorts = signal(true);

  todayBroadcasts = signal<ScheduleRow[]>([]);
  todayStudios = signal<StudioSlot[]>([]);
  ports = signal<IngestPort[]>([]);

  heroBroadcast = computed<ScheduleRow | undefined>(() =>
    this.todayBroadcasts().find((b) => b.status === 'ON_AIR'),
  );

  // ─── KPIs ────────────────────────────────────────────────────────────────
  kpiTodayTotal = computed(() => this.todayBroadcasts().length);
  kpiLive = computed(() =>
    this.todayBroadcasts().filter((b) => b.status === 'ON_AIR' || b.status === 'CONFIRMED').length,
  );
  kpiActivePorts = computed(() => this.ports().filter((p) => p.active).length);
  kpiTotalPorts = computed(() => this.ports().length);
  kpiStudios = computed(() => this.todayStudios().length);
  kpiShiftCount = signal('—');
  kpiAlerts = signal('—');

  private clockSub?: Subscription;

  ngOnInit() {
    this.updateDate();
    this.clockSub = interval(60_000).subscribe(() => this.updateDate());

    this.loadTodayBroadcasts();
    this.loadStudios();
    this.loadPorts();
  }

  ngOnDestroy() {
    this.clockSub?.unsubscribe();
  }

  private updateDate() {
    const now = new Date();
    const days = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];
    const months = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
    this.todayDate.set(`${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()} · ${days[now.getDay()].toUpperCase()}`);
  }

  private isoToday(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  private loadTodayBroadcasts() {
    this.loadingBroadcasts.set(true);
    const today = this.isoToday();
    // ScheduleService.list ya da api.get('/schedules?date=YYYY-MM-DD')
    this.api.get<{ data: ScheduleRow[]; total: number } | ScheduleRow[]>(`/schedules?from=${today}&to=${today}&pageSize=50`).subscribe({
      next: (res) => {
        const rows = Array.isArray(res) ? res : (res.data ?? []);
        // Sort by startTime
        rows.sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
        this.todayBroadcasts.set(rows);
        this.loadingBroadcasts.set(false);
      },
      error: () => {
        this.todayBroadcasts.set([]);
        this.loadingBroadcasts.set(false);
      },
    });
  }

  private loadStudios() {
    this.loadingStudios.set(true);
    const today = this.isoToday();
    this.api.get<StudioSlot[] | { data: StudioSlot[] }>(`/studio-plan?date=${today}`).subscribe({
      next: (res) => {
        const arr = Array.isArray(res) ? res : (res?.data ?? []);
        this.todayStudios.set(arr);
        this.loadingStudios.set(false);
      },
      error: () => {
        this.todayStudios.set([]);
        this.loadingStudios.set(false);
      },
    });
  }

  private loadPorts() {
    this.loadingPorts.set(true);
    this.api.get<IngestPort[]>(`/recording-ports`).subscribe({
      next: (res) => {
        // beINport mockup 40 port grid; mevcut BCMS'te 8-12 port olabilir.
        // active alanı yoksa varsayılan true.
        const arr = (res ?? []).map((p) => ({ ...p, active: p.active ?? true }));
        this.ports.set(arr);
        this.loadingPorts.set(false);
      },
      error: () => {
        this.ports.set([]);
        this.loadingPorts.set(false);
      },
    });
  }

  portShortName(name: string): string {
    // "IRD-12" → "12", "FIBER-3" → "3"
    const parts = name.split(/[-\s]/);
    return parts[parts.length - 1] || name.slice(0, 3);
  }
}
