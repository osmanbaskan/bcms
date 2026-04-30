import {
  Component, HostListener, OnDestroy, OnInit, signal, computed, inject,
} from '@angular/core';
import { KeycloakService } from 'keycloak-angular';
import { environment } from '../../../../environments/environment';
import { forkJoin } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';

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
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTabsModule } from '@angular/material/tabs';

import { ScheduleService, ScheduleFilter } from '../../../core/services/schedule.service';
import { ApiService } from '../../../core/services/api.service';
import { LoggerService } from '../../../core/services/logger.service';
import { PERMISSIONS, GROUP } from '@bcms/shared';
import type { Schedule } from '@bcms/shared';
import type { BcmsTokenParsed } from '../../../core/types/auth';

// Canlı Yayın Planlama buton izinleri

function hasGroup(userGroups: string[], required: string[]): boolean {
  if (userGroups.includes(GROUP.Admin)) return true;
  return required.length === 0 || required.some((g) => userGroups.includes(g));
}

interface Channel { id: number; name: string; type: string; }

interface FixtureCompetition { id: string; name: string; season: string; }

interface OptaFixture {
  matchId:         string;
  competitionId:   string;
  competitionName: string;
  season:          string;
  homeTeamName:    string;
  awayTeamName:    string;
  matchDate:       string;
  weekNumber:      number | null;
  label:           string;
}

interface MatchFormData {
  homeTeamName: string;
  awayTeamName: string;
  channelId:   number | null;
  language:    string;
  transStart:  string;
  transEnd:    string;
  houseNumber: string;
  intField:    string;
  intField2:   string;
  offTube:     string;
  notes:       string;
}

interface LiveDetailField {
  key: string;
  label: string;
  type?: 'text' | 'textarea';
  options?: readonly string[];
  wide?: boolean;
  /** Edit dialog'da düzenlenen alanlar Teknik Detay'da gizlenir
   *  (duplicate UX'i önlemek için). Tek kayıt yeri = Düzenle. */
  editOnly?: boolean;
}

type LiveDetails = Record<string, string>;
const LIVE_PLAN_METADATA = {
  source: 'live-plan',
} as const;

/** TIE dropdown listesi. Edit dialog'da `f.tie` için kullanılır. */
const TIE_OPTIONS: readonly string[] = [
  '1', '2', '3', '4', '5', '6',
  'IRD 48', 'IRD49 RBT1', 'IRD50 RBT2',
  'PLT SPR5', 'PLT SPR6', 'PLT SPR7', 'PLT SPR8',
  'STREAM1 PC', 'STREAM2 PC',
  'TRX SPR14', 'TRX SPR15', 'TRX SPR16', 'TRX SPR17', 'TRX SPR18',
];

/** Demod dropdown listesi. Edit dialog'da `f.demod` için kullanılır. */
const DEMOD_OPTIONS: readonly string[] = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'];

/** Sanal kaynak slot listesi. Edit dialog'da `f.virtualResource` için. */
const SANAL_OPTIONS: readonly string[] = ['1', '2'];

/** Int / Int 2 dropdown havuzu. Toplam: 46 öğe.
 *  1..12 + AGENT 1..10 + HYRID 1..2 + IP 1..16 + ISDN 1..5 + TEKYON 3.
 *  Add ve Edit dialog'larında ortak liste olarak kullanılır. */
const INT_OPTIONS: readonly string[] = [
  ...Array.from({ length: 12 }, (_, i) => String(i + 1)),
  ...Array.from({ length: 10 }, (_, i) => `AGENT - ${i + 1}`),
  'HYRID - 1', 'HYRID - 2',
  ...Array.from({ length: 16 }, (_, i) => `IP - ${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `ISDN - ${i + 1}`),
  'TEKYON - 3',
];

/** Yeni standart kaynak listesi — tabloda IRD/Fiber sütunlarında alt alta gösterilen
 *  3 IRD slot + 2 Fiber slot için ortak dropdown havuzu. Tek tutarlı format
 *  (`<KAYNAK> - <N>`). Eski IRD_OPTIONS yedek kaynak alanları için (backupIrd vb.)
 *  korunur. Toplam: 90 öğe. */
const RESOURCE_OPTIONS: readonly string[] = [
  ...Array.from({ length: 56 }, (_, i) => `IRD - ${i + 1}`),
  ...Array.from({ length: 16 }, (_, i) => `FIBER - ${i + 1}`),
  'GBS - 53', 'GBS - 54', 'GBS - 55', 'GBS - 56',
  'DOHA - 1', 'DOHA - 2',
  '4G - 1', '4G - 2', '4G - 3', '4G - 4',
  'TVU - 1', 'TVU - 2', 'TVU - 3', 'TVU - 4',
  'YILDIZ - 1', 'YILDIZ - 2', 'YILDIZ - 3', 'YILDIZ - 4',
];

/** Defensive UI helper: dropdown'da gösterilecek listeyi hesaplar.
 *  Mevcut değer ana listede yoksa (örn. eski format `Fiber1`, `DOHA 1`) listenin
 *  başına geçici option olarak eklenir — kullanıcı dokunmadığı sürece korunur,
 *  yeni listeden seçim yaparsa değer doğal olarak yeni formata geçer.
 *  Migration yapılmaz; eski/yeni format aynı anda yaşar. */
function optionsWithCurrent(current: string, base: readonly string[]): readonly string[] {
  const trimmed = current.trim();
  if (!trimmed || base.includes(trimmed)) return base;
  return [trimmed, ...base];
}

const LIVE_DETAIL_GROUPS: { title: string; fields: LiveDetailField[] }[] = [
  {
    title: 'Yayın / OB',
    fields: [
      { key: 'broadcastLocation', label: 'Yayın Yeri' },
      { key: 'obVanCompany', label: 'Obvan Firma' },
      { key: 'generatorCompany', label: 'Jeneratör Firma' },
      { key: 'jimmyJib', label: 'Jimmy Jib' },
      { key: 'steadicam', label: 'Stedicam' },
      { key: 'sngCompany', label: 'Sng Firma' },
      { key: 'carrierCompany', label: 'Taşıyıcı Firma' },
      { key: 'ibm', label: 'Ibm' },
      { key: 'usageLocation', label: 'Kullanım Yeri' },
      { key: 'fixedPhone1', label: 'Sabit Tel 1' },
      { key: 'secondObVan', label: '2. Obvan' },
      { key: 'region', label: 'Bölge' },
      { key: 'cameraCount', label: 'Kamera Adedi' },
      { key: 'fixedPhone2', label: 'Sabit Tel 2' },
    ],
  },
  {
    title: 'Ana Feed / Transmisyon',
    fields: [
      { key: 'feedType', label: 'Feed Type', options: ['4,5G', 'DVB S', 'DVB S2', 'DVB S2 - 8PSK', 'DVB S2 QPSK', 'DVBS2 + NS3', 'DVBS-2 + NS4', 'DVB-S2X', 'FTP', 'IP Stream', 'NS3', 'NS3 + NS4', 'NS4', 'NS4 + NS4', 'Quicklink', 'Skype', 'Youtube', 'Zoom'] },
      { key: 'satelliteName', label: 'Uydu Adı' },
      { key: 'txp', label: 'TXP' },
      { key: 'satChannel', label: 'Sat Chl' },
      { key: 'uplinkFrequency', label: 'Uplink Frekansı' },
      { key: 'uplinkPolarization', label: 'Up. Polarizasyon', options: ['H', 'V', 'R', 'L'] },
      { key: 'downlinkFrequency', label: 'Downlink Frekansı' },
      { key: 'downlinkPolarization', label: 'Dwn. Polarizasyon', options: ['H', 'V', 'R', 'L'] },
      { key: 'modulationType', label: 'Mod Tipi', editOnly: true, options: ['4,5G', 'DVB S', 'DVB S2', 'DVB S2 - 8PSK', 'DVB S2 QPSK', 'DVBS2 + NS3', 'DVBS-2 + NS4', 'DVB-S2X', 'FTP', 'IP Stream', 'NS3', 'NS3 + NS4', 'NS4', 'NS4 + NS4', 'Quicklink', 'Skype', 'Youtube', 'Zoom'] },
      { key: 'rollOff', label: 'Roll Off', options: ['% 20', '% 25', '% 35'] },
      { key: 'videoCoding', label: 'Video Coding', editOnly: true, options: ['H265 4:2:2', 'Mpeg 4:2:0', 'Mpeg 4:2:2', 'Mpeg 4:2:2-10 bit', 'Mpeg 4:2:2-8'] },
      { key: 'audioConfig', label: 'Audio Config' },
      { key: 'preMatchKey', label: 'Maç Önü Key' },
      { key: 'matchKey', label: 'Maç Key' },
      { key: 'postMatchKey', label: 'Maç Sonu Key' },
      { key: 'isoFeed', label: 'Iso Feed' },
      { key: 'keyType', label: 'Key Tipi', options: ['BISS Mode-1', 'BISS Mode-E', 'Director', 'Unencrypted'] },
      { key: 'symbolRate', label: 'Symbol Rate' },
      { key: 'fecRate', label: 'Fec Rate' },
      { key: 'bandwidth', label: 'Bant Genişliği' },
      { key: 'uplinkFixedPhone', label: 'Sabit Tel 3 (Uplink)' },
    ],
  },
  {
    title: 'Yedek Feed',
    fields: [
      { key: 'backupFeedType', label: 'Feed Type Yedek' },
      { key: 'backupSatelliteName', label: 'Uydu Adı Yedek' },
      { key: 'backupTxp', label: 'TXP Yedek' },
      { key: 'backupSatChannel', label: 'Sat Chl Yedek' },
      { key: 'backupUplinkFrequency', label: 'Uplink Frekansı Yedek' },
      { key: 'backupUplinkPolarization', label: 'Up. Polarizasyon Yedek', options: ['H', 'V', 'R', 'L'] },
      { key: 'backupDownlinkFrequency', label: 'Downlink Frekansı Yedek' },
      { key: 'backupDownlinkPolarization', label: 'Dwn. Polarizasyon Yedek', options: ['H', 'V', 'R', 'L'] },
      { key: 'backupModulationType', label: 'Mod Tipi Yedek' },
      { key: 'backupRollOff', label: 'Roll Off Yedek', options: ['% 20', '% 25', '% 35'] },
      { key: 'backupVideoCoding', label: 'Video Coding Yedek' },
      { key: 'backupAudioConfig', label: 'Audio Config Yedek' },
      { key: 'backupPreMatchKey', label: 'Maç Önü Key Yedek' },
      { key: 'backupMatchKey', label: 'Maç Key Yedek' },
      { key: 'backupPostMatchKey', label: 'Maç Sonu Key Yedek' },
      { key: 'backupKeyType', label: 'Key Tipi Yedek' },
      { key: 'backupSymbolRate', label: 'Symbol Rate Yedek' },
      { key: 'backupFecRate', label: 'Fec Rate Yedek' },
      { key: 'backupBandwidth', label: 'Bant Genişliği Yedek' },
    ],
  },
  {
    title: 'Fiber',
    fields: [
      { key: 'fiberCompany', label: 'Fiber Firma' },
      { key: 'fiberAudioFormat', label: 'Fiber Audio Format' },
      { key: 'fiberVideoFormat', label: 'Fiber Video Format' },
      { key: 'fiberBandwidth', label: 'Fiber Bant Genişliği' },
    ],
  },
];

function createLiveDetails(source?: unknown): LiveDetails {
  const sourceRecord = (source && typeof source === 'object') ? source as Record<string, unknown> : {};
  return LIVE_DETAIL_GROUPS
    .flatMap((group) => group.fields)
    .reduce<LiveDetails>((acc, field) => {
      acc[field.key] = String(sourceRecord[field.key] ?? '');
      return acc;
    }, {});
}

function cleanLiveDetails(details: LiveDetails): LiveDetails | undefined {
  const cleaned = Object.entries(details).reduce<LiveDetails>((acc, [key, value]) => {
    const trimmed = String(value ?? '').trim();
    if (trimmed) acc[key] = trimmed;
    return acc;
  }, {});
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function splitIntField(value: unknown): [string, string] {
  const parts = String(value ?? '').split('/').map((part) => part.trim());
  return [parts[0] ?? '', parts[1] ?? ''];
}

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
  const transEnd = String(schedule.metadata?.['transEnd'] ?? '').trim();
  const transStart = String(schedule.metadata?.['transStart'] ?? '').trim();
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(transEnd);
  if (!timeMatch) return new Date(schedule.endTime);

  const endDate = new Date(schedule.startTime);
  const endHours = Number(timeMatch[1]);
  const endMinutes = Number(timeMatch[2]);
  endDate.setHours(endHours, endMinutes, 0, 0);

  const startMatch = /^(\d{1,2}):(\d{2})$/.exec(transStart);
  if (startMatch) {
    const startHours = Number(startMatch[1]);
    const startMinutes = Number(startMatch[2]);
    if ((endHours * 60 + endMinutes) < (startHours * 60 + startMinutes)) {
      endDate.setDate(endDate.getDate() + 1);
    }
  }

  return endDate;
}

// ── Kayıt Ekle Dialog ─────────────────────────────────────────────────────────
@Component({
  selector: 'app-schedule-add-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ReactiveFormsModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule, MatDialogModule,
    MatProgressSpinnerModule, MatDividerModule,
    MatCheckboxModule, MatTabsModule,
  ],
  template: `
    <h2 mat-dialog-title>Yeni Yayın Kaydı Ekle</h2>
    <mat-dialog-content class="add-dialog-content">
      <div class="dialog-body">
      <mat-tab-group [(selectedIndex)]="activeTab" animationDuration="150ms">

        <!-- ══ Sekme 1: Fikstürden Seç ══════════════════════════════════ -->
        <mat-tab label="Fikstürden Seç">
        <div class="tab-body">

        <div class="step-header">
          <span class="step-num">1</span>
          <span>İçerik Seçimi</span>
        </div>

        <div class="form-row">
          <mat-form-field>
            <mat-label>Lig / Turnuva</mat-label>
            <mat-select [value]="selectedComp()"
                        (selectionChange)="onCompChange($event.value)"
                        [disabled]="compsLoading()"
                        [compareWith]="compById">
              <mat-option [value]="null">— Seçin —</mat-option>
              @for (c of competitions(); track c.id + c.season) {
                <mat-option [value]="c" [style.background]="leagueColor(c.name)" class="league-option">
                  <span class="league-swatch" [style.background]="leagueColor(c.name)"></span>
                  {{ c.name }}
                </mat-option>
              }
            </mat-select>
            @if (compsLoading()) { <mat-hint>Yükleniyor…</mat-hint> }
          </mat-form-field>

          @if (weeks().length > 0) {
            <mat-form-field>
              <mat-label>Hafta</mat-label>
              <mat-select [value]="selectedWeek()"
                          (selectionChange)="onWeekChange($event.value)">
                <mat-option [value]="null">— Tümü —</mat-option>
                @for (w of weeks(); track w) {
                  <mat-option [value]="w">{{ w === -1 ? 'Hafta bilgisi yok' : 'Hafta ' + w }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          }
        </div>

        @if (matchesLoading()) {
          <div class="info-row">
            <mat-spinner diameter="16"></mat-spinner><span>Maçlar yükleniyor…</span>
          </div>
        }
        @if (!matchesLoading() && selectedComp()) {
          @if (teamsLoading()) {
            <div class="info-row">
              <mat-spinner diameter="16"></mat-spinner><span>Takımlar yükleniyor…</span>
            </div>
          } @else if (leagueTeams().length > 0) {
            <div class="team-picker">
              <div class="step-header">
                <span class="step-num">2</span>
                <span>Maç Seç</span>
              </div>
              <div class="form-row tp-row">
                <mat-form-field>
                  <mat-label>Ev Sahibi</mat-label>
                  <mat-select [(ngModel)]="teamPickerHome" [ngModelOptions]="{standalone:true}">
                    <mat-option value="">— Seçin —</mat-option>
                    @for (t of leagueTeams(); track t) {
                      <mat-option [value]="t">{{ t }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
                <mat-form-field>
                  <mat-label>Deplasman</mat-label>
                  <mat-select [(ngModel)]="teamPickerAway" [ngModelOptions]="{standalone:true}">
                    <mat-option value="">— Seçin —</mat-option>
                    @for (t of leagueTeams(); track t) {
                      <mat-option [value]="t">{{ t }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
                <mat-form-field>
                  <mat-label>Tarih</mat-label>
                  <input matInput type="date" [(ngModel)]="teamPickerDate" [ngModelOptions]="{standalone:true}">
                </mat-form-field>
                <mat-form-field>
                  <mat-label>Saat</mat-label>
                  <input matInput type="time" [(ngModel)]="teamPickerTime" [ngModelOptions]="{standalone:true}">
                </mat-form-field>
                <button mat-stroked-button color="primary" class="tp-add-btn"
                        [disabled]="!teamPickerHome || !teamPickerAway || !teamPickerDate"
                        (click)="addVirtualMatch()">
                  <mat-icon>add</mat-icon> Ekle
                </button>
              </div>
            </div>
          } @else if (allMatches().length === 0) {
            <div class="info-row">
              <mat-icon class="info-icon">info</mat-icon>
              <span>Bu lig için planlanmış maç bulunamadı.</span>
            </div>
          }
        }

        @if (filteredMatches().length > 0) {
          <!-- Tümünü seç satırı -->
          <div class="select-all-row">
            <mat-checkbox
              [checked]="allChecked()"
              [indeterminate]="someChecked()"
              (change)="toggleAll($event.checked)">
              Tümünü seç
            </mat-checkbox>
            @if (checkedIds().size > 0) {
              <span class="badge">{{ checkedIds().size }} seçildi</span>
            }
          </div>

          <!-- Maç listesi -->
          <div class="match-list">
            @for (m of filteredMatches(); track m.matchId) {
              <div class="match-item" [class.checked]="checkedIds().has(m.matchId)"
                   [style.background]="fixtureLeagueColor(m)"
                   (click)="toggle(m.matchId)">
                <mat-checkbox [checked]="checkedIds().has(m.matchId)"
                              (click)="$event.stopPropagation()"
                              (change)="toggle(m.matchId)">
                </mat-checkbox>
                <span class="match-label">{{ m.label }}</span>
              </div>
            }
          </div>
        }

        <!-- ── Adım 2: Maç Bazlı Bilgi Girişi (Tablo) ──────────────────── -->
        @if (checkedIds().size > 0) {
          <mat-divider style="margin:12px 0"></mat-divider>

          <div class="step-header">
            <span class="step-num">2</span>
            <span>Maç Bilgileri</span>
          </div>

          <div class="entry-table-wrap">
            <table class="entry-table">
              <thead>
                <tr>
                  <th>Yayın Adı</th>
                  <th>Saat</th>
                  <th>Kanal *</th>
                  <th>Trans. Saati</th>
                  <th>HDVG</th>
                  <th>Int</th>
                  <th>Off Tube</th>
                  <th>Dil</th>
                  <th>Açıklama ve Notlar</th>
                </tr>
              </thead>
              <tbody>
                @for (m of selectedMatches(); track m.matchId) {
                  <tr [style.background]="fixtureLeagueColor(m)">
                    <td class="col-title">
                      <input class="cell-input team-input" [(ngModel)]="getForm(m.matchId).homeTeamName" [ngModelOptions]="{standalone:true}" placeholder="Ev sahibi">
                      <span class="team-sep">-</span>
                      <input class="cell-input team-input" [(ngModel)]="getForm(m.matchId).awayTeamName" [ngModelOptions]="{standalone:true}" placeholder="Deplasman">
                    </td>
                    <td class="col-time">{{ m.matchDate | date:'dd.MM HH:mm' }}</td>
                    <td class="col-channel">
                      <select class="cell-select"
                              [(ngModel)]="getForm(m.matchId).channelId"
                              [ngModelOptions]="{standalone:true}"
                              [class.empty]="!getForm(m.matchId).channelId">
                        <option [ngValue]="null">— Seçin —</option>
                        @for (ch of data.channels; track ch.id) {
                          <option [ngValue]="ch.id">{{ ch.name }}</option>
                        }
                      </select>
                    </td>
                    <td class="col-trans">
                      <input class="cell-input" type="time"
                             [(ngModel)]="getForm(m.matchId).transStart"
                             [ngModelOptions]="{standalone:true}"
                             placeholder="Baş.">
                      <input class="cell-input" type="time"
                             [(ngModel)]="getForm(m.matchId).transEnd"
                             [ngModelOptions]="{standalone:true}"
                             placeholder="Bit.">
                    </td>
                    <td class="col-hdvg">
                      <select class="cell-select"
                              [(ngModel)]="getForm(m.matchId).houseNumber"
                              [ngModelOptions]="{standalone:true}">
                        <option value="">—</option>
                        @for (n of hdvgOptions; track n) {
                          <option [value]="n">{{ n }}</option>
                        }
                      </select>
                    </td>
                    <td class="col-int">
                      <select class="cell-select"
                              [(ngModel)]="getForm(m.matchId).intField"
                              [ngModelOptions]="{standalone:true}">
                        <option value="">—</option>
                        @for (n of intOptions; track n) {
                          <option [value]="n">{{ n }}</option>
                        }
                      </select>
                      <select class="cell-select"
                              [(ngModel)]="getForm(m.matchId).intField2"
                              [ngModelOptions]="{standalone:true}">
                        <option value="">—</option>
                        @for (n of intOptions; track n) {
                          <option [value]="n">{{ n }}</option>
                        }
                      </select>
                    </td>
                    <td><input class="cell-input" [(ngModel)]="getForm(m.matchId).offTube"     [ngModelOptions]="{standalone:true}"></td>
                    <td class="col-lang">
                      <select class="cell-select"
                              [(ngModel)]="getForm(m.matchId).language"
                              [ngModelOptions]="{standalone:true}">
                        <option value="Yok">Yok</option>
                        <option value="TR">TR</option>
                        <option value="Eng">Eng</option>
                        <option value="FR">FR</option>
                        <option value="ES">ES</option>
                      </select>
                    </td>
                    <td><input class="cell-input full" [(ngModel)]="getForm(m.matchId).notes" [ngModelOptions]="{standalone:true}"></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        </div><!-- /tab-body -->
        </mat-tab>

        <!-- ══ Sekme 2: Manuel Giriş ═════════════════════════════════════ -->
        <mat-tab label="Manuel Giriş">
        <div class="tab-body">

          <div class="step-header" style="margin-top:8px">
            <span class="step-num">M</span>
            <span>Manuel İçerik Girişi</span>
          </div>

          <div class="mform-row">
            <mat-form-field class="mf-wide">
              <mat-label>Yayın Adı *</mat-label>
              <input matInput [(ngModel)]="mf.contentName" [ngModelOptions]="{standalone:true}">
            </mat-form-field>
            <mat-form-field>
              <mat-label>Lig</mat-label>
              <input matInput [(ngModel)]="mf.league" [ngModelOptions]="{standalone:true}" placeholder="Premier League…">
            </mat-form-field>
          </div>
          <div class="mform-row">
            <mat-form-field>
              <mat-label>Kanal *</mat-label>
              <mat-select [(ngModel)]="mf.channelId" [ngModelOptions]="{standalone:true}">
                @for (ch of data.channels; track ch.id) {
                  <mat-option [value]="ch.id">{{ ch.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field>
              <mat-label>Tarih *</mat-label>
              <input matInput type="date" [(ngModel)]="mf.date" [ngModelOptions]="{standalone:true}">
            </mat-form-field>
            <mat-form-field>
              <mat-label>Başlangıç *</mat-label>
              <input matInput type="time" [(ngModel)]="mf.startTime" [ngModelOptions]="{standalone:true}">
            </mat-form-field>
            <mat-form-field>
              <mat-label>Bitiş *</mat-label>
              <input matInput type="time" [(ngModel)]="mf.endTime" [ngModelOptions]="{standalone:true}">
            </mat-form-field>
          </div>
          <div class="mform-row">
            <mat-form-field>
              <mat-label>Trans. Başlangıç</mat-label>
              <input matInput type="time" [(ngModel)]="mf.transStart" [ngModelOptions]="{standalone:true}">
            </mat-form-field>
            <mat-form-field>
              <mat-label>Trans. Bitiş</mat-label>
              <input matInput type="time" [(ngModel)]="mf.transEnd" [ngModelOptions]="{standalone:true}">
            </mat-form-field>
            <mat-form-field>
              <mat-label>HDVG</mat-label>
              <mat-select [(ngModel)]="mf.houseNumber" [ngModelOptions]="{standalone:true}">
                <mat-option value="">—</mat-option>
                @for (n of hdvgOptions; track n) {
                  <mat-option [value]="n">{{ n }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field>
              <mat-label>Int</mat-label>
              <mat-select [(ngModel)]="mf.intField" [ngModelOptions]="{standalone:true}">
                <mat-option value="">—</mat-option>
                @for (n of intOptions; track n) {
                  <mat-option [value]="n">{{ n }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field>
              <mat-label>Int 2</mat-label>
              <mat-select [(ngModel)]="mf.intField2" [ngModelOptions]="{standalone:true}">
                <mat-option value="">—</mat-option>
                @for (n of intOptions; track n) {
                  <mat-option [value]="n">{{ n }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field>
              <mat-label>Off Tube</mat-label>
              <input matInput [(ngModel)]="mf.offTube" [ngModelOptions]="{standalone:true}">
            </mat-form-field>
          </div>
          <div class="mform-row">
            <mat-form-field>
              <mat-label>Dil</mat-label>
              <mat-select [(ngModel)]="mf.language" [ngModelOptions]="{standalone:true}">
                <mat-option value="Yok">Yok</mat-option>
                <mat-option value="TR">Türkçe</mat-option>
                <mat-option value="Eng">İngilizce</mat-option>
                <mat-option value="FR">Fransızca</mat-option>
                <mat-option value="ES">İspanyolca</mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field class="mf-wide">
              <mat-label>Açıklama ve Notlar</mat-label>
              <textarea matInput rows="2" [(ngModel)]="mf.notes" [ngModelOptions]="{standalone:true}"></textarea>
            </mat-form-field>
          </div>

        </div><!-- /tab-body -->
        </mat-tab>

      </mat-tab-group>

      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>İptal</button>
      <button mat-raised-button color="primary"
              [disabled]="!canSaveActive() || saving()"
              (click)="saveActive()">
        @if (saving()) {
          <mat-spinner diameter="16" style="display:inline-block;margin-right:6px"></mat-spinner>
          Kaydediliyor…
        } @else {
          {{ saveButtonLabel() }}
        }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    :host {
      display:flex;
      flex-direction:column;
      height:100%;
      min-height:0;
    }
    h2[mat-dialog-title] { flex:0 0 auto; }
    .add-dialog-content {
      flex:1 1 auto;
      max-height:none;
      overflow:auto;
      min-height:0;
    }
    mat-dialog-actions { flex:0 0 auto; }
    .dialog-body { min-width: 700px; }

    .form-row { display:flex; gap:12px; margin-bottom:4px; }
    .form-row mat-form-field { flex:1; }

    .step-header {
      display:flex; align-items:center; gap:8px;
      font-weight:500; font-size:13px; margin:4px 0 10px;
    }
    .step-num {
      display:inline-flex; align-items:center; justify-content:center;
      width:20px; height:20px; border-radius:50%;
      background:#1976d2; color:#fff; font-size:11px; font-weight:700; flex-shrink:0;
    }

    .info-row  { display:flex; align-items:center; gap:6px; color:#888; font-size:12px; margin-bottom:8px; }
    .info-icon { font-size:16px; height:16px; width:16px; }
    .league-option { color:#fff; }
    .league-swatch {
      display:inline-block; width:10px; height:10px; border-radius:2px;
      margin-right:8px; border:1px solid rgba(255,255,255,.45);
      vertical-align:-1px;
    }

    .select-all-row { display:flex; align-items:center; gap:12px; padding:4px 8px; margin-bottom:4px; }
    .badge { background:#1976d2; color:#fff; border-radius:10px; padding:1px 8px; font-size:11px; }

    .match-list { max-height:min(42vh, 360px); overflow-y:auto; border:1px solid #333; border-radius:4px; margin-bottom:8px; }
    .match-item {
      display:flex; align-items:center; gap:10px;
      padding:6px 10px; cursor:pointer; transition:filter .15s, box-shadow .15s;
    }
    .match-item:hover   { filter:brightness(1.12); }
    .match-item.checked { box-shadow:inset 3px 0 0 #90caf9; }
    .match-label { font-size:13px; }

    /* ── Entry table ── */
    .entry-table-wrap { overflow-x:auto; }
    .entry-table {
      width:100%; border-collapse:collapse; font-size:12px;
    }
    .entry-table thead tr {
      background:#b71c1c; color:#fff;
    }
    .entry-table th {
      padding:6px 8px; text-align:left; font-weight:600;
      white-space:nowrap; border-right:1px solid rgba(255,255,255,.15);
    }
    .entry-table tbody tr { border-bottom:1px solid #333; }
    .entry-table tbody tr:hover { filter:brightness(1.12); }
    .entry-table td { padding:4px 6px; vertical-align:middle; }

    .cell-input {
      background:transparent; border:none; border-bottom:1px solid #555;
      color:inherit; font-size:12px; width:100%; outline:none; padding:2px 4px;
      min-width:60px;
    }
    .cell-input:focus { border-bottom-color:#90caf9; }
    .cell-input.full  { min-width:140px; }
    .cell-select {
      background:#1e1e1e; border:1px solid #555; color:inherit;
      font-size:12px; padding:2px 4px; border-radius:3px; width:100%; outline:none;
    }
    .cell-select.empty { color:#888; }
    .cell-select:focus { border-color:#90caf9; }

    .col-title   { min-width:200px; font-weight:500; }
    .team-input  { min-width:80px; width:calc(50% - 10px); }
    .team-sep    { margin:0 4px; color:#888; }
    .col-time    { white-space:nowrap; color:#aaa; }
    .col-channel { min-width:120px; }
    .col-trans   { min-width:150px; display:table-cell; }
    .col-trans input { display:block; margin-bottom:2px; }
    .col-int     { min-width:86px; }
    .col-int select { display:block; margin-bottom:2px; }
    .col-lang    { min-width:70px; }

    /* ── Team picker ── */
    .team-picker { margin-bottom: 8px; }
    .tp-row { align-items: center; flex-wrap: wrap; }
    .tp-row mat-form-field { flex: 1; min-width: 130px; }
    .tp-add-btn { flex-shrink: 0; height: 40px; margin-top: 4px; }

    /* ── Tab body ── */
    .tab-body { padding: 12px 0 4px; }

    /* ── Manuel form ── */
    .mform-row { display:flex; gap:12px; margin-bottom:2px; flex-wrap:wrap; }
    .mform-row mat-form-field { flex:1; min-width:130px; }
    .mf-wide { flex:2 !important; }
    .technical-tab { padding-bottom:16px; }
    .technical-section {
      border:1px solid rgba(255,255,255,.12);
      border-radius:6px;
      padding:10px 12px 0;
      margin-bottom:12px;
    }
    .technical-section h3 {
      font-size:13px;
      font-weight:700;
      margin:0 0 10px;
      color:#90caf9;
    }
    .technical-grid {
      display:grid;
      grid-template-columns:repeat(4, minmax(150px, 1fr));
      gap:8px 12px;
      align-items:start;
    }
    .technical-grid mat-form-field { min-width:0; }
    .tech-wide { grid-column:span 2; }
  `],
})
export class ScheduleAddDialogComponent {
  data      = inject<{ channels: Channel[] }>(MAT_DIALOG_DATA);
  dialogRef = inject(MatDialogRef<ScheduleAddDialogComponent>);
  api       = inject(ApiService);
  logger    = inject(LoggerService);
  saving    = signal(false);
  activeTab = 0;

  // Manuel form verisi
  mf = {
    contentName: '', league: '', channelId: null as number | null,
    date: new Date().toISOString().slice(0, 10),
    startTime: '', endTime: '', transStart: '', transEnd: '',
    houseNumber: '', intField: '', intField2: '', offTube: '', language: 'Yok', notes: '',
  };

  canSaveManual = () => !!(this.mf.contentName && this.mf.channelId && this.mf.date && this.mf.startTime && this.mf.endTime);

  // Fikstür sinyalleri
  competitions      = signal<FixtureCompetition[]>([]);
  compsLoading      = signal(false);
  selectedComp      = signal<FixtureCompetition | null>(null);
  allMatches        = signal<OptaFixture[]>([]);
  matchesLoading    = signal(false);
  weeks             = signal<number[]>([]);
  selectedWeek      = signal<number | null>(null);
  checkedIds        = signal<Set<string>>(new Set());

  leagueTeams   = signal<string[]>([]);
  teamsLoading  = signal(false);
  teamPickerHome = '';
  teamPickerAway = '';
  teamPickerDate = new Date().toISOString().slice(0, 10);
  teamPickerTime = '20:00';

  filteredMatches = (): OptaFixture[] => {
    const w = this.selectedWeek();
    if (w === null) return this.allMatches();
    if (w === -1)   return this.allMatches().filter((m) => m.weekNumber == null);
    return this.allMatches().filter((m) => m.weekNumber === w);
  };

  allChecked      = () => this.filteredMatches().length > 0 && this.filteredMatches().every((m) => this.checkedIds().has(m.matchId));
  someChecked     = () => this.filteredMatches().some((m) => this.checkedIds().has(m.matchId));
  selectedMatches = () => this.allMatches().filter((m) => this.checkedIds().has(m.matchId));
  canSave         = () => this.checkedIds().size > 0;

  readonly hdvgOptions = Array.from({ length: 15 }, (_, i) => String(i + 1));
  readonly intOptions: readonly string[] = INT_OPTIONS;
  compById = (a: FixtureCompetition | null, b: FixtureCompetition | null) =>
    a?.id === b?.id && a?.season === b?.season;

  canSaveActive = () => {
    if (this.activeTab === 0) return this.canSave();
    return this.canSaveManual();
  };

  saveButtonLabel() {
    if (this.activeTab === 0) return `Kaydet (${this.checkedIds().size})`;
    return 'Kaydet';
  }

  saveActive() {
    if (this.activeTab === 0) {
      this.save();
    } else {
      this.saveManual();
    }
  }

  leagueColor(name: unknown) {
    return leagueBackground(name);
  }

  fixtureLeagueColor(match: OptaFixture) {
    return leagueBackground(match.competitionName);
  }

  // Her maç için ayrı form verisi (plain Map — save anında okunur)
  private matchForms = new Map<string, MatchFormData>();

  getForm(id: string): MatchFormData {
    if (!this.matchForms.has(id)) {
      const match = this.allMatches().find((m) => m.matchId === id);
      this.matchForms.set(id, { homeTeamName: match?.homeTeamName ?? '', awayTeamName: match?.awayTeamName ?? '', channelId: null, language: 'Yok', transStart: '', transEnd: '', houseNumber: '', intField: '', intField2: '', offTube: '', notes: '' });
    }
    return this.matchForms.get(id)!;
  }

  constructor() {
    this.compsLoading.set(true);
    this.api.get<FixtureCompetition[]>('/opta/fixture-competitions').subscribe({
      next:  (c) => { this.competitions.set(c); this.compsLoading.set(false); },
      error: ()  => { this.compsLoading.set(false); },
    });
  }

  onCompChange(comp: FixtureCompetition | null) {
    this.selectedComp.set(comp);
    this.allMatches.set([]);
    this.weeks.set([]);
    this.selectedWeek.set(null);
    this.checkedIds.set(new Set());
    this.leagueTeams.set([]);
    this.teamPickerHome = '';
    this.teamPickerAway = '';
    if (!comp) return;

    this.matchesLoading.set(true);
    const from = encodeURIComponent(new Date().toISOString());
    this.api.get<OptaFixture[]>(`/opta/fixtures?competitionId=${comp.id}&season=${comp.season}&from=${from}`).subscribe({
      next: (ms) => {
        this.allMatches.set(ms);
        const wSet  = new Set(ms.map((m) => m.weekNumber ?? -1));
        const wList = [...wSet].sort((a, b) => a - b);
        this.weeks.set(wList.length > 1 ? wList : []);
        this.matchesLoading.set(false);
        if (ms.length === 0) {
          this.teamsLoading.set(true);
          this.api.get<{ teams: string[] }>(`/opta/league-teams?competitionId=${comp.id}`).subscribe({
            next:  (r) => { this.leagueTeams.set(r.teams); this.teamsLoading.set(false); },
            error: ()  => { this.teamsLoading.set(false); },
          });
        }
      },
      error: () => { this.matchesLoading.set(false); },
    });
  }

  addVirtualMatch() {
    const comp = this.selectedComp()!;
    const dt = new Date(`${this.teamPickerDate}T${this.teamPickerTime || '00:00'}:00`);
    const matchId = `virtual-${Date.now()}`;
    const fixture: OptaFixture = {
      matchId,
      competitionId:   comp.id,
      competitionName: comp.name,
      season:          comp.season,
      homeTeamName:    this.teamPickerHome,
      awayTeamName:    this.teamPickerAway,
      matchDate:       dt.toISOString(),
      weekNumber:      null,
      label:           `${this.teamPickerHome} - ${this.teamPickerAway} (${dt.toLocaleDateString('tr-TR')})`,
    };
    this.allMatches.update((ms) => [...ms, fixture]);
    this.toggle(matchId);
    this.teamPickerHome = '';
    this.teamPickerAway = '';
  }

  onWeekChange(week: number | null) {
    this.selectedWeek.set(week);
    this.checkedIds.set(new Set());
  }

  toggle(id: string) {
    const s = new Set(this.checkedIds());
    if (s.has(id)) {
      s.delete(id);
    } else {
      s.add(id);
      this.initForm(id);
    }
    this.checkedIds.set(s);
  }

  toggleAll(checked: boolean) {
    if (checked) {
      this.filteredMatches().forEach((m) => this.initForm(m.matchId));
      this.checkedIds.set(new Set(this.filteredMatches().map((m) => m.matchId)));
    } else {
      this.checkedIds.set(new Set());
    }
  }

  private initForm(id: string) {
    if (this.matchForms.has(id)) return;
    const match = this.allMatches().find((m) => m.matchId === id);
    const dt = match ? new Date(match.matchDate) : new Date();
    const transStartDt = new Date(dt.getTime() - 60 * 60 * 1000);
    const transEndDt   = new Date(dt.getTime() + 3 * 60 * 60 * 1000);
    this.matchForms.set(id, {
      homeTeamName: match?.homeTeamName ?? '',
      awayTeamName: match?.awayTeamName ?? '',
      channelId:   null,
      language:    'Yok',
      transStart:  `${pad(transStartDt.getHours())}:${pad(transStartDt.getMinutes())}`,
      transEnd:    `${pad(transEndDt.getHours())}:${pad(transEndDt.getMinutes())}`,
      houseNumber: '',
      intField:    '',
      intField2:   '',
      offTube:     '',
      notes:       '',
    });
  }

  save() {
    if (!this.canSave()) return;
    // Teknik detay (liveDetails) burada yazılmaz — içeriğe özgü olduğu için
    // kayıt sonrası Düzenle / Teknik Detay dialog'larından doldurulur.
    const requests = this.selectedMatches().map((m) => {
      const f  = this.getForm(m.matchId);
      const dt = new Date(m.matchDate);
      const title = `${f.homeTeamName || m.homeTeamName} - ${f.awayTeamName || m.awayTeamName}`;
      return this.api.post<Schedule>('/schedules', {
        channelId: f.channelId,
        startTime: dt.toISOString(),
        endTime:   new Date(dt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        title,
        usageScope: 'live-plan',
        metadata: {
          ...LIVE_PLAN_METADATA,
          contentName:  title,
          league:       m.competitionName || undefined,
          season:       m.season          || undefined,
          weekNumber:   m.weekNumber      ?? undefined,
          language:     f.language    || 'Yok',
          transStart:   f.transStart  || undefined,
          transEnd:     f.transEnd    || undefined,
          houseNumber:  f.houseNumber || undefined,
          intField:     f.intField || undefined,
          intField2:    f.intField2 || undefined,
          offTube:      f.offTube     || undefined,
          description:  f.notes      || undefined,
          optaMatchId:  m.matchId,
        },
      });
    });

    this.saving.set(true);
    forkJoin(requests).subscribe({
      next:  (saved) => { this.saving.set(false); this.dialogRef.close(saved); },
      error: (e)     => { this.saving.set(false); this.logger.error("Schedule save failed", e); },
    });
  }

  saveManual() {
    if (!this.canSaveManual()) return;
    const f = this.mf;
    const toISO = (t: string) => new Date(`${f.date}T${t}${environment.utcOffset}`).toISOString();
    // Teknik detay burada yazılmaz — içeriğe özgü olduğu için sonradan
    // Düzenle / Teknik Detay dialog'larından doldurulur.
    this.saving.set(true);
    this.api.post<Schedule>('/schedules', {
      channelId: f.channelId!,
      startTime: toISO(f.startTime),
      endTime:   toISO(f.endTime),
      title:     f.contentName,
      usageScope: 'live-plan',
      metadata: {
        ...LIVE_PLAN_METADATA,
        contentName:  f.contentName,
        league:       f.league      || undefined,
        language:     f.language    || 'Yok',
        transStart:   f.transStart  || undefined,
        transEnd:     f.transEnd    || undefined,
        houseNumber:  f.houseNumber || undefined,
        intField:     f.intField || undefined,
        intField2:    f.intField2 || undefined,
        offTube:      f.offTube     || undefined,
        description:  f.notes      || undefined,
      },
    }).subscribe({
      next:  (s) => { this.saving.set(false); this.dialogRef.close(s); },
      error: (e) => { this.saving.set(false); this.logger.error("Schedule save failed", e); },
    });
  }
}

function pad(n: number) { return String(n).padStart(2, '0'); }

// ── Düzenle Dialog ────────────────────────────────────────────────────────────
@Component({
  selector: 'app-schedule-edit-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule, MatDialogModule,
    MatProgressSpinnerModule, MatDividerModule,
  ],
  template: `
    <h2 mat-dialog-title>Kaydı Düzenle</h2>
    <mat-dialog-content>
      <div class="edit-body">
        <div class="eform-row">
          <mat-form-field class="ef-wide">
            <mat-label>Yayın Adı *</mat-label>
            <input matInput [(ngModel)]="f.contentName" [ngModelOptions]="{standalone:true}">
          </mat-form-field>
          <mat-form-field>
            <mat-label>Lig</mat-label>
            <input matInput [(ngModel)]="f.league" [ngModelOptions]="{standalone:true}">
          </mat-form-field>
        </div>
        <div class="eform-row">
          <mat-form-field>
            <mat-label>Kanal *</mat-label>
            <mat-select [(ngModel)]="f.channelId" [ngModelOptions]="{standalone:true}">
              @for (ch of data.channels; track ch.id) {
                <mat-option [value]="ch.id">{{ ch.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Tarih *</mat-label>
            <input matInput type="date" [(ngModel)]="f.date" [ngModelOptions]="{standalone:true}">
          </mat-form-field>
          <mat-form-field>
            <mat-label>Başlangıç *</mat-label>
            <input matInput type="time" [(ngModel)]="f.startTime" [ngModelOptions]="{standalone:true}">
          </mat-form-field>
          <mat-form-field>
            <mat-label>Bitiş *</mat-label>
            <input matInput type="time" [(ngModel)]="f.endTime" [ngModelOptions]="{standalone:true}">
          </mat-form-field>
        </div>
        <div class="eform-row">
          <mat-form-field>
            <mat-label>Trans. Başlangıç</mat-label>
            <input matInput type="time" [(ngModel)]="f.transStart" [ngModelOptions]="{standalone:true}">
          </mat-form-field>
          <mat-form-field>
            <mat-label>Trans. Bitiş</mat-label>
            <input matInput type="time" [(ngModel)]="f.transEnd" [ngModelOptions]="{standalone:true}">
          </mat-form-field>
          <mat-form-field>
            <mat-label>HDVG</mat-label>
            <mat-select [(ngModel)]="f.houseNumber" [ngModelOptions]="{standalone:true}">
              <mat-option value="">—</mat-option>
              @for (n of hdvgOptions; track n) {
                <mat-option [value]="n">{{ n }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Int</mat-label>
            <mat-select [(ngModel)]="f.intField" [ngModelOptions]="{standalone:true}">
              <mat-option value="">—</mat-option>
              @for (n of intOptions1; track n) {
                <mat-option [value]="n">{{ n }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Int 2</mat-label>
            <mat-select [(ngModel)]="f.intField2" [ngModelOptions]="{standalone:true}">
              <mat-option value="">—</mat-option>
              @for (n of intOptions2; track n) {
                <mat-option [value]="n">{{ n }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Off Tube</mat-label>
            <input matInput [(ngModel)]="f.offTube" [ngModelOptions]="{standalone:true}">
          </mat-form-field>
        </div>
        <div class="eform-row">
          <mat-form-field>
            <mat-label>Dil</mat-label>
            <mat-select [(ngModel)]="f.language" [ngModelOptions]="{standalone:true}">
              <mat-option value="Yok">Yok</mat-option>
              <mat-option value="TR">Türkçe</mat-option>
              <mat-option value="Eng">İngilizce</mat-option>
              <mat-option value="FR">Fransızca</mat-option>
              <mat-option value="ES">İspanyolca</mat-option>
            </mat-select>
          </mat-form-field>
        </div>

        <!-- Tahta / Kaynak alanları — tabloda görünen teknik kolonlar.
             Aynı veriler Teknik Detay dialog'unda da düzenlenebilir;
             her iki dialog metadata.liveDetails altına yazar. -->
        <div class="eform-section-title">Tahta / Kaynak (Tablo Kolonları)</div>
        <div class="eform-row">
          <mat-form-field>
            <mat-label>Mod Tipi</mat-label>
            <mat-select [(ngModel)]="f.modulationType" [ngModelOptions]="{standalone:true}">
              <mat-option value="">—</mat-option>
              @for (opt of modOptions; track opt) {
                <mat-option [value]="opt">{{ opt }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Coding Tipi</mat-label>
            <mat-select [(ngModel)]="f.videoCoding" [ngModelOptions]="{standalone:true}">
              <mat-option value="">—</mat-option>
              @for (opt of codingOptions; track opt) {
                <mat-option [value]="opt">{{ opt }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Demod</mat-label>
            <mat-select [(ngModel)]="f.demod" [ngModelOptions]="{standalone:true}">
              <mat-option value="">—</mat-option>
              @for (opt of demodOptions; track opt) {
                <mat-option [value]="opt">{{ opt }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>

        <!-- IRD slotları (3 adet, yan yana tek satır). Slot 1 = liveDetails.ird,
             Slot 2 = liveDetails.ird2 (yeni), Slot 3 = liveDetails.ird3.
             Slot 1 ve 3 Teknik Detay ile paylaşılır. -->
        <div class="eform-row">
          <mat-form-field>
            <mat-label>IRD 1</mat-label>
            <mat-select [(ngModel)]="f.ird1" [ngModelOptions]="{standalone:true}">
              <mat-option value="">—</mat-option>
              @for (opt of ird1Options; track opt) {
                <mat-option [value]="opt">{{ opt }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>IRD 2</mat-label>
            <mat-select [(ngModel)]="f.ird2" [ngModelOptions]="{standalone:true}">
              <mat-option value="">—</mat-option>
              @for (opt of ird2Options; track opt) {
                <mat-option [value]="opt">{{ opt }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>IRD 3</mat-label>
            <mat-select [(ngModel)]="f.ird3" [ngModelOptions]="{standalone:true}">
              <mat-option value="">—</mat-option>
              @for (opt of ird3Options; track opt) {
                <mat-option [value]="opt">{{ opt }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>

        <!-- Fiber slotları (2 adet, yan yana tek satır). Slot 1 = liveDetails.fiberResource,
             Slot 2 = liveDetails.fiberResource2 (yeni). Slot 1 Teknik Detay ile paylaşılır. -->
        <div class="eform-row">
          <mat-form-field>
            <mat-label>Fiber 1</mat-label>
            <mat-select [(ngModel)]="f.fiber1" [ngModelOptions]="{standalone:true}">
              <mat-option value="">—</mat-option>
              @for (opt of fiber1Options; track opt) {
                <mat-option [value]="opt">{{ opt }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Fiber 2</mat-label>
            <mat-select [(ngModel)]="f.fiber2" [ngModelOptions]="{standalone:true}">
              <mat-option value="">—</mat-option>
              @for (opt of fiber2Options; track opt) {
                <mat-option [value]="opt">{{ opt }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>

        <div class="eform-row">
          <mat-form-field>
            <mat-label>TIE</mat-label>
            <mat-select [(ngModel)]="f.tie" [ngModelOptions]="{standalone:true}">
              <mat-option value="">—</mat-option>
              @for (opt of tieOptions; track opt) {
                <mat-option [value]="opt">{{ opt }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Sanal</mat-label>
            <mat-select [(ngModel)]="f.virtualResource" [ngModelOptions]="{standalone:true}">
              <mat-option value="">—</mat-option>
              @for (opt of sanalOptions; track opt) {
                <mat-option [value]="opt">{{ opt }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>

        <div class="eform-row">
          <mat-form-field class="ef-wide">
            <mat-label>Açıklama ve Notlar</mat-label>
            <textarea matInput rows="2" [(ngModel)]="f.notes" [ngModelOptions]="{standalone:true}"></textarea>
          </mat-form-field>
        </div>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>İptal</button>
      <button mat-raised-button color="primary"
              [disabled]="!canSave() || saving()"
              (click)="save()">
        @if (saving()) {
          <mat-spinner diameter="16" style="display:inline-block;margin-right:6px"></mat-spinner>
          Kaydediliyor…
        } @else {
          Kaydet
        }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .edit-body { min-width: 0; }
    mat-dialog-content { max-height: 78vh; }
    .eform-row { display:flex; gap:12px; margin-bottom:4px; flex-wrap:wrap; }
    .eform-row mat-form-field { flex:1; min-width:120px; }
    .ef-wide { flex:2 !important; }
    .eform-section-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #90caf9;
      margin: 12px 0 6px;
      border-top: 1px solid rgba(255,255,255,0.12);
      padding-top: 10px;
    }
  `],
})
export class ScheduleEditDialogComponent {
  data      = inject<{ schedule: Schedule & { channel?: { id: number; name: string } }; channels: Channel[] }>(MAT_DIALOG_DATA);
  dialogRef = inject(MatDialogRef<ScheduleEditDialogComponent>);
  api       = inject(ApiService);
  logger    = inject(LoggerService);
  saving    = signal(false);

  readonly hdvgOptions = Array.from({ length: 15 }, (_, i) => String(i + 1));

  // Tahta/Kaynak alan options'ları LIVE_DETAIL_GROUPS'tan tek noktada okunur
  // (Teknik Detay dialog'la eşleşik). Bu sayede enum değişiminde iki dialog
  // birlikte güncellenir.
  private static fieldOptions(key: string): readonly string[] | undefined {
    return LIVE_DETAIL_GROUPS
      .flatMap((g) => g.fields)
      .find((f) => f.key === key)?.options;
  }
  readonly modOptions     = ScheduleEditDialogComponent.fieldOptions('modulationType') ?? [];
  readonly codingOptions  = ScheduleEditDialogComponent.fieldOptions('videoCoding')    ?? [];
  readonly demodOptions   = DEMOD_OPTIONS;

  // Defensive sticky options — constructor'da hesaplanır, dropdown açıldığında
  // mevcut eski format değer (varsa) listenin başında görünür kalır.
  // Migration yapılmaz; kullanıcı yeni listeden seçim yaparsa değer doğal
  // olarak yeni formata geçer.
  readonly ird1Options:   readonly string[];
  readonly ird2Options:   readonly string[];
  readonly ird3Options:   readonly string[];
  readonly fiber1Options: readonly string[];
  readonly fiber2Options: readonly string[];
  readonly intOptions1:   readonly string[];
  readonly intOptions2:   readonly string[];
  readonly tieOptions:    readonly string[];
  readonly sanalOptions:  readonly string[];

  f: {
    contentName: string; league: string; channelId: number | null;
    date: string; startTime: string; endTime: string;
    transStart: string; transEnd: string; houseNumber: string;
    intField: string; intField2: string; offTube: string; language: string; notes: string;
    modulationType: string; videoCoding: string; demod: string;
    tie: string; virtualResource: string;
    // IRD slotları (slot 1 = ird, slot 2 = ird2, slot 3 = ird3)
    // Slot 1 ve slot 3 Teknik Detay ile paylaşılır; slot 2 yeni anahtar.
    ird1: string; ird2: string; ird3: string;
    // Fiber slotları (slot 1 = fiberResource, slot 2 = fiberResource2)
    // Slot 1 Teknik Detay ile paylaşılır; slot 2 yeni anahtar.
    fiber1: string; fiber2: string;
  };

  constructor() {
    const s   = this.data.schedule;
    const m   = (s.metadata ?? {}) as Record<string, unknown>;
    const ld  = (m['liveDetails'] ?? {}) as Record<string, unknown>;
    const st  = new Date(s.startTime);
    const et  = new Date(s.endTime);
    const [intField, intField2] = splitIntField(m['intField']);

    this.f = {
      contentName: String(m['contentName'] || s.title || ''),
      league:      String(m['league']      || ''),
      channelId:   s.channel?.id ?? null,
      date:        st.toLocaleDateString('sv-SE', { timeZone: environment.timezone }),
      startTime:   `${pad(st.getHours())}:${pad(st.getMinutes())}`,
      endTime:     `${pad(et.getHours())}:${pad(et.getMinutes())}`,
      transStart:  String(m['transStart']  || ''),
      transEnd:    String(m['transEnd']    || ''),
      houseNumber: String(m['houseNumber'] || ''),
      intField,
      intField2:   String(m['intField2'] || intField2 || ''),
      offTube:     String(m['offTube']     || ''),
      language:    String(m['language']    || 'Yok'),
      notes:       String(m['description'] || ''),
      modulationType:  String(ld['modulationType']  || ''),
      videoCoding:     String(ld['videoCoding']     || ''),
      demod:           String(ld['demod']           || ''),
      tie:             String(ld['tie']             || ''),
      virtualResource: String(ld['virtualResource'] || ''),
      ird1:            String(ld['ird']             || ''),
      ird2:            String(ld['ird2']            || ''),
      ird3:            String(ld['ird3']            || ''),
      fiber1:          String(ld['fiberResource']   || ''),
      fiber2:          String(ld['fiberResource2']  || ''),
    };

    // Sticky defensive options — kayıt açıldığında hesaplanır; eski format
    // değerler dropdown başında görünür.
    this.ird1Options   = optionsWithCurrent(this.f.ird1,   RESOURCE_OPTIONS);
    this.ird2Options   = optionsWithCurrent(this.f.ird2,   RESOURCE_OPTIONS);
    this.ird3Options   = optionsWithCurrent(this.f.ird3,   RESOURCE_OPTIONS);
    this.fiber1Options = optionsWithCurrent(this.f.fiber1, RESOURCE_OPTIONS);
    this.fiber2Options = optionsWithCurrent(this.f.fiber2, RESOURCE_OPTIONS);
    // Int dropdown'ları için defensive — eski "01"-"12" pad'li değerler
    // yeni "1"-"12" formatında, eski kayıtlar listede görünür kalır.
    this.intOptions1   = optionsWithCurrent(this.f.intField,  INT_OPTIONS);
    this.intOptions2   = optionsWithCurrent(this.f.intField2, INT_OPTIONS);
    // TIE eski free-text alandı; mevcut serbest değerler dropdown başında
    // görünür kalır (defensive sticky).
    this.tieOptions    = optionsWithCurrent(this.f.tie, TIE_OPTIONS);
    // Sanal eski free-text alandı; mevcut kayıtlardaki değer (varsa)
    // dropdown başında sticky görünür.
    this.sanalOptions  = optionsWithCurrent(this.f.virtualResource, SANAL_OPTIONS);
  }

  canSave = () => !!(this.f.contentName && this.f.date && this.f.startTime && this.f.endTime);

  save() {
    if (!this.canSave()) return;
    const f   = this.f;
    const toISO = (t: string) => new Date(`${f.date}T${t}${environment.utcOffset}`).toISOString();
    const s   = this.data.schedule;

    // Mevcut liveDetails'i koru; sadece bu form'da DOLU bırakılan alanları üzerine yaz.
    // Boş bırakılan alanlar (kullanıcı dokunmamış olabilir) Teknik Detay tarafındaki
    // değeri silmesin diye dokunulmaz. Açıkça silmek isteyen Teknik Detay dialog'una gider.
    const currentLd = ((s.metadata ?? {}) as Record<string, unknown>)['liveDetails'];
    const ldNext: Record<string, string> = {
      ...((currentLd && typeof currentLd === 'object') ? currentLd as Record<string, string> : {}),
    };
    // Slot 1 ve 3 (ird, ird3) Teknik Detay ile paylaşılan alanlar.
    // Slot 2 (ird2) ve fiberResource2 yeni anahtarlar — sadece Edit'ten yazılır.
    const ldUpdates: Record<string, string> = {
      modulationType:  f.modulationType.trim(),
      videoCoding:     f.videoCoding.trim(),
      demod:           f.demod.trim(),
      tie:             f.tie.trim(),
      virtualResource: f.virtualResource.trim(),
      ird:             f.ird1.trim(),
      ird2:            f.ird2.trim(),
      ird3:            f.ird3.trim(),
      fiberResource:   f.fiber1.trim(),
      fiberResource2:  f.fiber2.trim(),
    };
    // Boş bırakma davranışı: kullanıcı bir alanı boş bıraktıysa mevcut
    // liveDetails değerini koru (silmez). Açıkça silmek isteyen kullanıcı
    // dropdown'da "—" seçimi yapar (zaten boş string yazar) — ama bu durumda
    // da mevcut değer korunur. Veri kaybı önlemek tasarım tercihidir.
    for (const [key, value] of Object.entries(ldUpdates)) {
      if (value) ldNext[key] = value;
    }

    this.saving.set(true);
    this.api.patch<Schedule>(`/schedules/${s.id}`, {
      channelId: f.channelId!,
      startTime: toISO(f.startTime),
      endTime:   toISO(f.endTime),
      title:     f.contentName,
      usageScope: 'live-plan',
      metadata: {
        ...(s.metadata ?? {}),
        ...LIVE_PLAN_METADATA,
        contentName:  f.contentName,
        league:       f.league      || undefined,
        language:     f.language    || 'Yok',
        transStart:   f.transStart  || undefined,
        transEnd:     f.transEnd    || undefined,
        houseNumber:  f.houseNumber || undefined,
        intField:     f.intField || undefined,
        intField2:    f.intField2 || undefined,
        offTube:      f.offTube     || undefined,
        description:  f.notes      || undefined,
        liveDetails:  Object.keys(ldNext).length > 0 ? ldNext : undefined,
      },
    }, s.version).subscribe({
      next:  (updated) => { this.saving.set(false); this.dialogRef.close(updated); },
      error: (e)       => { this.saving.set(false); this.logger.error("Schedule save failed", e); },
    });
  }
}

// ── Teknik Detay Dialog ───────────────────────────────────────────────────────
@Component({
  selector: 'app-schedule-technical-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule, MatDialogModule,
    MatProgressSpinnerModule, MatSnackBarModule,
  ],
  template: `
    <h2 mat-dialog-title>Teknik Detaylar</h2>
    <mat-dialog-content class="technical-content">
      <div class="technical-title">{{ contentTitle }}</div>
      @for (group of liveDetailGroups; track group.title) {
        <section class="technical-section">
          <h3>{{ group.title }}</h3>
          <div class="technical-grid">
            @for (field of group.fields; track field.key) {
              @if (!field.editOnly) {
                <mat-form-field [class.tech-wide]="field.wide">
                  <mat-label>{{ field.label }}</mat-label>
                  @if (field.type === 'textarea') {
                    <textarea matInput rows="2"
                              [(ngModel)]="liveDetails[field.key]"
                              [ngModelOptions]="{standalone:true}"></textarea>
                  } @else if (field.options) {
                    <mat-select [(ngModel)]="liveDetails[field.key]" [ngModelOptions]="{standalone:true}">
                      <mat-option value="">—</mat-option>
                      @for (option of fieldDropdownOptions(field); track option) {
                        <mat-option [value]="option">{{ option }}</mat-option>
                      }
                    </mat-select>
                  } @else {
                    <input matInput
                           [(ngModel)]="liveDetails[field.key]"
                           [ngModelOptions]="{standalone:true}">
                  }
                </mat-form-field>
              }
            }
          </div>
        </section>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>İptal</button>
      <button mat-raised-button color="primary"
              [disabled]="saving()"
              (click)="save()">
        @if (saving()) {
          <mat-spinner diameter="16" style="display:inline-block;margin-right:6px"></mat-spinner>
          Kaydediliyor…
        } @else {
          Kaydet
        }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .technical-content { max-height:70vh; min-width:860px; }
    .technical-title {
      color:#bdbdbd;
      font-size:13px;
      margin:0 0 12px;
    }
    .technical-section {
      border:1px solid rgba(255,255,255,.12);
      border-radius:6px;
      padding:10px 12px 0;
      margin-bottom:12px;
    }
    .technical-section h3 {
      font-size:13px;
      font-weight:700;
      margin:0 0 10px;
      color:#90caf9;
    }
    .technical-grid {
      display:grid;
      grid-template-columns:repeat(3, minmax(150px, 1fr));
      gap:8px 12px;
      align-items:start;
    }
    .technical-grid mat-form-field { min-width:0; }
    .tech-wide { grid-column:span 2; }
  `],
})
export class ScheduleTechnicalDialogComponent {
  data      = inject<{ schedule: Schedule }>(MAT_DIALOG_DATA);
  dialogRef = inject(MatDialogRef<ScheduleTechnicalDialogComponent>);
  api       = inject(ApiService);
  snack     = inject(MatSnackBar);
  logger    = inject(LoggerService);
  saving    = signal(false);

  readonly liveDetailGroups = LIVE_DETAIL_GROUPS;
  readonly liveDetails = createLiveDetails(this.data.schedule.metadata?.['liveDetails']);
  readonly contentTitle = String(this.data.schedule.metadata?.['contentName'] || this.data.schedule.title || '');

  /** Defensive dropdown helper — eğer mevcut değer field.options'ta yoksa
   *  (eski format), liste başına geçici option olarak ekler. Edit dialog'la
   *  paylaşılan ird/ird3/fiberResource alanları için format çakışmasını
   *  şeffaf yönetir; kullanıcı eski değer görür ve dilerse yeni listeden
   *  seçim yaparak doğal olarak yeni formata geçer. */
  fieldDropdownOptions(field: LiveDetailField): readonly string[] {
    if (!field.options) return [];
    const current = String(this.liveDetails[field.key] ?? '');
    return optionsWithCurrent(current, field.options);
  }

  save() {
    const s = this.data.schedule;
    this.saving.set(true);
    this.api.patch<Schedule>(`/schedules/${s.id}`, {
      usageScope: 'live-plan',
      metadata: {
        ...(s.metadata ?? {}),
        ...LIVE_PLAN_METADATA,
        liveDetails: cleanLiveDetails(this.liveDetails),
      },
    }, s.version).subscribe({
      next:  (updated) => { this.saving.set(false); this.dialogRef.close(updated); },
      error: (e)       => {
        this.saving.set(false);
        this.snack.open(`Teknik detaylar kaydedilemedi: ${e?.error?.message ?? e.message}`, 'Kapat', { duration: 4000 });
      },
    });
  }
}

// ── Sorun Bildir Dialog ───────────────────────────────────────────────────────
@Component({
  selector: 'app-report-issue-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatDialogModule, MatButtonModule,
            MatFormFieldModule, MatInputModule, MatProgressSpinnerModule],
  template: `
    <h2 mat-dialog-title style="display:flex;align-items:center;gap:8px">
      <span style="color:#f44336;font-size:20px;line-height:1">⚠</span>
      Sorun Bildir
    </h2>
    <mat-dialog-content style="min-width:420px;max-width:560px">
      <!-- İçerik Bilgileri -->
      <div style="background:#1e1e1e;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:13px;line-height:1.8">
        <div><span style="color:#888">İçerik:</span>&nbsp;<strong>{{ data.schedule.title }}</strong></div>
        <div><span style="color:#888">Tarih:</span>&nbsp;{{ formatDate(data.schedule.startTime) }}</div>
        <div><span style="color:#888">Saat:</span>&nbsp;{{ formatTime(data.schedule.startTime) }} – {{ formatTime(data.schedule.endTime) }}</div>
        @if (data.schedule.channel?.name) {
          <div><span style="color:#888">Kanal:</span>&nbsp;{{ data.schedule.channel!.name }}</div>
        }
      </div>

      <!-- Sorun Açıklaması -->
      <mat-form-field appearance="outline" style="width:100%">
        <mat-label>Sorun Açıklaması</mat-label>
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
    return new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
  }
  formatTime(iso: string): string {
    return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
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
      channel:     s.channel?.name ?? '',
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
    MatInputModule, MatSelectModule, MatFormFieldModule,
    MatProgressSpinnerModule, MatSnackBarModule, MatTooltipModule,
    MatDialogModule, MatChipsModule, MatCardModule, MatPaginatorModule,
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
                    <span class="content-main">{{ s.metadata?.['contentName'] || s.title }}</span>
                  </td>
                  <td class="td-trans">{{ s.metadata?.['transStart'] || (s.startTime | date:'HH:mm') }}</td>
                  <td class="td-trans">{{ s.metadata?.['transEnd']   || (s.endTime   | date:'HH:mm') }}</td>
                  <td class="td-mod">
                    <div>{{ liveDetailValue(s, 'modulationType') }}</div>
                    <div class="td-mod-sub">{{ liveDetailValue(s, 'videoCoding') }}</div>
                  </td>
                  <td class="td-mono td-stack">
                    @for (v of irdValues(s); track $index) {
                      <div>{{ v }}</div>
                    }
                  </td>
                  <td class="td-mono td-stack">
                    @for (v of fiberValues(s); track $index) {
                      <div>{{ v }}</div>
                    }
                  </td>
                  <td class="td-mono">{{ liveDetailValue(s, 'demod') }}</td>
                  <td class="td-mono td-record-location">{{ formatRecordingPorts(s) }}</td>
                  <td class="td-mono">{{ liveDetailValue(s, 'tie') }}</td>
                  <td class="td-mono">{{ liveDetailValue(s, 'virtualResource') }}</td>
                  <td class="td-mono">{{ s.metadata?.['houseNumber'] ?? '' }}</td>
                  <td class="td-mono">{{ displayInt(s) }}</td>
                  <td class="td-mono">{{ s.metadata?.['offTube'] ?? '' }}</td>
                  <td class="td-lang">{{ s.metadata?.['language'] ?? 'Yok' }}</td>
                  <td class="td-channel">{{ s.channel?.name ?? '—' }}</td>
                  <td class="td-league">
                    {{ s.metadata?.['league'] ?? '' }}
                    @if (s.metadata?.['weekNumber']) {
                      <span class="week-badge">H{{ s.metadata?.['weekNumber'] }}</span>
                    }
                  </td>
                  <td class="td-notes">{{ s.metadata?.['description'] || '' }}</td>
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

    .page-container { padding:0; }
    #live-plan-fullscreen:fullscreen {
      display:flex;
      flex-direction:column;
      height:100vh;
      background:#121212;
      overflow:hidden;
      zoom:100%;
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
      background:#8b0000;
    }

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
    .top-actions { margin-left:auto; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }

    /* ── Tablo ── */
    .table-wrapper {
      overflow-x:auto;
    }
    .broadcast-table {
      width:max-content; min-width:100%; border-collapse:collapse;
      font-size:0.82rem;
    }
    .broadcast-table thead tr {
      background:#8b0000;
      color:#fff;
    }
    .broadcast-table thead th {
      padding:4px 6px; text-align:center;
      border:1px solid #000;
      white-space:normal; font-weight:700;
      font-size:0.95rem;
      line-height:1.15;
      letter-spacing:0.01em;
    }
    .broadcast-table tbody tr {
      border-bottom:1px solid rgba(255,255,255,0.06);
      transition:background 0.15s;
    }
    .broadcast-table tbody tr:hover { filter:brightness(1.12); }
    .broadcast-table tbody tr.has-league-color:hover { filter:brightness(1.15); }
    .broadcast-table tbody tr.transmission-finished:hover { filter:brightness(1.08); }
    .row-even { background:#1e1e2e; }
    .row-odd  { background:#242436; }

	    .broadcast-table td {
	      padding:4px 6px; border:1px solid #000;
	      vertical-align:middle; color:rgba(255,255,255,0.87);
	    }
	    .broadcast-table tbody td:not(.td-actions) {
	      font-size:1rem;
	      font-weight:600;
	      line-height:1.2;
	      text-align:center;
	    }
	    .no-data { text-align:center; padding:32px; color:#666; }

    /* ── Özel hücreler ── */
    .td-time    { font-weight:700; color:#fff; white-space:nowrap; min-width:52px; }
    .td-title   { min-width:180px; max-width:240px; }
	    .content-main { font-weight:700; display:block; }
	    .td-trans   { white-space:nowrap; color:#aaa; min-width:48px; text-align:center; }
	    .td-mono    { font-family:monospace; color:#90a4ae; text-align:center; }
	    .td-mod     { font-family:monospace; color:#90a4ae; text-align:center; line-height:1.15; }
	    .td-mod-sub { color:#78909c; font-size:0.85em; }
	    .td-stack   { line-height:1.18; }
	    .td-stack > div { white-space:nowrap; }
	    .td-stack > div + div { margin-top:1px; color:#78909c; }
	    .td-lang    { text-align:center; color:#bdbdbd; white-space:nowrap; }
	    .td-channel { color:#ffd600; font-weight:600; white-space:nowrap; min-width:110px; }
	    .td-league  {
	      color:#aaa; white-space:normal;
	      font-size:0.82rem !important;
	      font-weight:500 !important;
	      line-height:1.15;
	      max-width:110px; min-width:80px;
	    }
	    .week-badge { display:inline-block; margin-left:4px; padding:0 4px; border-radius:3px; background:#1976d2; color:#fff; font-size:0.72rem; vertical-align:middle; }
	    .td-notes   { min-width:320px; max-width:480px; color:#bdbdbd; white-space:normal; }
    .td-actions { width:160px; padding:2px 4px; text-align:center; white-space:nowrap; }

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
export class ScheduleListComponent implements OnInit, OnDestroy {
  private scheduleSvc = inject(ScheduleService);
  private api         = inject(ApiService);
  private snack       = inject(MatSnackBar);
  private dialog      = inject(MatDialog);
  private keycloak    = inject(KeycloakService);

  channels          = signal<Channel[]>([]);
  schedules         = signal<Schedule[]>([]);
  total             = signal(0);
  loading           = signal(false);
  currentTime       = signal(Date.now());
  selectedDate      = new Date().toISOString().slice(0, 10);
  fullscreenActive  = signal(false);
  private _userGroups = signal<string[]>([]);

  canAdd           = computed(() => hasGroup(this._userGroups(), PERMISSIONS.schedules.add));
  canEdit          = computed(() => hasGroup(this._userGroups(), PERMISSIONS.schedules.edit));
  canTechnicalEdit = computed(() => hasGroup(this._userGroups(), PERMISSIONS.schedules.technicalEdit));
  canDuplicate     = computed(() => hasGroup(this._userGroups(), PERMISSIONS.schedules.duplicate));
  canDelete        = computed(() => hasGroup(this._userGroups(), PERMISSIONS.schedules.delete));
  canReportIssue   = computed(() => hasGroup(this._userGroups(), PERMISSIONS.incidents.reportIssue));

  pageSize = 100;
  page     = 1;
  private clockTimer?: ReturnType<typeof setInterval>;

  ngOnInit() {
    this.clockTimer = setInterval(() => this.currentTime.set(Date.now()), 60_000);
    if (environment.skipAuth) {
      this._userGroups.set([GROUP.SystemEng]);
    } else {
      const parsed = this.keycloak.getKeycloakInstance().tokenParsed as BcmsTokenParsed | undefined;
      const groups: string[] = parsed?.groups ?? [];
      this._userGroups.set(groups.includes(GROUP.Admin) ? Array.from(new Set([...groups, GROUP.SystemEng])) : groups);
    }
    this.api.get<Channel[]>('/channels').subscribe({
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

  scheduleLeagueName(s: Schedule) {
    return String(s.metadata?.['league'] ?? '');
  }

  scheduleRowColor(s: Schedule) {
    return this.isTransmissionFinished(s) ? '#55595f' : leagueBackground(s.metadata?.['league']);
  }

  scheduleLeagueColor(s: Schedule) {
    return leagueBackground(s.metadata?.['league']);
  }

  isTransmissionFinished(s: Schedule) {
    return transmissionEndDate(s).getTime() <= this.currentTime();
  }

  displayInt(s: Schedule) {
    const values = [
      ...String(s.metadata?.['intField'] ?? '').split(/[/-]/),
      String(s.metadata?.['intField2'] ?? ''),
    ]
      .map((value) => value.trim())
      .filter(Boolean);
    return Array.from(new Set(values)).join(' - ');
  }

  /** Tabloda metadata.liveDetails altındaki bir alanı gösterir.
   *  Hem Düzenle hem Teknik Detay dialog'ları aynı yere yazar. */
  liveDetailValue(s: Schedule, key: string): string {
    const ld = (s.metadata?.['liveDetails'] ?? {}) as Record<string, unknown>;
    const value = ld[key];
    return value !== null && value !== undefined ? String(value) : '';
  }

  /** Kayıt Yeri kolonu: ingest_plan_items'tan gelen ana + yedek port (read-only).
   *  Tek edit noktası Ingest sekmesi. "Port 5 - Port 12" formatı. */
  formatRecordingPorts(s: Schedule): string {
    const primary = (s as Schedule & { recordingPort?: string | null }).recordingPort?.trim();
    const backup  = (s as Schedule & { backupRecordingPort?: string | null }).backupRecordingPort?.trim();
    if (primary && backup) return `${primary} - ${backup}`;
    if (primary) return primary;
    return '';
  }

  /** IRD slotları: ird (slot 1) + ird2 (slot 2) + ird3 (slot 3). Boş slotlar
   *  filter'lanır — tabloda sadece dolu olanlar alt alta görünür. */
  irdValues(s: Schedule): string[] {
    const ld = (s.metadata?.['liveDetails'] ?? {}) as Record<string, unknown>;
    return ['ird', 'ird2', 'ird3']
      .map((k) => String(ld[k] ?? '').trim())
      .filter(Boolean);
  }

  /** Fiber slotları: fiberResource (slot 1) + fiberResource2 (slot 2). */
  fiberValues(s: Schedule): string[] {
    const ld = (s.metadata?.['liveDetails'] ?? {}) as Record<string, unknown>;
    return ['fiberResource', 'fiberResource2']
      .map((k) => String(ld[k] ?? '').trim())
      .filter(Boolean);
  }

  load() {
    this.loading.set(true);
    const from = new Date(`${this.selectedDate}T00:00:00+03:00`).toISOString();
    const to   = new Date(`${this.selectedDate}T23:59:59+03:00`).toISOString();

    const params: ScheduleFilter = { from, to, page: this.page, pageSize: this.pageSize, usage: 'live-plan' };

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
    this.selectedDate = new Date().toISOString().slice(0, 10);
    this.page = 1; this.load();
  }

  openAddDialog() {
    const ref = this.dialog.open(ScheduleAddDialogComponent, {
      data: { channels: this.channels() },
      width: '1300px',
      maxWidth: '98vw',
      height: 'calc(100vh - 120px)',
      maxHeight: 'calc(100vh - 120px)',
      position: { top: '98px' },
      panelClass: ['dark-dialog', 'schedule-add-dialog-panel'],
    });
    ref.afterClosed().subscribe((result) => {
      if (result) {
        this.snack.open('Kayıt eklendi', 'Kapat', { duration: 3000 });
        this.load();
      }
    });
  }

  openEditDialog(s: Schedule) {
    const ref = this.dialog.open(ScheduleEditDialogComponent, {
      data: { schedule: s, channels: this.channels() },
      width: '90vw',
      maxWidth: '1200px',
      maxHeight: '90vh',
      panelClass: 'dark-dialog',
    });
    ref.afterClosed().subscribe((result) => {
      if (result) {
        this.snack.open('Kayıt güncellendi', 'Kapat', { duration: 3000 });
        this.load();
      }
    });
  }

  openTechnicalDialog(s: Schedule) {
    const ref = this.dialog.open(ScheduleTechnicalDialogComponent, {
      data: { schedule: s },
      width: '980px',
      maxWidth: '98vw',
      panelClass: 'dark-dialog',
    });
    ref.afterClosed().subscribe((result) => {
      if (result) {
        this.snack.open('Teknik detaylar güncellendi', 'Kapat', { duration: 3000 });
        this.load();
      }
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

  duplicateSchedule(s: Schedule) {
    const metadata: Record<string, unknown> = {
      ...(s.metadata ?? {}),
      ...LIVE_PLAN_METADATA,
      duplicatedFromId: s.id,
    };
    const title = String(metadata['contentName'] || s.title || 'Kopya materyal');

    this.scheduleSvc.createSchedule({
      channelId: null,
      startTime: s.startTime,
      endTime:   s.endTime,
      title,
      usageScope: 'live-plan',
      ...(s.contentId != null && { contentId: s.contentId }),
      ...(s.broadcastTypeId != null && { broadcastTypeId: s.broadcastTypeId }),
      metadata,
    }).subscribe({
      next: () => {
        this.snack.open('Materyal çoğaltıldı', 'Kapat', { duration: 2500 });
        this.load();
      },
      error: (e) => this.snack.open(`Kopyalama hatası: ${e?.error?.message ?? e.message}`, 'Kapat', { duration: 4000 }),
    });
  }

  deleteSchedule(s: Schedule) {
    const snackRef = this.snack.open(
      `"${(s.metadata?.['contentName'] as string | undefined) || s.title}" silinecek`,
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
