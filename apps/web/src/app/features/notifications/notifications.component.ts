import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiService } from '../../core/services/api.service';
import { NotificationService } from './notification.service';
import type { UserSubscription } from './notification.types';

const SECTION_LABELS: Record<string, string> = {
  'ingest': 'Ingest', 'restore': 'Restore', 'bookings': 'İş Takip',
  'yayin-planlama': 'Yayın Planlama', 'canli-yayin-plan': 'Canlı Yayın Plan',
  'system': 'Sistem', 'provys': 'Provys', 'asrun': 'Asrun', 'studio-plan': 'Stüdyo Planı',
};
const sectionLabel = (s: string): string => SECTION_LABELS[s] ?? s;

@Component({
  selector: 'app-notifications',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatSlideToggleModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatSelectModule],
  template: `
    <div class="page">
      <div class="head">
        <div>
          <h1>Bildirimler</h1>
          <p class="sub">Gördüğün sekmelere ait bildirimleri ve seslerini buradan aç/kapat. Seçimin kalıcıdır.</p>
        </div>
        <div class="conn" [class.on]="notif.connected()">
          <mat-icon>{{ notif.connected() ? 'wifi' : 'wifi_off' }}</mat-icon>
          {{ notif.connected() ? 'Bağlı' : 'Bağlanıyor…' }}
        </div>
      </div>

      <mat-card class="card">
        <div class="row-between">
          <div>
            <strong>Tarayıcı bildirimleri</strong>
            <div class="muted">İzin: <b>{{ permLabel() }}</b> — masaüstü bildirimi için gerekli. Ses, sayfayla ilk etkileşimde otomatik açılır.</div>
          </div>
          @if (notif.permission() !== 'granted') {
            <button mat-flat-button color="primary" (click)="notif.requestPermission()">
              <mat-icon>notifications_active</mat-icon> İzin ver
            </button>
          }
        </div>
      </mat-card>

      <h2>Bildirim Aboneliklerim</h2>
      @if (loadingSubs()) { <p class="muted">Yükleniyor…</p> }
      @else if (sections().length === 0) { <p class="muted">Erişebildiğin sekmeye ait tanımlı bildirim yok.</p> }
      @for (sec of sections(); track sec.key) {
        <mat-card class="card">
          <div class="sec-title">{{ sec.label }}</div>
          @for (t of sec.items; track t.key) {
            <div class="sub-row" [class.off]="!t.enabled">
              <span class="sev sev-{{ t.severity }}"></span>
              <span class="lbl">{{ t.label }}</span>
              <span class="spacer"></span>
              <mat-form-field appearance="outline" class="sound-sel" subscriptSizing="dynamic">
                <mat-select [value]="t.sound" (selectionChange)="setSound(t, $event.value)" [disabled]="!t.enabled" panelWidth="">
                  <mat-option value="off">Sessiz</mat-option>
                  <mat-option value="normal">Normal</mat-option>
                  <mat-option value="critical">Acil</mat-option>
                </mat-select>
              </mat-form-field>
              <span class="state">{{ t.enabled ? 'Açık' : 'Kapalı' }}</span>
              <mat-slide-toggle [checked]="t.enabled" (change)="toggle(t, $event.checked)"></mat-slide-toggle>
            </div>
          }
        </mat-card>
      }
    </div>
  `,
  styles: [`
    .page { padding: 20px 24px; max-width: 900px; }
    .head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; }
    h1 { margin:0; font-size:22px; color:var(--bp-fg-1); }
    h2 { margin:24px 0 10px; font-size:16px; color:var(--bp-fg-1); }
    .sub, .muted { color:var(--bp-fg-3); font-size:13px; }
    .muted b { color:var(--bp-fg-2); }
    .conn { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--bp-fg-3); }
    .conn.on { color:#059669; }
    .conn mat-icon { font-size:18px; width:18px; height:18px; }
    .card { margin-bottom:12px; padding:14px 16px; }
    .row-between { display:flex; justify-content:space-between; align-items:center; gap:12px; }
    .sec-title { font-weight:600; color:var(--bp-fg-1); margin-bottom:6px; font-size:14px; }

    /* Hizalı satır: [renk] [etiket] ........ [ses 132px] [durum 48px] [toggle] */
    .sub-row { display:flex; align-items:center; gap:12px; padding:6px 0; border-top:1px solid var(--bp-line-2); }
    .sub-row:first-of-type { border-top:none; }
    .sub-row.off .lbl { color:var(--bp-fg-3); }
    .sev { flex:0 0 auto; width:8px; height:8px; border-radius:50%; background:var(--bp-fg-4); }
    .sev-warning { background:#d97706; } .sev-critical { background:#dc2626; } .sev-info { background:#2563eb; }
    .lbl { color:var(--bp-fg-1); }
    .spacer { flex:1 1 auto; }
    .sound-sel { flex:0 0 132px; width:132px; }
    .sound-sel ::ng-deep .mat-mdc-form-field-infix { min-height:36px; padding:5px 0; }
    .state { flex:0 0 48px; text-align:right; font-size:12px; color:var(--bp-fg-3); }
    mat-slide-toggle { flex:0 0 auto; }
  `],
})
export class NotificationsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly snack = inject(MatSnackBar);
  readonly notif = inject(NotificationService);

  loadingSubs = signal(true);
  subs = signal<UserSubscription[]>([]);

  sections = computed(() => {
    const bySec = new Map<string, UserSubscription[]>();
    for (const s of this.subs()) {
      if (!bySec.has(s.section)) bySec.set(s.section, []);
      bySec.get(s.section)!.push(s);
    }
    return [...bySec.entries()].map(([key, items]) => ({ key, label: sectionLabel(key), items }));
  });

  permLabel = computed(() => {
    const p = this.notif.permission();
    return p === 'granted' ? 'verildi' : p === 'denied' ? 'reddedildi' : 'sorulmadı';
  });

  ngOnInit(): void { this.loadSubs(); }

  private loadSubs(): void {
    this.loadingSubs.set(true);
    this.api.get<{ data: UserSubscription[] }>('/notifications/subscriptions').subscribe({
      next: (r) => { this.subs.set(r.data); this.loadingSubs.set(false); },
      error: () => { this.loadingSubs.set(false); },
    });
  }

  toggle(t: UserSubscription, enabled: boolean): void {
    this.api.put('/notifications/subscriptions', { typeKey: t.key, enabled }).subscribe({
      next: () => { this.subs.update((arr) => arr.map((s) => s.key === t.key ? { ...s, enabled } : s)); this.notif.refreshSounds(); },
      error: () => this.snack.open('Kaydedilemedi', 'Kapat', { duration: 3000 }),
    });
  }

  setSound(t: UserSubscription, sound: string): void {
    this.api.put('/notifications/subscriptions', { typeKey: t.key, enabled: t.enabled, sound }).subscribe({
      next: () => { this.subs.update((arr) => arr.map((s) => s.key === t.key ? { ...s, sound } : s)); this.notif.refreshSounds(); },
      error: () => this.snack.open('Kaydedilemedi', 'Kapat', { duration: 3000 }),
    });
  }
}
