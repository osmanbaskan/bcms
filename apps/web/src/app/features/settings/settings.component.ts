import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { ApiService } from '../../core/services/api.service';

interface SmbConfig {
  share:      string;
  mountPoint: string;
  subdir:     string;
  username:   string;
  password:   string;
  domain:     string;
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatCardModule, MatFormFieldModule, MatInputModule,
    MatButtonModule, MatIconModule, MatDividerModule,
    MatProgressSpinnerModule, MatSnackBarModule,
  ],
  template: `
    <div class="page-container">
      <h1 class="page-title">Sistem Ayarları</h1>

      <mat-card class="settings-card">
        <mat-card-header>
          <mat-icon mat-card-avatar>folder_shared</mat-icon>
          <mat-card-title>OPTA SMB Bağlantısı</mat-card-title>
          <mat-card-subtitle>
            Dosya sunucusu bağlantı bilgileri — kayıt sonrası
            <code>~/.bcms-opta.cred</code> otomatik güncellenir.
          </mat-card-subtitle>
        </mat-card-header>

        <mat-card-content>
          @if (loading()) {
            <div class="center-spinner"><mat-spinner diameter="36"></mat-spinner></div>
          } @else {
            <div class="form-grid">
              <mat-form-field class="full">
                <mat-label>Share Yolu</mat-label>
                <input matInput [(ngModel)]="cfg.share" placeholder="//sunucu/klasör">
                <mat-hint>Örn: //beinfilesrv/BACKUPS</mat-hint>
              </mat-form-field>

              <mat-form-field>
                <mat-label>Mount Noktası</mat-label>
                <input matInput [(ngModel)]="cfg.mountPoint" placeholder="/mnt/opta-backups">
              </mat-form-field>

              <mat-form-field>
                <mat-label>Alt Dizin (OPTA_DIR)</mat-label>
                <input matInput [(ngModel)]="cfg.subdir" placeholder="OPTAfromFTP20511">
                <mat-hint>Mount noktasının altındaki OPTA klasörü</mat-hint>
              </mat-form-field>

              <mat-divider class="col-span"></mat-divider>

              <mat-form-field>
                <mat-label>Kullanıcı Adı</mat-label>
                <input matInput [(ngModel)]="cfg.username" autocomplete="off">
              </mat-form-field>

              <mat-form-field>
                <mat-label>Şifre</mat-label>
                <input matInput [(ngModel)]="cfg.password"
                       [type]="showPass ? 'text' : 'password'"
                       autocomplete="new-password">
                <button matSuffix mat-icon-button type="button"
                        (click)="showPass = !showPass">
                  <mat-icon>{{ showPass ? 'visibility_off' : 'visibility' }}</mat-icon>
                </button>
                <mat-hint>Boş bırakılırsa mevcut şifre korunur.</mat-hint>
              </mat-form-field>

              <mat-form-field>
                <mat-label>Domain</mat-label>
                <input matInput [(ngModel)]="cfg.domain" placeholder="OPTA_SMB_DOMAIN">
              </mat-form-field>
            </div>
          }
        </mat-card-content>

        <mat-card-actions align="end">
          <button mat-raised-button color="primary"
                  [disabled]="saving() || loading()"
                  (click)="save()">
            @if (saving()) {
              <mat-spinner diameter="18" style="display:inline-block;margin-right:6px"></mat-spinner>
              Kaydediliyor…
            } @else {
              <ng-container>
                <mat-icon>save</mat-icon> Kaydet
              </ng-container>
            }
          </button>
        </mat-card-actions>
      </mat-card>
    </div>
  `,
  styles: [`
    .page-container { padding: 24px; max-width: 760px; }
    .page-title { margin: 0 0 24px; font-size: 1.4rem; font-weight: 600; }
    .settings-card { margin-bottom: 24px; }
    .center-spinner { display:flex; justify-content:center; padding: 32px; }

    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px 20px;
      margin-top: 16px;
    }
    .full     { grid-column: 1 / -1; }
    .col-span { grid-column: 1 / -1; margin: 4px 0; }

    mat-form-field { width: 100%; }
    code { font-size: 0.8rem; background: rgba(255,255,255,.08); padding: 1px 5px; border-radius: 3px; }
  `],
})
export class SettingsComponent implements OnInit {
  cfg: SmbConfig = { share: '', mountPoint: '', subdir: '', username: '', password: '', domain: '' };
  loading = signal(true);
  saving  = signal(false);
  showPass = false;

  constructor(private api: ApiService, private snack: MatSnackBar) {}

  ngOnInit() {
    this.api.get<SmbConfig>('/opta/smb-config').subscribe({
      next:  (c) => { this.cfg = c; this.loading.set(false); },
      error: ()  => { this.loading.set(false); },
    });
  }

  save() {
    this.saving.set(true);
    this.api.post('/opta/smb-config', this.cfg).subscribe({
      next: () => {
        this.saving.set(false);
        this.snack.open('Ayarlar kaydedildi', 'Tamam', { duration: 3000 });
        // Şifreyi tekrar maskele
        if (this.cfg.password && this.cfg.password !== '********') {
          this.cfg.password = '********';
        }
      },
      error: () => {
        this.saving.set(false);
        this.snack.open('Kayıt başarısız', 'Kapat', { duration: 4000 });
      },
    });
  }
}
