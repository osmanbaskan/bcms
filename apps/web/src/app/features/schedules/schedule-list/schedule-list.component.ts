import {
  Component, OnInit, signal, inject,
} from '@angular/core';
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

import { ScheduleService } from '../../../core/services/schedule.service';
import { ApiService } from '../../../core/services/api.service';
import type { Schedule } from '@bcms/shared';

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
  channelId:   number | null;
  language:    string;
  transStart:  string;
  transEnd:    string;
  houseNumber: string;
  intField:    string;
  offTube:     string;
  notes:       string;
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
    <mat-dialog-content>
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
                <mat-option [value]="c">{{ c.name }}</mat-option>
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
        @if (!matchesLoading() && selectedComp() && allMatches().length === 0) {
          <div class="info-row">
            <mat-icon class="info-icon">info</mat-icon>
            <span>Bu lig için planlanmış maç bulunamadı.</span>
          </div>
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
                  <tr>
                    <td class="col-title">{{ m.homeTeamName }} - {{ m.awayTeamName }}</td>
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
                      <input class="cell-input" type="time" step="1"
                             [(ngModel)]="getForm(m.matchId).transStart"
                             [ngModelOptions]="{standalone:true}"
                             placeholder="Baş.">
                      <input class="cell-input" type="time" step="1"
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
                    <td><input class="cell-input" [(ngModel)]="getForm(m.matchId).intField"    [ngModelOptions]="{standalone:true}"></td>
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
              <input matInput type="time" step="1" [(ngModel)]="mf.startTime" [ngModelOptions]="{standalone:true}">
            </mat-form-field>
            <mat-form-field>
              <mat-label>Bitiş *</mat-label>
              <input matInput type="time" step="1" [(ngModel)]="mf.endTime" [ngModelOptions]="{standalone:true}">
            </mat-form-field>
          </div>
          <div class="mform-row">
            <mat-form-field>
              <mat-label>Trans. Başlangıç</mat-label>
              <input matInput type="time" step="1" [(ngModel)]="mf.transStart" [ngModelOptions]="{standalone:true}">
            </mat-form-field>
            <mat-form-field>
              <mat-label>Trans. Bitiş</mat-label>
              <input matInput type="time" step="1" [(ngModel)]="mf.transEnd" [ngModelOptions]="{standalone:true}">
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
              <input matInput [(ngModel)]="mf.intField" [ngModelOptions]="{standalone:true}">
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
      @if (activeTab === 0) {
        <button mat-raised-button color="primary"
                [disabled]="!canSave() || saving()"
                (click)="save()">
          @if (saving()) {
            <mat-spinner diameter="16" style="display:inline-block;margin-right:6px"></mat-spinner>
            Kaydediliyor…
          } @else {
            Kaydet ({{ checkedIds().size }})
          }
        </button>
      } @else {
        <button mat-raised-button color="primary"
                [disabled]="!canSaveManual() || saving()"
                (click)="saveManual()">
          @if (saving()) {
            <mat-spinner diameter="16" style="display:inline-block;margin-right:6px"></mat-spinner>
            Kaydediliyor…
          } @else {
            Kaydet
          }
        </button>
      }
    </mat-dialog-actions>
  `,
  styles: [`
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

    .select-all-row { display:flex; align-items:center; gap:12px; padding:4px 8px; margin-bottom:4px; }
    .badge { background:#1976d2; color:#fff; border-radius:10px; padding:1px 8px; font-size:11px; }

    .match-list { max-height:180px; overflow-y:auto; border:1px solid #333; border-radius:4px; margin-bottom:8px; }
    .match-item {
      display:flex; align-items:center; gap:10px;
      padding:6px 10px; cursor:pointer; transition:background .15s;
    }
    .match-item:hover   { background:rgba(255,255,255,.05); }
    .match-item.checked { background:rgba(25,118,210,.12); }
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
    .entry-table tbody tr:hover { background:rgba(255,255,255,.04); }
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

    .col-title   { min-width:180px; font-weight:500; }
    .col-time    { white-space:nowrap; color:#aaa; }
    .col-channel { min-width:120px; }
    .col-trans   { min-width:150px; display:table-cell; }
    .col-trans input { display:block; margin-bottom:2px; }
    .col-lang    { min-width:70px; }

    /* ── Tab body ── */
    .tab-body { padding: 12px 0 4px; }

    /* ── Manuel form ── */
    .mform-row { display:flex; gap:12px; margin-bottom:2px; flex-wrap:wrap; }
    .mform-row mat-form-field { flex:1; min-width:130px; }
    .mf-wide { flex:2 !important; }
  `],
})
export class ScheduleAddDialogComponent {
  data      = inject<{ channels: Channel[] }>(MAT_DIALOG_DATA);
  dialogRef = inject(MatDialogRef<ScheduleAddDialogComponent>);
  api       = inject(ApiService);
  saving    = signal(false);
  activeTab = 0;

  // Manuel form verisi
  mf = {
    contentName: '', league: '', channelId: null as number | null,
    date: new Date().toISOString().slice(0, 10),
    startTime: '', endTime: '', transStart: '', transEnd: '',
    houseNumber: '', intField: '', offTube: '', language: 'Yok', notes: '',
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

  filteredMatches = (): OptaFixture[] => {
    const w = this.selectedWeek();
    if (w === null) return this.allMatches();
    if (w === -1)   return this.allMatches().filter((m) => m.weekNumber == null);
    return this.allMatches().filter((m) => m.weekNumber === w);
  };

  allChecked      = () => this.filteredMatches().length > 0 && this.filteredMatches().every((m) => this.checkedIds().has(m.matchId));
  someChecked     = () => this.filteredMatches().some((m) => this.checkedIds().has(m.matchId));
  selectedMatches = () => this.allMatches().filter((m) => this.checkedIds().has(m.matchId));
  canSave         = () => this.checkedIds().size > 0 && this.selectedMatches().every((m) => !!this.getForm(m.matchId).channelId);

  readonly hdvgOptions = Array.from({ length: 15 }, (_, i) => `HDVG${i + 1}`);
  compById = (a: FixtureCompetition | null, b: FixtureCompetition | null) =>
    a?.id === b?.id && a?.season === b?.season;

  // Her maç için ayrı form verisi (plain Map — save anında okunur)
  private matchForms = new Map<string, MatchFormData>();

  getForm(id: string): MatchFormData {
    if (!this.matchForms.has(id)) {
      this.matchForms.set(id, { channelId: null, language: 'Yok', transStart: '', transEnd: '', houseNumber: '', intField: '', offTube: '', notes: '' });
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
      },
      error: () => { this.matchesLoading.set(false); },
    });
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
      channelId:   null,
      language:    'Yok',
      transStart:  `${pad(transStartDt.getHours())}:${pad(transStartDt.getMinutes())}`,
      transEnd:    `${pad(transEndDt.getHours())}:${pad(transEndDt.getMinutes())}`,
      houseNumber: '',
      intField:    '',
      offTube:     '',
      notes:       '',
    });
  }

  save() {
    if (!this.canSave()) return;

    const requests = this.selectedMatches().map((m) => {
      const f  = this.getForm(m.matchId);
      const dt = new Date(m.matchDate);
      return this.api.post<Schedule>('/schedules', {
        channelId: f.channelId!,
        startTime: dt.toISOString(),
        endTime:   new Date(dt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        title:     `${m.homeTeamName} - ${m.awayTeamName}`,
        metadata: {
          contentName:  `${m.homeTeamName} - ${m.awayTeamName}`,
          league:       m.competitionName || undefined,
          weekNumber:   m.weekNumber      ?? undefined,
          language:     f.language    || 'Yok',
          transStart:   f.transStart  || undefined,
          transEnd:     f.transEnd    || undefined,
          houseNumber:  f.houseNumber || undefined,
          intField:     f.intField    || undefined,
          offTube:      f.offTube     || undefined,
          description:  f.notes      || undefined,
          optaMatchId:  m.matchId,
        },
      });
    });

    this.saving.set(true);
    forkJoin(requests).subscribe({
      next:  (saved) => { this.saving.set(false); this.dialogRef.close(saved); },
      error: (e)     => { this.saving.set(false); console.error(e); },
    });
  }

  saveManual() {
    if (!this.canSaveManual()) return;
    const f = this.mf;
    const toISO = (t: string) => new Date(`${f.date}T${t}${environment.utcOffset}`).toISOString();
    this.saving.set(true);
    this.api.post<Schedule>('/schedules', {
      channelId: f.channelId!,
      startTime: toISO(f.startTime),
      endTime:   toISO(f.endTime),
      title:     f.contentName,
      metadata: {
        contentName:  f.contentName,
        league:       f.league      || undefined,
        language:     f.language    || 'Yok',
        transStart:   f.transStart  || undefined,
        transEnd:     f.transEnd    || undefined,
        houseNumber:  f.houseNumber || undefined,
        intField:     f.intField    || undefined,
        offTube:      f.offTube     || undefined,
        description:  f.notes      || undefined,
      },
    }).subscribe({
      next:  (s) => { this.saving.set(false); this.dialogRef.close(s); },
      error: (e) => { this.saving.set(false); console.error(e); },
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
            <input matInput type="time" step="1" [(ngModel)]="f.startTime" [ngModelOptions]="{standalone:true}">
          </mat-form-field>
          <mat-form-field>
            <mat-label>Bitiş *</mat-label>
            <input matInput type="time" step="1" [(ngModel)]="f.endTime" [ngModelOptions]="{standalone:true}">
          </mat-form-field>
        </div>
        <div class="eform-row">
          <mat-form-field>
            <mat-label>Trans. Başlangıç</mat-label>
            <input matInput type="time" step="1" [(ngModel)]="f.transStart" [ngModelOptions]="{standalone:true}">
          </mat-form-field>
          <mat-form-field>
            <mat-label>Trans. Bitiş</mat-label>
            <input matInput type="time" step="1" [(ngModel)]="f.transEnd" [ngModelOptions]="{standalone:true}">
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
            <input matInput [(ngModel)]="f.intField" [ngModelOptions]="{standalone:true}">
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
    .edit-body { min-width: 680px; }
    .eform-row { display:flex; gap:12px; margin-bottom:4px; flex-wrap:wrap; }
    .eform-row mat-form-field { flex:1; min-width:120px; }
    .ef-wide { flex:2 !important; }
  `],
})
export class ScheduleEditDialogComponent {
  data      = inject<{ schedule: Schedule & { channel?: { id: number; name: string } }; channels: Channel[] }>(MAT_DIALOG_DATA);
  dialogRef = inject(MatDialogRef<ScheduleEditDialogComponent>);
  api       = inject(ApiService);
  saving    = signal(false);

  readonly hdvgOptions = Array.from({ length: 15 }, (_, i) => `HDVG${i + 1}`);

  f: {
    contentName: string; league: string; channelId: number | null;
    date: string; startTime: string; endTime: string;
    transStart: string; transEnd: string; houseNumber: string;
    intField: string; offTube: string; language: string; notes: string;
  };

  constructor() {
    const s   = this.data.schedule;
    const m   = (s.metadata ?? {}) as Record<string, string>;
    const st  = new Date(s.startTime);
    const et  = new Date(s.endTime);

    this.f = {
      contentName: m['contentName'] || s.title || '',
      league:      m['league']      || '',
      channelId:   s.channel?.id ?? null,
      date:        st.toLocaleDateString('sv-SE', { timeZone: environment.timezone }),
      startTime:   `${pad(st.getHours())}:${pad(st.getMinutes())}:${pad(st.getSeconds())}`,
      endTime:     `${pad(et.getHours())}:${pad(et.getMinutes())}:${pad(et.getSeconds())}`,
      transStart:  m['transStart']  || '',
      transEnd:    m['transEnd']    || '',
      houseNumber: m['houseNumber'] || '',
      intField:    m['intField']    || '',
      offTube:     m['offTube']     || '',
      language:    m['language']    || 'Yok',
      notes:       m['description'] || '',
    };
  }

  canSave = () => !!(this.f.contentName && this.f.channelId && this.f.date && this.f.startTime && this.f.endTime);

  save() {
    if (!this.canSave()) return;
    const f   = this.f;
    const toISO = (t: string) => new Date(`${f.date}T${t}${environment.utcOffset}`).toISOString();
    const s   = this.data.schedule;

    this.saving.set(true);
    this.api.patch<Schedule>(`/schedules/${s.id}`, {
      channelId: f.channelId!,
      startTime: toISO(f.startTime),
      endTime:   toISO(f.endTime),
      title:     f.contentName,
      metadata: {
        ...(s.metadata ?? {}),
        contentName:  f.contentName,
        league:       f.league      || undefined,
        language:     f.language    || 'Yok',
        transStart:   f.transStart  || undefined,
        transEnd:     f.transEnd    || undefined,
        houseNumber:  f.houseNumber || undefined,
        intField:     f.intField    || undefined,
        offTube:      f.offTube     || undefined,
        description:  f.notes      || undefined,
      },
    }, s.version).subscribe({
      next:  (updated) => { this.saving.set(false); this.dialogRef.close(updated); },
      error: (e)       => { this.saving.set(false); console.error(e); },
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
                <th>Lig / Hafta</th>
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
                  <td class="td-trans">{{ s.metadata?.['transStart'] || (s.startTime | date:'HH:mm') }}</td>
                  <td class="td-trans">{{ s.metadata?.['transEnd']   || (s.endTime   | date:'HH:mm') }}</td>
                  <td class="td-mono">{{ s.metadata?.['houseNumber'] ?? '' }}</td>
                  <td class="td-mono">{{ s.metadata?.['intField'] ?? '' }}</td>
                  <td class="td-mono">{{ s.metadata?.['offTube'] ?? '' }}</td>
                  <td class="td-lang">{{ s.metadata?.['language'] ?? 'Yok' }}</td>
                  <td class="td-channel">{{ s.channel?.name ?? '—' }}</td>
                  <td class="td-league">
                    {{ s.metadata?.['league'] ?? '' }}
                    @if (s.metadata?.['weekNumber']) {
                      <span class="week-badge">H{{ s.metadata?.['weekNumber'] }}</span>
                    }
                  </td>
                  <td class="td-notes">{{ s.metadata?.['description'] || s.title }}</td>
                  <td class="td-actions">
                    <button mat-icon-button
                            matTooltip="Düzenle"
                            (click)="openEditDialog(s)">
                      <mat-icon>edit</mat-icon>
                    </button>
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
    .week-badge { display:inline-block; margin-left:4px; padding:0 5px; border-radius:3px; background:#1976d2; color:#fff; font-size:0.72rem; vertical-align:middle; }
    .td-notes   { max-width:260px; color:#bdbdbd; font-size:0.78rem; }
    .td-actions { width:80px; padding:2px 4px; text-align:center; white-space:nowrap; }

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
      width: '1300px',
      maxWidth: '98vw',
      panelClass: 'dark-dialog',
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
      width: '860px',
      maxWidth: '98vw',
      panelClass: 'dark-dialog',
    });
    ref.afterClosed().subscribe((result) => {
      if (result) {
        this.snack.open('Kayıt güncellendi', 'Kapat', { duration: 3000 });
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
