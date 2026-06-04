import { Component, OnInit, inject, signal } from '@angular/core';
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
import { BCMS_GROUPS } from '@bcms/shared';
import { ApiService } from '../../core/services/api.service';
import type { NotificationTypeDef, NotifySeverity } from './notification.types';

const SECTION_LABELS: Record<string, string> = {
  'ingest': 'Ingest', 'restore': 'Restore', 'bookings': 'İş Takip',
  'yayin-planlama': 'Yayın Planlama', 'canli-yayin-plan': 'Canlı Yayın Plan',
  'system': 'Sistem', 'provys': 'Provys', 'asrun': 'Asrun', 'studio-plan': 'Stüdyo Planı',
};
const sectionLabel = (s: string): string => SECTION_LABELS[s] ?? s;

/**
 * Admin: bildirim tip katalogu (sekme bazlı tanım). Ayarlar > Bildirimler
 * bölümünde kullanılır. Kullanıcı abonelikleri /notifications sayfasındadır.
 */
@Component({
  selector: 'app-notification-type-catalog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatCardModule, MatSlideToggleModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  template: `
    <div class="cat">
      <p class="muted">Sekme bazlı bildirim tiplerini buradan tanımla. Kullanıcılar erişebildikleri
        tipleri YÖNETİM > Bildirimler'den açıp kapatır.</p>

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
          <mat-form-field appearance="outline"><mat-label>Varsayılan ses</mat-label>
            <mat-select [(ngModel)]="form.sound"><mat-option value="normal">normal</mat-option><mat-option value="critical">critical</mat-option></mat-select>
          </mat-form-field>
        </div>
        <div class="row-between">
          <div class="toggles">
            <mat-slide-toggle [(ngModel)]="form.defaultOn">Varsayılan açık</mat-slide-toggle>
            <mat-slide-toggle [(ngModel)]="form.active">Aktif</mat-slide-toggle>
          </div>
          <div class="actions">
            <button mat-stroked-button (click)="sendTest()"><mat-icon>science</mat-icon> Test bildirimi</button>
            <button mat-button (click)="resetForm()">Temizle</button>
            <button mat-flat-button color="primary" [disabled]="!form.key || !form.label || !form.section" (click)="saveType()">
              <mat-icon>save</mat-icon> Kaydet
            </button>
          </div>
        </div>
      </mat-card>

      @if (types().length) {
        <div class="cat-list">
          <div class="cat-row head">
            <span></span>
            <span class="ck">Anahtar</span>
            <span>Etiket</span>
            <span>Sekme</span>
            <span>Gruplar</span>
            <span>Bayrak</span>
            <span></span><span></span>
          </div>
          @for (t of types(); track t.key) {
            <div class="cat-row">
              <span class="sev sev-{{ t.severity }}" [title]="t.severity"></span>
              <span class="ck" [title]="t.key">{{ t.key }}</span>
              <span class="cl" [title]="t.label">{{ t.label }}</span>
              <span class="cs">{{ sectionLabel(t.section) }}</span>
              <span class="cg muted" [title]="t.requiredGroups.join(', ')">{{ t.requiredGroups.join(', ') || '—' }}</span>
              <span class="cflags muted">{{ t.sound }}{{ t.active ? '' : ' · pasif' }}{{ t.defaultOn ? ' · vars.açık' : '' }}</span>
              <button mat-icon-button (click)="editType(t)" title="Düzenle"><mat-icon>edit</mat-icon></button>
              <button mat-icon-button (click)="deleteType(t)" title="Sil"><mat-icon>delete</mat-icon></button>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .cat { display:block; }
    .muted { color:var(--bp-fg-3); font-size:13px; margin:0 0 12px; }
    .card { margin-bottom:12px; padding:14px 16px; }
    .form .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:8px 14px; }
    .row-between { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
    .toggles { display:flex; gap:18px; }
    .actions { display:flex; gap:8px; }
    /* Sabit sütunlu grid — içerik uzun olunca taşmaz/üst üste binmez, kendi
       hücresinde sarar. Başlık satırı (.head) ile veri satırları aynı template'i
       kullanır → kolonlar hizalı. */
    .cat-list { border:1px solid var(--bp-line-2); border-radius:8px; overflow:hidden; }
    .cat-row {
      display:grid;
      grid-template-columns: 12px minmax(150px,1.6fr) minmax(120px,1.4fr) minmax(95px,0.9fr) minmax(120px,1.4fr) minmax(95px,0.9fr) 40px 40px;
      align-items:center; gap:4px 12px; padding:8px 14px;
      border-top:1px solid var(--bp-line-2); font-size:13px; color:var(--bp-fg-1);
    }
    .cat-row > span { min-width:0; overflow-wrap:anywhere; }
    .cat-row:first-child { border-top:none; }
    .cat-row.head { background:var(--bp-bg-2); font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--bp-fg-3); padding:7px 14px; }
    .cat-row.head .ck { font-family:inherit; color:var(--bp-fg-3); }
    .cat-row .ck { font-family:var(--bp-font-mono); color:var(--bp-fg-2); }
    .cat-row .cs::before { content:'['; } .cat-row .cs::after { content:']'; }
    .cat-row.head .cs::before, .cat-row.head .cs::after { content:''; }
    .cat-row button.mat-mdc-icon-button { width:36px; height:36px; padding:6px; }
    .sev { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--bp-fg-4); }
    .sev-warning { background:#d97706; } .sev-critical { background:#dc2626; } .sev-info { background:#2563eb; }
  `],
})
export class NotificationTypeCatalogComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly snack = inject(MatSnackBar);

  readonly allGroups = BCMS_GROUPS.filter((g) => g !== 'ProvysViewer');
  readonly sectionLabel = sectionLabel;

  types = signal<NotificationTypeDef[]>([]);
  form = this.emptyForm();

  ngOnInit(): void { this.loadTypes(); }

  private loadTypes(): void {
    this.api.get<{ data: NotificationTypeDef[] }>('/notifications/types').subscribe({ next: (r) => this.types.set(r.data), error: () => {} });
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
    this.api.delete(`/notifications/types/${encodeURIComponent(t.key)}`).subscribe({ next: () => this.loadTypes(), error: () => this.snack.open('Silinemedi', 'Kapat', { duration: 3000 }) });
  }

  sendTest(): void {
    const t = this.types().find((x) => x.active) ?? null;
    const type = t?.key ?? 'service.down';
    this.api.post('/notifications', { type, title: 'Test bildirimi', body: 'Bu bir test bildirimidir.' }).subscribe({
      next: () => this.snack.open('Test gönderildi', 'Kapat', { duration: 2500 }),
      error: () => this.snack.open('Gönderilemedi', 'Kapat', { duration: 3000 }),
    });
  }
}
