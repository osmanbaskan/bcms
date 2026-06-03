import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { KeycloakService } from 'keycloak-angular';
import { BCMS_GROUPS, GROUP } from '@bcms/shared';
import { ApiService } from '../../core/services/api.service';
import { isSkipAuthAllowed } from '../../core/auth/skip-auth';
import type { BcmsTokenParsed } from '../../core/types/auth';
import { NotificationService } from './notification.service';
import type { NotificationTypeDef, UserSubscription, NotifySeverity } from './notification.types';

const SECTION_LABELS: Record<string, string> = {
  'ingest': 'Ingest', 'restore': 'Restore', 'bookings': 'İş Takip',
  'yayin-planlama': 'Yayın Planlama', 'canli-yayin-plan': 'Canlı Yayın Plan',
  'system': 'Sistem', 'provys': 'Provys', 'asrun': 'Asrun', 'studio-plan': 'Stüdyo Planı',
};
const sectionLabel = (s: string): string => SECTION_LABELS[s] ?? s;

@Component({
  selector: 'app-notifications',
  standalone: true,
  imports: [CommonModule, FormsModule, MatCardModule, MatSlideToggleModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  template: `
    <div class="page">
      <div class="head">
        <div>
          <h1>Bildirimler</h1>
          <p class="sub">Gördüğün sekmelere ait bildirimleri (ve seslerini) buradan aç/kapat. Seçimin kalıcıdır.</p>
        </div>
        <div class="conn" [class.on]="notif.connected()">
          <mat-icon>{{ notif.connected() ? 'wifi' : 'wifi_off' }}</mat-icon>
          {{ notif.connected() ? 'Bağlı' : 'Bağlanıyor…' }}
        </div>
      </div>

      <!-- Tarayıcı izni -->
      <mat-card class="card">
        <div class="row-between">
          <div>
            <strong>Tarayıcı bildirimleri</strong>
            <div class="muted">İzin: <b>{{ permLabel() }}</b> — masaüstü bildirimi için gerekli. Ses, sayfayla ilk etkileşimde otomatik açılır.</div>
          </div>
          <div class="actions">
            @if (notif.permission() !== 'granted') {
              <button mat-flat-button color="primary" (click)="notif.requestPermission()">
                <mat-icon>notifications_active</mat-icon> İzin ver
              </button>
            }
            @if (isAdmin()) {
              <button mat-stroked-button (click)="sendTest()">
                <mat-icon>science</mat-icon> Test bildirimi
              </button>
            }
          </div>
        </div>
      </mat-card>

      <!-- Kullanıcı abonelikleri -->
      <h2>Bildirim Aboneliklerim</h2>
      @if (loadingSubs()) { <p class="muted">Yükleniyor…</p> }
      @else if (sections().length === 0) { <p class="muted">Erişebildiğin sekmeye ait tanımlı bildirim yok.</p> }
      @for (sec of sections(); track sec.key) {
        <mat-card class="card">
          <div class="sec-title">{{ sec.label }}</div>
          @for (t of sec.items; track t.key) {
            <div class="row-between sub-row">
              <div>
                <span class="sev sev-{{ t.severity }}"></span>
                {{ t.label }}
              </div>
              <div class="sub-ctrl">
                <mat-form-field appearance="outline" class="sound-sel" subscriptSizing="dynamic">
                  <mat-select [value]="t.sound" (selectionChange)="setSound(t, $event.value)" [disabled]="!t.enabled">
                    <mat-option value="off">🔇 Sessiz</mat-option>
                    <mat-option value="normal">🔔 Normal</mat-option>
                    <mat-option value="critical">⛑️ Acil</mat-option>
                  </mat-select>
                </mat-form-field>
                <mat-slide-toggle [checked]="t.enabled" (change)="toggle(t, $event.checked)">
                  {{ t.enabled ? 'Açık' : 'Kapalı' }}
                </mat-slide-toggle>
              </div>
            </div>
          }
        </mat-card>
      }

      <!-- Admin: tip katalogu -->
      @if (isAdmin()) {
        <h2>Tip Katalogu <span class="muted">(Admin — sekme bazlı bildirim tanımla)</span></h2>
        <mat-card class="card form">
          <div class="grid">
            <mat-form-field appearance="outline"><mat-label>Anahtar (key)</mat-label><input matInput [(ngModel)]="form.key" placeholder="ör. ingest.completed"></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Etiket</mat-label><input matInput [(ngModel)]="form.label"></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Sekme (section)</mat-label><input matInput [(ngModel)]="form.section" placeholder="ör. ingest"></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Gruplar (erişim)</mat-label>
              <mat-select [(ngModel)]="form.requiredGroups" multiple>
                @for (g of allGroups; track g) { <mat-option [value]="g">{{ g }}</mat-option> }
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Önem</mat-label>
              <mat-select [(ngModel)]="form.severity">
                <mat-option value="info">info</mat-option><mat-option value="warning">warning</mat-option><mat-option value="critical">critical</mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Ses</mat-label>
              <mat-select [(ngModel)]="form.sound"><mat-option value="normal">normal</mat-option><mat-option value="critical">critical</mat-option></mat-select>
            </mat-form-field>
          </div>
          <div class="row-between">
            <div class="toggles">
              <mat-slide-toggle [(ngModel)]="form.defaultOn">Varsayılan açık</mat-slide-toggle>
              <mat-slide-toggle [(ngModel)]="form.active">Aktif</mat-slide-toggle>
            </div>
            <div class="actions">
              <button mat-button (click)="resetForm()">Temizle</button>
              <button mat-flat-button color="primary" [disabled]="!form.key || !form.label || !form.section" (click)="saveType()">
                <mat-icon>save</mat-icon> Kaydet
              </button>
            </div>
          </div>
        </mat-card>

        @for (t of types(); track t.key) {
          <div class="cat-row">
            <span class="sev sev-{{ t.severity }}"></span>
            <span class="ck">{{ t.key }}</span>
            <span class="cl">{{ t.label }}</span>
            <span class="cs">[{{ sectionLabel(t.section) }}]</span>
            <span class="cg muted">{{ t.requiredGroups.join(', ') }}</span>
            <span class="cflags muted">{{ t.sound }}{{ t.active ? '' : ' · pasif' }}{{ t.defaultOn ? ' · vars.açık' : '' }}</span>
            <span class="spacer"></span>
            <button mat-icon-button (click)="editType(t)" title="Düzenle"><mat-icon>edit</mat-icon></button>
            <button mat-icon-button (click)="deleteType(t)" title="Sil"><mat-icon>delete</mat-icon></button>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .page { padding: 20px 24px; max-width: 1100px; }
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
    .actions { display:flex; gap:8px; }
    .sec-title { font-weight:600; color:var(--bp-fg-1); margin-bottom:8px; font-size:14px; }
    .sub-row { padding:8px 0; border-top:1px solid var(--bp-line-2); }
    .sub-row:first-of-type { border-top:none; }
    .sub-ctrl { display:flex; align-items:center; gap:14px; }
    .sound-sel { width:130px; }
    .sound-sel ::ng-deep .mat-mdc-form-field-infix { min-height:38px; padding:6px 0; }
    .sev { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:8px; vertical-align:middle; background:var(--bp-fg-4); }
    .sev-warning { background:#d97706; } .sev-critical { background:#dc2626; } .sev-info { background:#2563eb; }
    .form .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:8px 14px; }
    .toggles { display:flex; gap:18px; }
    .cat-row { display:flex; align-items:center; gap:10px; padding:7px 12px; border-bottom:1px solid var(--bp-line-2); font-size:13px; color:var(--bp-fg-1); }
    .cat-row .ck { font-family:var(--bp-font-mono); color:var(--bp-fg-2); min-width:200px; }
    .cat-row .spacer { flex:1; }
  `],
})
export class NotificationsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly keycloak = inject(KeycloakService);
  private readonly snack = inject(MatSnackBar);
  readonly notif = inject(NotificationService);

  readonly allGroups = BCMS_GROUPS.filter((g) => g !== 'ProvysViewer');
  readonly sectionLabel = sectionLabel;

  userGroups = signal<string[]>([]);
  loadingSubs = signal(true);
  subs = signal<UserSubscription[]>([]);
  types = signal<NotificationTypeDef[]>([]);

  isAdmin = computed(() => {
    const g = this.userGroups();
    return g.includes(GROUP.Admin) || g.includes(GROUP.SystemEng);
  });

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

  form: { key: string; label: string; section: string; requiredGroups: string[]; severity: NotifySeverity; sound: string; defaultOn: boolean; active: boolean; sortOrder: number } =
    this.emptyForm();

  ngOnInit(): void {
    if (isSkipAuthAllowed()) this.userGroups.set([GROUP.SystemEng]);
    else {
      const kc = this.keycloak.getKeycloakInstance();
      const parsed = (kc?.tokenParsed as BcmsTokenParsed | undefined) ?? {};
      this.userGroups.set(parsed.groups ?? []);
    }
    this.loadSubs();
    if (this.isAdmin()) this.loadTypes();
  }

  private loadSubs(): void {
    this.loadingSubs.set(true);
    this.api.get<{ data: UserSubscription[] }>('/notifications/subscriptions').subscribe({
      next: (r) => { this.subs.set(r.data); this.loadingSubs.set(false); },
      error: () => { this.loadingSubs.set(false); },
    });
  }

  private loadTypes(): void {
    this.api.get<{ data: NotificationTypeDef[] }>('/notifications/types').subscribe({ next: (r) => this.types.set(r.data), error: () => {} });
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

  sendTest(): void {
    const t = this.types().find((x) => x.active) ?? null;
    const type = t?.key ?? 'service.down';
    this.api.post('/notifications', { type, title: 'Test bildirimi', body: 'Bu bir test bildirimidir.' }).subscribe({
      next: () => this.snack.open('Test gönderildi', 'Kapat', { duration: 2500 }),
      error: () => this.snack.open('Gönderilemedi', 'Kapat', { duration: 3000 }),
    });
  }

  emptyForm() { return { key: '', label: '', section: '', requiredGroups: [] as string[], severity: 'info' as NotifySeverity, sound: 'normal', defaultOn: true, active: true, sortOrder: 0 }; }
  resetForm(): void { this.form = this.emptyForm(); }
  editType(t: NotificationTypeDef): void { this.form = { ...t }; }

  saveType(): void {
    this.api.put('/notifications/types', this.form).subscribe({
      next: () => { this.snack.open('Tip kaydedildi', 'Kapat', { duration: 2000 }); this.resetForm(); this.loadTypes(); },
      error: () => this.snack.open('Kaydedilemedi', 'Kapat', { duration: 3000 }),
    });
  }

  deleteType(t: NotificationTypeDef): void {
    if (!confirm(`"${t.key}" tipi silinsin mi?`)) return;
    this.api.delete(`/notifications/types/${encodeURIComponent(t.key)}`).subscribe({
      next: () => this.loadTypes(), error: () => this.snack.open('Silinemedi', 'Kapat', { duration: 3000 }),
    });
  }
}
