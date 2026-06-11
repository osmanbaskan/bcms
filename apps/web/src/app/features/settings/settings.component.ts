import { ChangeDetectionStrategy, Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import {
  MatFormFieldModule,
  MAT_FORM_FIELD_DEFAULT_OPTIONS,
} from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { ApiService } from '../../core/services/api.service';
import { NotificationTypeCatalogComponent } from '../notifications/notification-type-catalog.component';
import type { RecordingPort } from '@bcms/shared';

interface SmbConfig {
  share:      string;
  mountPoint: string;
  subdir:     string;
  username:   string;
  password:   string;
  domain:     string;
}

/** Avid bağlantı ayarları GET/PUT DTO'su (backend avid.settings.ts ile eş).
 *  Sır alanlar (avidPassword/clouduxToken) GET'te '********' maske ya da '' gelir. */
interface AvidSettings {
  interplayUrl: string;
  avidUser:     string;
  avidPassword: string;
  workspace:    string;
  clouduxUrl:   string;
  clouduxRealm: string;
  clouduxToken: string;
  updatedBy:    string | null;
  updatedAt:    string | null;
}

/** Watcher bilgi + canlı durum DTO'su (backend /watchers ile eş).
 *  Salt-okunur — klasör host-mount, config worker başlangıcında env'den okunur. */
interface WatcherStatus {
  key:           string;
  label:         string;
  service:       string;
  watchFolder:   string;
  usePolling:    boolean;
  pollIntervalMs: number;
  debounceMs:    number;
  concurrency:   number;
  status:        'alive' | 'dead' | 'unknown';
  ageMs:         number | null;
  lastTickAt:    string | null;
  /** Klasör worker container'ında mevcut + dizin mi (null → worker yok). */
  folderExists:  boolean | null;
  /** chokidar aktif izliyor mu (null → worker yok). */
  watching:      boolean | null;
}

/** Provys SMB-direct kimlik durumu (şifre maskeli; backend /watchers). */
interface ProvysSmbInfo {
  user: string | null;
  domain: string | null;
  passwordSet: boolean;
  password: string | null; // '********' | null
}

interface WatchersDto {
  reachable: boolean;
  watchers: WatcherStatus[];
  provysSmb?: ProvysSmbInfo;
}

/** Haber > AA bağlantı ayarları DTO'su (backend news-settings.ts ile eş).
 *  aaApiPassword GET'te '********' maske ya da '' gelir. */
interface NewsSettings {
  aaApiUser:           string;
  aaApiPassword:       string;
  aaApiBase:           string;
  aaApiPollSeconds:    number;
  aaApiFilterType:     string;
  aaApiFilterLanguage: string;
  aaApiFilterCategory: string;
  aaApiEnabled:        boolean;
  // EGS bülten dışa-aktarım (out + xml → SMB)
  egsExportEnabled:    boolean;
  egsPrompterPath:     string;
  egsXmlPath:          string;
  egsSmbUser:          string;
  egsSmbPassword:      string;
  egsSmbDomain:        string;
  updatedBy:           string | null;
  updatedAt:           string | null;
}

/** Sol menü bölümleri. */
type SettingsSection = 'connections' | 'ports' | 'leagues' | 'notifications' | 'haber';

@Component({
  selector: 'app-settings',
  standalone: true,
  // batch-d (audit #2a): cfg/portNames [(ngModel)]-bound düz alanlar; AMA her
  // async subscribe handler'ında signal.set var (loading/saving/portsLoading/
  // portsSaving) → OnPush'ta CD tetiklenir, düz alanlar güncel okunur. ngModel
  // two-way kendi event'inde zaten CD yapar. section() de signal → CD güvenli.
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Ayarlar formları kompakt "outline" + dinamik subscript (boşken hint/hata
  // yüksekliği kaplamaz) → daha küçük, profesyonel ayar kutuları.
  providers: [
    { provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { appearance: 'outline', subscriptSizing: 'dynamic' } },
  ],
  imports: [
    CommonModule, FormsModule, RouterLink,
    MatCardModule, MatFormFieldModule, MatInputModule,
    MatButtonModule, MatIconModule, MatDividerModule,
    MatProgressSpinnerModule, MatSnackBarModule,
    NotificationTypeCatalogComponent,
  ],
  template: `
    <div class="page-container">
      <h1 class="page-title">Sistem Ayarları</h1>

      <div class="settings-shell">
        <!-- Sol bölüm menüsü (VS Code / Stripe tarzı) -->
        <nav class="settings-nav" aria-label="Ayarlar bölümleri">
          @for (s of sections; track s.id) {
            <button type="button" class="nav-item"
                    [class.active]="section() === s.id"
                    [attr.data-section]="s.id"
                    [attr.aria-current]="section() === s.id ? 'page' : null"
                    (click)="section.set(s.id)">
              <mat-icon>{{ s.icon }}</mat-icon>
              <span>{{ s.label }}</span>
            </button>
          }
        </nav>

        <!-- Seçili bölüm içeriği -->
        <div class="settings-content">
          @switch (section()) {

            <!-- ───────────── Bağlantılar ───────────── -->
            @case ('connections') {
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
                    <div class="center-spinner"><mat-spinner diameter="32"></mat-spinner></div>
                  } @else {
                    <div class="form-grid">
                      <mat-form-field>
                        <mat-label>Share Yolu</mat-label>
                        <input matInput [(ngModel)]="cfg.share" placeholder="//sunucu/klasör">
                        <mat-hint>Örn: //fileserver/BACKUPS</mat-hint>
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Mount Noktası</mat-label>
                        <input matInput [(ngModel)]="cfg.mountPoint" placeholder="/mnt/opta-backups">
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Alt Dizin (OPTA_DIR)</mat-label>
                        <input matInput [(ngModel)]="cfg.subdir" placeholder="OPTAfromFTP20511">
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Kullanıcı Adı</mat-label>
                        <input matInput [(ngModel)]="cfg.username" autocomplete="off">
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Şifre</mat-label>
                        <!-- HIGH-FE-006: cfg.password yerine ephemeral newPassword'a bağlı -->
                        <input matInput [(ngModel)]="newPassword" [ngModelOptions]="{standalone:true}"
                               [type]="showPass ? 'text' : 'password'"
                               autocomplete="new-password"
                               [placeholder]="cfg.password === '********' ? 'Mevcut şifre değişmesin' : ''">
                        <button matSuffix mat-icon-button type="button"
                                (click)="showPass = !showPass">
                          <mat-icon>{{ showPass ? 'visibility_off' : 'visibility' }}</mat-icon>
                        </button>
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
                      <ng-container><mat-icon>save</mat-icon> Kaydet</ng-container>
                    }
                  </button>
                </mat-card-actions>
              </mat-card>

              <!-- Restore V2 — Avid bağlantı ayarları. IPWS (Ara + Restore: tek
                   user/pass) + Cloud UX (Transfer: URL + token). Boş bırakılan alan
                   runtime'da ortam değişkenine (AVID_*) düşer. Sır alanlar (şifre/token)
                   maskeli gelir; boş bırakılırsa mevcut değer korunur (SMB deseni).
                   Yetki: SystemEng (+ Admin auto-bypass) — backend PERMISSIONS.avidSettings. -->
              <mat-card class="settings-card">
                <mat-card-header>
                  <mat-icon mat-card-avatar>movie</mat-icon>
                  <mat-card-title>Avid Bağlantı Ayarları</mat-card-title>
                  <mat-card-subtitle>
                    Arama + Restore (Interplay / IPWS) ve Transfer (Cloud UX) bağlantı
                    bilgileri. Boş alan ortam değişkeninden (AVID_*) okunur.
                  </mat-card-subtitle>
                </mat-card-header>

                <mat-card-content>
                  @if (avidLoading()) {
                    <div class="center-spinner"><mat-spinner diameter="32"></mat-spinner></div>
                  } @else {
                    <p class="group-label">Arama + Restore (IPWS)</p>
                    <div class="form-grid">
                      <mat-form-field class="full">
                        <mat-label>Interplay PAM URL</mat-label>
                        <input matInput [(ngModel)]="avid.interplayUrl" placeholder="http://avid-ipws/...">
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Kullanıcı Adı</mat-label>
                        <input matInput [(ngModel)]="avid.avidUser" autocomplete="off">
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Şifre</mat-label>
                        <!-- SMB deseni: avid.avidPassword state'te asla plaintext durmaz;
                             ephemeral newAvidPassword'a bağlı, mevcut değer '********' maske. -->
                        <input matInput [(ngModel)]="newAvidPassword" [ngModelOptions]="{standalone:true}"
                               [type]="showAvidPass ? 'text' : 'password'"
                               autocomplete="new-password"
                               [placeholder]="avid.avidPassword === '********' ? 'Mevcut şifre değişmesin' : ''">
                        <button matSuffix mat-icon-button type="button"
                                (click)="showAvidPass = !showAvidPass">
                          <mat-icon>{{ showAvidPass ? 'visibility_off' : 'visibility' }}</mat-icon>
                        </button>
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Workspace</mat-label>
                        <input matInput [(ngModel)]="avid.workspace" placeholder="interplay://BSVMWG/">
                      </mat-form-field>
                    </div>

                    <p class="group-label">Transfer (Cloud UX)</p>
                    <div class="form-grid">
                      <mat-form-field class="full">
                        <mat-label>Cloud UX URL</mat-label>
                        <input matInput [(ngModel)]="avid.clouduxUrl" placeholder="https://cloudux-host.example.local">
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Realm</mat-label>
                        <input matInput [(ngModel)]="avid.clouduxRealm" autocomplete="off">
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Token</mat-label>
                        <!-- Ephemeral newClouduxToken; mevcut '********' maske. -->
                        <input matInput [(ngModel)]="newClouduxToken" [ngModelOptions]="{standalone:true}"
                               [type]="showClouduxToken ? 'text' : 'password'"
                               autocomplete="new-password"
                               [placeholder]="avid.clouduxToken === '********' ? 'Mevcut token değişmesin' : ''">
                        <button matSuffix mat-icon-button type="button"
                                (click)="showClouduxToken = !showClouduxToken">
                          <mat-icon>{{ showClouduxToken ? 'visibility_off' : 'visibility' }}</mat-icon>
                        </button>
                      </mat-form-field>
                    </div>

                    @if (avid.updatedAt) {
                      <p class="meta">
                        Son güncelleme: {{ avid.updatedAt | date:'dd.MM.yyyy HH:mm' }}@if (avid.updatedBy) { · {{ avid.updatedBy }}}
                      </p>
                    }
                  }
                </mat-card-content>

                <mat-card-actions align="end">
                  <button mat-raised-button color="primary"
                          [disabled]="avidSaving() || avidLoading()"
                          (click)="saveAvid()">
                    @if (avidSaving()) {
                      <mat-spinner diameter="18" style="display:inline-block;margin-right:6px"></mat-spinner>
                      Kaydediliyor…
                    } @else {
                      <ng-container><mat-icon>save</mat-icon> Kaydet</ng-container>
                    }
                  </button>
                </mat-card-actions>
              </mat-card>

              <!-- BXF (Provys) + ASRUN dosya izleyicileri — SALT-OKUNUR bilgi +
                   canlı durum. Klasör host-mount (ops yönetir), config worker
                   başlangıcında env'den okunur → buradan değiştirilmez. Durum
                   worker'ın /health/live'ından proxy ile (backend /watchers). -->
              <div class="watcher-head">
                <span class="watcher-head-title">İzleyiciler — bilgi & durum</span>
                <button mat-icon-button type="button" (click)="loadWatchers()"
                        [disabled]="watchersLoading()" title="Durumu yenile" aria-label="Durumu yenile">
                  <mat-icon>refresh</mat-icon>
                </button>
              </div>

              @if (watchersLoading()) {
                <div class="center-spinner"><mat-spinner diameter="28"></mat-spinner></div>
              } @else {
                @if (!watchersReachable()) {
                  <p class="watcher-warn">
                    <mat-icon>warning</mat-icon>
                    Worker'a ulaşılamadı — canlı durum alınamıyor (config gösteriliyor).
                  </p>
                }
                @for (w of watchers(); track w.key) {
                  <mat-card class="settings-card watcher-card">
                    <mat-card-header>
                      <mat-icon mat-card-avatar>{{ w.key === 'provys' ? 'playlist_play' : 'fact_check' }}</mat-icon>
                      <mat-card-title>
                        {{ w.label }}
                        <span class="wstatus" [attr.data-st]="w.status">
                          <span class="dot"></span>{{ watcherStatusLabel(w.status) }}
                        </span>
                      </mat-card-title>
                      <mat-card-subtitle>
                        {{ w.key === 'provys'
                            ? 'Provys BXF playlist (.bxf) dosya izleyici. İzlenen klasör düzenlenebilir (canlı uygulanır).'
                            : 'As-run log (SMB Outbox/Ok) dosya izleyici. İzlenen klasör düzenlenebilir (canlı uygulanır).' }}
                      </mat-card-subtitle>
                    </mat-card-header>
                    <mat-card-content>
                      <!-- İzlenen klasör — EDITABLE. Worker DB'yi ~30 sn'de bir
                           okur → canlı re-watch (restart yok). Klasör container
                           içinde mount edilmiş olmalı (yoksa "bulunamadı"). -->
                      <div class="watcher-folder">
                        <mat-form-field class="folder-field">
                          <mat-label>İzlenen klasör</mat-label>
                          <input matInput [(ngModel)]="watcherFolderDraft[w.key]"
                                 [ngModelOptions]="{standalone:true}"
                                 [placeholder]="w.key === 'provys' ? '/app/tmp/… veya smb://sunucu/paylaşım/klasör/' : '/app/tmp/…'"
                                 autocomplete="off" spellcheck="false">
                          <mat-hint>{{ w.key === 'provys'
                            ? 'smb:// girilirse mount GEREKMEZ (doğrudan SMB) · değişiklik ~30 sn içinde uygulanır'
                            : 'Container içinde mount edilmiş olmalı · değişiklik ~30 sn içinde uygulanır' }}</mat-hint>
                        </mat-form-field>
                        <button mat-stroked-button type="button" class="folder-save"
                                (click)="saveWatcherFolder(w.key)"
                                [disabled]="watcherSaving() === w.key || (watcherFolderDraft[w.key] || '') === w.watchFolder">
                          @if (watcherSaving() === w.key) {
                            <mat-spinner diameter="16" style="display:inline-block;margin-right:6px"></mat-spinner>
                            Kaydediliyor…
                          } @else {
                            <ng-container><mat-icon>save</mat-icon> Kaydet</ng-container>
                          }
                        </button>
                      </div>

                      @if (w.folderExists === false) {
                        <p class="watcher-warn">
                          <mat-icon>folder_off</mat-icon>
                          Klasör worker container'ında bulunamadı — mount edilmiş mi kontrol edin (izleme durdu).
                        </p>
                      }

                      <!-- SMB-direct kimlikleri (yalnız Provys; smb:// klasör için) -->
                      @if (w.key === 'provys') {
                        <div class="watcher-folder smb-creds">
                          <mat-form-field class="smb-field">
                            <mat-label>SMB kullanıcı</mat-label>
                            <input matInput [(ngModel)]="provysSmbDraft.user" [ngModelOptions]="{standalone:true}"
                                   autocomplete="off" spellcheck="false">
                          </mat-form-field>
                          <mat-form-field class="smb-field">
                            <mat-label>SMB domain</mat-label>
                            <input matInput [(ngModel)]="provysSmbDraft.domain" [ngModelOptions]="{standalone:true}"
                                   autocomplete="off" spellcheck="false">
                          </mat-form-field>
                          <mat-form-field class="smb-field">
                            <mat-label>SMB şifre</mat-label>
                            <input matInput type="password" [(ngModel)]="provysSmbDraft.password"
                                   [ngModelOptions]="{standalone:true}" autocomplete="new-password">
                            <mat-hint>{{ provysSmbDraft.password === '********' ? 'Kayıtlı — değiştirmek için yenisini yaz' : 'smb:// klasör için gerekli' }}</mat-hint>
                          </mat-form-field>
                          <button mat-stroked-button type="button" class="folder-save"
                                  (click)="saveProvysSmb()" [disabled]="watcherSaving() === 'provys-smb'">
                            @if (watcherSaving() === 'provys-smb') {
                              <mat-spinner diameter="16" style="display:inline-block;margin-right:6px"></mat-spinner>
                              Kaydediliyor…
                            } @else {
                              <ng-container><mat-icon>key</mat-icon> Kimliği Kaydet</ng-container>
                            }
                          </button>
                        </div>
                      }

                      <div class="watcher-info">
                        <div class="item">
                          <div class="k">İzleme modu</div>
                          <div class="v">{{ w.usePolling ? ('Polling · ' + (w.pollIntervalMs / 1000) + ' sn') : 'Anlık (fs events)' }}</div>
                        </div>
                        <div class="item">
                          <div class="k">Debounce</div>
                          <div class="v">{{ w.debounceMs }} ms</div>
                        </div>
                        <div class="item">
                          <div class="k">Eşzamanlılık</div>
                          <div class="v">{{ w.concurrency }}</div>
                        </div>
                        <div class="item">
                          <div class="k">Son sinyal</div>
                          <div class="v">{{ w.lastTickAt ? (w.lastTickAt | date:'HH:mm:ss') + ' · ' + watcherAgeText(w.ageMs) : '—' }}</div>
                        </div>
                      </div>
                    </mat-card-content>
                  </mat-card>
                }
              }
            }

            <!-- ───────────── Haber (AA bağlantısı) ───────────── -->
            @case ('haber') {
              <mat-card class="settings-card">
                <mat-card-header>
                  <mat-icon mat-card-avatar>feed</mat-icon>
                  <mat-card-title>Haber — AA (Anadolu Ajansı) Bağlantısı</mat-card-title>
                  <mat-card-subtitle>
                    AA Media API doğrudan çekim. Boş alan ortam değişkeninden (AA_API_*) okunur;
                    şifre maskeli gelir, boş bırakılırsa mevcut korunur. Değişiklik restart'sız etki eder.
                  </mat-card-subtitle>
                </mat-card-header>
                <mat-card-content>
                  @if (newsLoading()) {
                    <div class="center-spinner"><mat-spinner diameter="32"></mat-spinner></div>
                  } @else {
                    <div class="form-grid">
                      <mat-form-field class="full">
                        <mat-label>API URL</mat-label>
                        <input matInput [(ngModel)]="news.aaApiBase" placeholder="https://api.aa.com.tr">
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Kullanıcı Adı (abone no)</mat-label>
                        <input matInput [(ngModel)]="news.aaApiUser" autocomplete="off" placeholder="3000770">
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Şifre</mat-label>
                        <input matInput [(ngModel)]="newNewsPassword" [ngModelOptions]="{standalone:true}"
                               [type]="showNewsPass ? 'text' : 'password'"
                               autocomplete="new-password"
                               [placeholder]="news.aaApiPassword === '********' ? 'Mevcut şifre değişmesin' : ''">
                        <button matSuffix mat-icon-button type="button" (click)="showNewsPass = !showNewsPass">
                          <mat-icon>{{ showNewsPass ? 'visibility_off' : 'visibility' }}</mat-icon>
                        </button>
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Poll Aralığı (sn)</mat-label>
                        <input matInput type="number" min="60" [(ngModel)]="news.aaApiPollSeconds">
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Filtre: Tür</mat-label>
                        <input matInput [(ngModel)]="news.aaApiFilterType" placeholder="1 = metin">
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Filtre: Dil</mat-label>
                        <input matInput [(ngModel)]="news.aaApiFilterLanguage" placeholder="1 = Türkçe">
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Filtre: Kategori (ops.)</mat-label>
                        <input matInput [(ngModel)]="news.aaApiFilterCategory" placeholder="boş = tümü">
                      </mat-form-field>
                    </div>

                    <label class="news-toggle">
                      <input type="checkbox" [(ngModel)]="news.aaApiEnabled" [ngModelOptions]="{standalone:true}">
                      AA çekimi aktif
                    </label>

                    @if (news.updatedAt) {
                      <p class="meta">
                        Son güncelleme: {{ news.updatedAt | date:'dd.MM.yyyy HH:mm' }}@if (news.updatedBy) { · {{ news.updatedBy }}}
                      </p>
                    }
                  }
                </mat-card-content>
                <mat-card-actions align="end">
                  <button mat-raised-button color="primary"
                          [disabled]="newsSaving() || newsLoading()" (click)="saveNews()">
                    @if (newsSaving()) {
                      <mat-spinner diameter="18" style="display:inline-block;margin-right:6px"></mat-spinner>
                      Kaydediliyor…
                    } @else {
                      <ng-container><mat-icon>save</mat-icon> Kaydet</ng-container>
                    }
                  </button>
                </mat-card-actions>
              </mat-card>

              <!-- ───────────── Haber — EGS Bülten Dışa-Aktarım ───────────── -->
              <mat-card class="settings-card">
                <mat-card-header>
                  <mat-icon mat-card-avatar>outbox</mat-icon>
                  <mat-card-title>Haber — EGS Bülten Gönderimi (Prompter + Vizrt)</mat-card-title>
                  <mat-card-subtitle>
                    "Bülteni Gönder" prompter <code>_out.WIN</code> ve Vizrt <code>.xml</code> dosyalarını
                    SMB hedeflere yazar. Prompter ve XML yolu ayrı verilebilir. Şifre maskeli gelir,
                    boş bırakılırsa mevcut korunur.
                  </mat-card-subtitle>
                </mat-card-header>
                <mat-card-content>
                  @if (!newsLoading()) {
                    <div class="form-grid">
                      <mat-form-field class="full">
                        <mat-label>Prompter (_out.WIN) yolu</mat-label>
                        <input matInput [(ngModel)]="news.egsPrompterPath" placeholder="smb://172.26.33.245/mcr/EGS/">
                      </mat-form-field>
                      <mat-form-field class="full">
                        <mat-label>Vizrt (.xml) yolu</mat-label>
                        <input matInput [(ngModel)]="news.egsXmlPath" placeholder="smb://172.26.33.245/mcr/EGS/">
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>SMB Kullanıcı</mat-label>
                        <input matInput [(ngModel)]="news.egsSmbUser" autocomplete="off" placeholder="kullanıcı">
                      </mat-form-field>
                      <mat-form-field>
                        <mat-label>SMB Şifre</mat-label>
                        <input matInput [(ngModel)]="newEgsPassword" [ngModelOptions]="{standalone:true}"
                               [type]="showEgsPass ? 'text' : 'password'" autocomplete="new-password"
                               [placeholder]="news.egsSmbPassword === '********' ? 'Mevcut şifre değişmesin' : ''">
                        <button matSuffix mat-icon-button type="button" (click)="showEgsPass = !showEgsPass">
                          <mat-icon>{{ showEgsPass ? 'visibility_off' : 'visibility' }}</mat-icon>
                        </button>
                      </mat-form-field>
                      <mat-form-field>
                        <mat-label>SMB Domain</mat-label>
                        <input matInput [(ngModel)]="news.egsSmbDomain" placeholder="trbeinsports">
                      </mat-form-field>
                    </div>

                    <label class="news-toggle">
                      <input type="checkbox" [(ngModel)]="news.egsExportEnabled" [ngModelOptions]="{standalone:true}">
                      EGS bülten gönderimi aktif
                    </label>
                  }
                </mat-card-content>
                <mat-card-actions align="end">
                  <button mat-raised-button color="primary"
                          [disabled]="newsSaving() || newsLoading()" (click)="saveNews()">
                    @if (newsSaving()) {
                      <mat-spinner diameter="18" style="display:inline-block;margin-right:6px"></mat-spinner>
                      Kaydediliyor…
                    } @else {
                      <ng-container><mat-icon>save</mat-icon> Kaydet</ng-container>
                    }
                  </button>
                </mat-card-actions>
              </mat-card>
            }

            <!-- ───────────── Kayıt Portları ───────────── -->
            @case ('ports') {
              <mat-card class="settings-card">
                <mat-card-header>
                  <mat-icon mat-card-avatar>settings_input_component</mat-icon>
                  <mat-card-title>Kayıt Portları</mat-card-title>
                  <mat-card-subtitle>
                    Ingest planlama ekranındaki kayıt portu seçenekleri@if (!portsLoading()) { · {{ portNames.length }} port}.
                  </mat-card-subtitle>
                </mat-card-header>

                <mat-card-content>
                  @if (portsLoading()) {
                    <div class="center-spinner"><mat-spinner diameter="32"></mat-spinner></div>
                  } @else {
                    <div class="port-grid">
                      @for (port of portNames; track $index) {
                        <div class="port-chip">
                          <input class="port-input" [(ngModel)]="portNames[$index]"
                                 [ngModelOptions]="{standalone:true}"
                                 placeholder="1" aria-label="Port adı">
                          <button type="button" class="port-del"
                                  (click)="removePort($index)"
                                  [disabled]="portNames.length <= 1"
                                  aria-label="Portu sil">
                            <mat-icon>close</mat-icon>
                          </button>
                        </div>
                      }
                    </div>
                  }
                </mat-card-content>

                <mat-card-actions align="end">
                  <button mat-stroked-button type="button" (click)="addPort()" [disabled]="portsLoading() || portsSaving()">
                    <mat-icon>add</mat-icon> Port Ekle
                  </button>
                  <button mat-raised-button color="primary" type="button" (click)="savePorts()" [disabled]="portsLoading() || portsSaving()">
                    @if (portsSaving()) {
                      <mat-spinner diameter="18" style="display:inline-block;margin-right:6px"></mat-spinner>
                      Kaydediliyor…
                    } @else {
                      <ng-container><mat-icon>save</mat-icon> Kaydet</ng-container>
                    }
                  </button>
                </mat-card-actions>
              </mat-card>
            }

            <!-- ───────────── Lig / İçerik ───────────── -->
            @case ('leagues') {
              <!-- 2026-05-13: OPTA Lig Görünürlüğü — ayrı admin route (Admin/SystemEng).
                   Page-level guard PERMISSIONS.opta.admin (route data.groups);
                   kart her zaman görünür ama yetkisiz tıklama AuthGuard ile reddedilir. -->
              <mat-card class="settings-card link-card">
                <mat-card-header>
                  <mat-icon mat-card-avatar>visibility</mat-icon>
                  <mat-card-title>OPTA Lig / Turnuva Görünürlüğü</mat-card-title>
                  <mat-card-subtitle>
                    Canlı Yayın Plan "Yeni Ekle" dropdown'ında gösterilecek ligleri yönet.
                  </mat-card-subtitle>
                </mat-card-header>
                <mat-card-actions align="end">
                  <a mat-stroked-button routerLink="/admin/opta-competitions">
                    <mat-icon>open_in_new</mat-icon> Aç
                  </a>
                </mat-card-actions>
              </mat-card>

              <!-- 2026-05-15: Manuel Lig Yönetimi — Canlı Yayın Plan "Yeni Ekle /
                   Manuel Giriş / Lig (opsiyonel)" dropdown filter alanı
                   manual_selectable. OPTA görünürlüğünden bağımsız ayrı admin
                   route; yetki OPTA admin ile birebir aynı. -->
              <mat-card class="settings-card link-card">
                <mat-card-header>
                  <mat-icon mat-card-avatar>edit_note</mat-icon>
                  <mat-card-title>Manuel Lig Yönetimi</mat-card-title>
                  <mat-card-subtitle>
                    Manuel girişte seçilebilir ligleri yönetin
                  </mat-card-subtitle>
                </mat-card-header>
                <mat-card-actions align="end">
                  <a mat-stroked-button routerLink="/admin/manual-leagues">
                    <mat-icon>open_in_new</mat-icon> Aç
                  </a>
                </mat-card-actions>
              </mat-card>
            }

            <!-- ───────────── Bildirimler (admin tip katalogu) ───────────── -->
            @case ('notifications') {
              <app-notification-type-catalog />
            }
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    /* Geniş ekran: içerik solda sıkışıp sağ taraf boş kalmasın → geniş
       container. Form alanları 3 sütun (aşağı uzamaz, yatayda yayılır). */
    .page-container { padding: 24px; max-width: 1700px; }
    .page-title { margin: 0 0 20px; font-size: 1.4rem; font-weight: 600; }

    /* ── İki bölmeli kabuk: sol menü + sağ içerik ── */
    .settings-shell { display: flex; gap: 28px; align-items: flex-start; }

    .settings-nav {
      flex: 0 0 220px; width: 220px;
      position: sticky; top: 16px;
      display: flex; flex-direction: column; gap: 2px;
    }
    .nav-item {
      display: flex; align-items: center; gap: 12px;
      width: 100%; padding: 10px 14px;
      border: 0; border-radius: 8px;
      background: transparent; color: inherit;
      font-size: 0.92rem; text-align: left; cursor: pointer;
      opacity: 0.75; transition: background .12s, opacity .12s;
    }
    .nav-item:hover { background: rgba(255,255,255,.06); opacity: 1; }
    .nav-item.active {
      background: rgba(124,77,255,.16);
      color: var(--bp-acc-purple); opacity: 1; font-weight: 600;
    }
    .nav-item mat-icon { font-size: 20px; width: 20px; height: 20px; }

    .settings-content { flex: 1; min-width: 0; }

    .settings-card { margin-bottom: 20px; }
    .link-card { max-width: 560px; }
    .center-spinner { display: flex; justify-content: center; padding: 28px; }

    .group-label {
      margin: 14px 0 2px; font-size: 0.78rem; font-weight: 600;
      letter-spacing: .04em; text-transform: uppercase; opacity: 0.55;
    }
    .group-label:first-child { margin-top: 4px; }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px 16px;
      margin-top: 6px;
    }
    .full { grid-column: 1 / -1; }

    /* ── Kayıt Portları: kompakt chip ızgarası ── */
    .port-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(116px, 1fr));
      gap: 10px;
      margin-top: 8px;
    }
    .port-chip {
      display: grid; grid-template-columns: 1fr 28px; align-items: center;
      background: rgba(255,255,255,.05);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px; padding-left: 10px;
      transition: border-color .12s;
    }
    .port-chip:focus-within { border-color: #7c4dff; }
    .port-input {
      width: 100%; background: transparent; border: 0; color: inherit;
      font-size: 0.9rem; padding: 8px 0;
    }
    .port-input:focus { outline: none; }
    .port-del {
      display: flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; margin: 1px;
      border: 0; border-radius: 6px; background: transparent;
      color: inherit; opacity: 0.55; cursor: pointer;
    }
    .port-del:hover:not(:disabled) { opacity: 1; background: rgba(255,255,255,.08); }
    .port-del:disabled { opacity: 0.2; cursor: default; }
    .port-del mat-icon { font-size: 18px; width: 18px; height: 18px; }

    mat-form-field { width: 100%; }
    .meta { margin: 10px 0 0; font-size: 0.8rem; opacity: 0.7; }
    .news-toggle { display: inline-flex; align-items: center; gap: 8px; margin: 8px 0 2px; font-size: 0.9rem; cursor: pointer; }
    .news-toggle input { width: 16px; height: 16px; cursor: pointer; }
    code { font-size: 0.8rem; background: rgba(255,255,255,.08); padding: 1px 5px; border-radius: 3px; }

    /* ── İzleyici (BXF/ASRUN) bilgi kartları — salt-okunur + durum rozeti ── */
    .watcher-head {
      display: flex; align-items: center; justify-content: space-between;
      margin: 8px 2px 8px;
    }
    .watcher-head-title {
      font-size: 0.78rem; font-weight: 600; letter-spacing: .04em;
      text-transform: uppercase; opacity: 0.55;
    }
    .watcher-warn {
      display: flex; align-items: center; gap: 8px;
      font-size: 0.85rem; color: #f59e0b; margin: 0 0 12px;
    }
    .watcher-warn mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .watcher-card mat-card-title {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    .wstatus {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 0.72rem; font-weight: 600;
      padding: 2px 9px; border-radius: 999px;
      background: rgba(148,163,184,.18); color: #9ca3af;   /* unknown */
    }
    .wstatus .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .wstatus[data-st="alive"] { background: rgba(16,185,129,.16); color: #10b981; }
    .wstatus[data-st="dead"]  { background: rgba(239,68,68,.16);  color: #ef4444; }
    .watcher-info {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px 24px; margin-top: 6px;
    }
    .watcher-info .k {
      font-size: 0.72rem; text-transform: uppercase; letter-spacing: .04em;
      opacity: 0.55; margin-bottom: 2px;
    }
    .watcher-info .v { font-size: 0.9rem; word-break: break-all; }
    .watcher-folder {
      display: flex; align-items: flex-start; gap: 12px;
      margin-top: 6px;
    }
    .folder-field { flex: 1; min-width: 0; }
    .folder-save { flex-shrink: 0; margin-top: 6px; }
    /* SMB-direct kimlik satırı (yalnız Provys kartı) */
    .smb-creds { flex-wrap: wrap; }
    .smb-field { flex: 1 1 160px; min-width: 140px; }

    /* ── LIGHT TEMA (2026-06-02): port chip'leri beyaz-alfa
       (rgba(255,255,255,.05/.12)) → açık zeminde "kutu = bg", kayboluyordu.
       Mor gradient + görünür mor kenarlık. (Kartlar artık global styles.scss
       light kuralıyla kapsanıyor.) Yalnız data-theme="light". ── */
    :host-context(html[data-theme="light"]) .port-chip {
      background: linear-gradient(160deg, #efe6ff 0%, #ddccff 100%);
      border-color: rgba(76, 29, 149, 0.32);
    }
    :host-context(html[data-theme="light"]) code {
      background: rgba(124, 58, 237, 0.12);
    }

    /* ── Orta ekran: 3 sütun sığmaz → 2 sütun ── */
    @media (max-width: 1180px) {
      .form-grid { grid-template-columns: 1fr 1fr; }
    }

    /* ── Dar ekran: menü üstte yatay + tek sütun ── */
    @media (max-width: 820px) {
      .settings-shell { flex-direction: column; gap: 16px; }
      .settings-nav {
        flex-direction: row; width: 100%; position: static;
        overflow-x: auto; gap: 6px; padding-bottom: 4px;
      }
      .nav-item { width: auto; white-space: nowrap; }
      .form-grid { grid-template-columns: 1fr; }
    }
  `],
})
export class SettingsComponent implements OnInit {
  /** Aktif sol-menü bölümü. Varsayılan: Bağlantılar. */
  section = signal<SettingsSection>('connections');
  readonly sections: ReadonlyArray<{ id: SettingsSection; label: string; icon: string }> = [
    { id: 'connections',   label: 'Bağlantılar',    icon: 'cable' },
    { id: 'haber',         label: 'Haber',           icon: 'feed' },
    { id: 'ports',         label: 'Kayıt Portları',  icon: 'settings_input_component' },
    { id: 'leagues',       label: 'Lig / İçerik',    icon: 'sports_soccer' },
    { id: 'notifications', label: 'Bildirimler',     icon: 'notifications' },
  ];

  cfg: SmbConfig = { share: '', mountPoint: '', subdir: '', username: '', password: '', domain: '' };
  /** HIGH-FE-006 fix (2026-05-05): SMB password component state'te plaintext
   *  durmasın — ayrı `newPassword` ephemeral input. cfg.password ekrana
   *  '********' placeholder olarak yansır, gerçek değer asla state'te bulunmaz.
   *  Kullanıcı şifre değiştirmek için newPassword'e girer; submit sonrası alan
   *  temizlenir, Angular DevTools'ta artakalan plaintext yok. */
  newPassword = '';
  loading = signal(true);
  saving  = signal(false);
  portsLoading = signal(true);
  portsSaving = signal(false);
  portNames: string[] = [];
  showPass = false;

  /** Avid ayarları — SMB ile aynı ephemeral-sır deseni: avid.avidPassword /
   *  avid.clouduxToken state'te yalnız '********' maske durur; gerçek yeni değer
   *  newAvidPassword / newClouduxToken'da geçici tutulur, submit sonrası silinir. */
  avid: AvidSettings = {
    interplayUrl: '', avidUser: '', avidPassword: '', workspace: '',
    clouduxUrl: '', clouduxRealm: '', clouduxToken: '', updatedBy: null, updatedAt: null,
  };
  newAvidPassword = '';
  newClouduxToken = '';
  avidLoading = signal(true);
  avidSaving  = signal(false);
  showAvidPass = false;
  showClouduxToken = false;

  /** Haber > AA ayarları — Avid ile aynı ephemeral-sır deseni (şifre maske '********'). */
  news: NewsSettings = {
    aaApiUser: '', aaApiPassword: '', aaApiBase: '', aaApiPollSeconds: 300,
    aaApiFilterType: '', aaApiFilterLanguage: '', aaApiFilterCategory: '',
    aaApiEnabled: true,
    egsExportEnabled: false, egsPrompterPath: '', egsXmlPath: '',
    egsSmbUser: '', egsSmbPassword: '', egsSmbDomain: '',
    updatedBy: null, updatedAt: null,
  };
  newNewsPassword = '';
  newEgsPassword = '';
  newsLoading = signal(true);
  newsSaving  = signal(false);
  showNewsPass = false;
  showEgsPass = false;

  /** BXF/Provys + ASRUN izleyici bilgi + canlı durum (salt-okunur).
   *  reachable=false → worker'a ulaşılamadı, durum 'unknown'. */
  watchers = signal<WatcherStatus[]>([]);
  watchersLoading = signal(true);
  watchersReachable = signal(true);
  /** Editable izlenen-klasör taslağı (watcher key → yol). loadWatchers tazeler. */
  watcherFolderDraft: Record<string, string> = {};
  /** Kaydedilen watcher key (spinner için), yoksa null. */
  watcherSaving = signal<string | null>(null);

  constructor(private api: ApiService, private snack: MatSnackBar) {}

  ngOnInit() {
    this.api.get<SmbConfig>('/opta/smb-config').subscribe({
      next:  (c) => {
        // Backend zaten password alanını '********' veya boş döner; defansif
        // olarak biz de mask ile state'e koy.
        this.cfg = { ...c, password: c.password ? '********' : '' };
        this.loading.set(false);
      },
      error: ()  => { this.loading.set(false); },
    });
    this.loadPorts();
    this.loadAvid();
    this.loadNews();
    this.loadWatchers();
  }

  /** Provys SMB-direct kimlik taslağı (şifre '********' = kayıtlı, dokunulmadı). */
  provysSmbDraft: { user: string; domain: string; password: string } = { user: '', domain: '', password: '' };

  loadWatchers() {
    this.watchersLoading.set(true);
    this.api.get<WatchersDto>('/watchers').subscribe({
      next: (r) => {
        const list = Array.isArray(r?.watchers) ? r.watchers : [];
        this.watchers.set(list);
        // Editable taslakları efektif klasörle tazele (kullanıcı düzenlemesini
        // ezmemek için yalnız yükleme/yenileme anında).
        this.watcherFolderDraft = Object.fromEntries(list.map((w) => [w.key, w.watchFolder]));
        this.provysSmbDraft = {
          user: r?.provysSmb?.user ?? '',
          domain: r?.provysSmb?.domain ?? '',
          password: r?.provysSmb?.password ?? '',
        };
        this.watchersReachable.set(!!r?.reachable);
        this.watchersLoading.set(false);
      },
      error: () => {
        this.watchersLoading.set(false);
        this.watchersReachable.set(false);
        this.snack.open('İzleyici durumu alınamadı', 'Kapat', { duration: 4000 });
      },
    });
  }

  /** İzlenen klasör override'ını kaydet (canlı re-watch: worker ~30 sn'de uygular). */
  saveWatcherFolder(key: string) {
    const folder = (this.watcherFolderDraft[key] ?? '').trim();
    const field = key === 'provys' ? 'provysWatchFolder' : 'asrunWatchFolder';
    this.watcherSaving.set(key);
    this.api.put<WatchersDto>('/watchers/folder', { [field]: folder })
      .subscribe({
        next: (r) => {
          const list = Array.isArray(r?.watchers) ? r.watchers : [];
          this.watchers.set(list);
          this.watcherFolderDraft = Object.fromEntries(list.map((w) => [w.key, w.watchFolder]));
          this.watchersReachable.set(!!r?.reachable);
          this.watcherSaving.set(null);
          this.snack.open('Klasör kaydedildi — değişiklik ~30 sn içinde uygulanır', 'Tamam', { duration: 4000 });
        },
        error: (err) => {
          this.watcherSaving.set(null);
          this.snack.open(`Klasör kaydedilemedi: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
        },
      });
  }

  /** Provys SMB-direct kimliklerini kaydet ('********' şifre backend'de yok sayılır). */
  saveProvysSmb() {
    this.watcherSaving.set('provys-smb');
    this.api.put<WatchersDto>('/watchers/folder', {
      provysSmbUser: this.provysSmbDraft.user.trim(),
      provysSmbDomain: this.provysSmbDraft.domain.trim(),
      provysSmbPassword: this.provysSmbDraft.password,
    }).subscribe({
      next: (r) => {
        this.provysSmbDraft = {
          user: r?.provysSmb?.user ?? '',
          domain: r?.provysSmb?.domain ?? '',
          password: r?.provysSmb?.password ?? '',
        };
        this.watcherSaving.set(null);
        this.snack.open('SMB kimliği kaydedildi', 'Tamam', { duration: 3500 });
      },
      error: (err) => {
        this.watcherSaving.set(null);
        this.snack.open(`Kimlik kaydedilemedi: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }

  /** Watcher durum etiketi (rozet). */
  watcherStatusLabel(s: string): string {
    return s === 'alive' ? 'Çalışıyor' : s === 'dead' ? 'Yanıt yok' : 'Bilinmiyor';
  }

  /** "Son sinyal" göreli süre — ms → "12 sn önce" / "3 dk önce". */
  watcherAgeText(ms: number | null): string {
    if (ms == null) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s} sn önce`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} dk önce` : `${Math.floor(m / 60)} sa önce`;
  }

  loadAvid() {
    this.avidLoading.set(true);
    this.api.get<AvidSettings>('/avid/settings').subscribe({
      next: (a) => {
        // Backend sır alanları zaten maskeli ('********') ya da '' döner.
        this.avid = a;
        this.avidLoading.set(false);
      },
      error: () => {
        this.avidLoading.set(false);
        this.snack.open('Avid ayarları alınamadı', 'Kapat', { duration: 4000 });
      },
    });
  }

  saveAvid() {
    this.avidSaving.set(true);
    // Düz alanlar her zaman gönderilir (boş → backend null'a çevirir, env'e
    // düşer). Sır alanlar yalnız kullanıcı yeni değer girdiyse eklenir;
    // maske/boş gönderilmez → backend mevcut sırrı korur.
    const payload: Partial<AvidSettings> = {
      interplayUrl: this.avid.interplayUrl,
      avidUser:     this.avid.avidUser,
      workspace:    this.avid.workspace,
      clouduxUrl:   this.avid.clouduxUrl,
      clouduxRealm: this.avid.clouduxRealm,
    };
    if (this.newAvidPassword.trim()) payload.avidPassword = this.newAvidPassword;
    if (this.newClouduxToken.trim()) payload.clouduxToken = this.newClouduxToken;

    this.api.put<AvidSettings>('/avid/settings', payload).subscribe({
      next: (a) => {
        this.avid = a;                 // efektif maskeli DTO geri döner
        this.newAvidPassword = '';     // ephemeral sır alanlarını temizle
        this.newClouduxToken = '';
        this.avidSaving.set(false);
        this.snack.open('Avid ayarları kaydedildi', 'Tamam', { duration: 3000 });
      },
      error: (err) => {
        this.newAvidPassword = '';     // hata da olsa plaintext'i temizle
        this.newClouduxToken = '';
        this.avidSaving.set(false);
        this.snack.open(`Avid ayarları kaydedilemedi: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }

  loadNews() {
    this.newsLoading.set(true);
    this.api.get<NewsSettings>('/news/settings').subscribe({
      next: (n) => { this.news = n; this.newsLoading.set(false); },
      error: () => { this.newsLoading.set(false); this.snack.open('Haber ayarları alınamadı', 'Kapat', { duration: 4000 }); },
    });
  }

  saveNews() {
    this.newsSaving.set(true);
    // Düz alanlar her zaman gönderilir (boş → env'e düşer). Şifre yalnız yeni
    // değer girildiyse — maske/boş gönderilmez (backend mevcudu korur).
    const payload: Partial<NewsSettings> = {
      aaApiUser:           this.news.aaApiUser,
      aaApiBase:           this.news.aaApiBase,
      aaApiPollSeconds:    Number(this.news.aaApiPollSeconds) || 300,
      aaApiFilterType:     this.news.aaApiFilterType,
      aaApiFilterLanguage: this.news.aaApiFilterLanguage,
      aaApiFilterCategory: this.news.aaApiFilterCategory,
      aaApiEnabled:        this.news.aaApiEnabled,
      egsExportEnabled:    this.news.egsExportEnabled,
      egsPrompterPath:     this.news.egsPrompterPath,
      egsXmlPath:          this.news.egsXmlPath,
      egsSmbUser:          this.news.egsSmbUser,
      egsSmbDomain:        this.news.egsSmbDomain,
    };
    if (this.newNewsPassword.trim()) payload.aaApiPassword = this.newNewsPassword;
    if (this.newEgsPassword.trim()) payload.egsSmbPassword = this.newEgsPassword;

    this.api.put<NewsSettings>('/news/settings', payload).subscribe({
      next: (n) => {
        this.news = n;
        this.newNewsPassword = '';
        this.newEgsPassword = '';
        this.newsSaving.set(false);
        this.snack.open('Haber ayarları kaydedildi', 'Tamam', { duration: 3000 });
      },
      error: (err) => {
        this.newNewsPassword = '';
        this.newEgsPassword = '';
        this.newsSaving.set(false);
        this.snack.open(`Haber ayarları kaydedilemedi: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }

  save() {
    this.saving.set(true);
    const payload: Partial<SmbConfig> = { ...this.cfg };
    delete payload.password;   // mask değer asla gönderilmez
    if (this.newPassword.trim()) {
      payload.password = this.newPassword;   // sadece kullanıcı yeni girdiyse
    }
    this.api.post('/opta/smb-config', payload).subscribe({
      next: () => {
        this.saving.set(false);
        this.snack.open('Ayarlar kaydedildi', 'Tamam', { duration: 3000 });
        if (this.newPassword) {
          this.cfg.password = '********';
          this.newPassword = '';     // ephemeral alan temizlenir
        }
      },
      error: () => {
        this.saving.set(false);
        this.newPassword = '';       // hata da olsa plaintext'i temizle
        this.snack.open('Kayıt başarısız', 'Kapat', { duration: 4000 });
      },
    });
  }

  loadPorts() {
    this.portsLoading.set(true);
    this.api.get<RecordingPort[]>('/ingest/recording-ports').subscribe({
      next: (ports) => {
        this.portNames = (Array.isArray(ports) ? ports : [])
          .filter((port) => port.active)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'tr'))
          .map((port) => port.name);
        if (this.portNames.length === 0) this.portNames = ['1'];
        this.portsLoading.set(false);
      },
      error: () => {
        this.portNames = ['1'];
        this.portsLoading.set(false);
        this.snack.open('Kayıt portları alınamadı', 'Kapat', { duration: 4000 });
      },
    });
  }

  addPort() {
    const numericPorts = this.portNames.map((name) => Number(name)).filter((value) => Number.isInteger(value));
    const nextPort = numericPorts.length ? Math.max(...numericPorts) + 1 : this.portNames.length + 1;
    this.portNames = [...this.portNames, String(nextPort)];
  }

  removePort(index: number) {
    this.portNames = [...this.portNames.slice(0, index), ...this.portNames.slice(index + 1)];
  }

  savePorts() {
    const names = [...new Set(this.portNames.map((name) => name.trim()).filter(Boolean))];
    if (names.length === 0) {
      this.snack.open('En az bir kayıt portu olmalı', 'Kapat', { duration: 3000 });
      return;
    }

    this.portsSaving.set(true);
    this.api.put<RecordingPort[]>('/ingest/recording-ports', {
      ports: names.map((name, index) => ({ name, sortOrder: (index + 1) * 10, active: true })),
    }).subscribe({
      next: (ports) => {
        this.portNames = ports.filter((port) => port.active).map((port) => port.name);
        this.portsSaving.set(false);
        this.snack.open('Kayıt portları kaydedildi', 'Tamam', { duration: 3000 });
      },
      error: (err) => {
        this.portsSaving.set(false);
        this.snack.open(`Kayıt portları kaydedilemedi: ${err?.error?.message ?? err.message}`, 'Kapat', { duration: 5000 });
      },
    });
  }
}
