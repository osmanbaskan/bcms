import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSelectModule } from '@angular/material/select';
import { MatDividerModule } from '@angular/material/divider';

import {
  ScheduleService,
  type BroadcastType,
  type FixtureCompetition,
  type OptaFixtureRow,
} from '../../../core/services/schedule.service';
import {
  composeIstanbulIso,
  formatIstanbulDateTr,
  formatIstanbulTime,
  istanbulTodayDate,
} from '../../../core/time/tz.helpers';

/**
 * 2026-05-11 rewrite: Canlı Yayın Plan "Yeni Yayın Kaydı Ekle" — geniş diyalog.
 *
 * İki sekme:
 *   ┌ Fikstürden Seç ─ İçerik Türü → Lig/Turnuva → Fixture seçimi → POST
 *   │                                /live-plan/from-opta { optaMatchId }
 *   └ Manuel Giriş ─ title + tarih/saat + takım + notlar →
 *                    POST /live-plan { ... }  (mevcut DTO korunur)
 *
 * Kurallar:
 *  - İçerik Türü seçilmeden Lig/Turnuva dropdown disabled.
 *  - Lig/Turnuva seçilmeden fixture listesi disabled.
 *  - Fixture filter: from=<bugün Türkiye> ISO (gelecek odaklı; geçmiş maç
 *    canlı yayın planı için anlamsız).
 *  - 409 → operatöre "aktif kayıt var, çoğaltmak için Çoğalt'ı kullanın" UX.
 *  - JSON/metadata YOK. Channel slot bu PR'da manuel sekmede YOK
 *    (K-B3.11/12 reverse sync ile schedule'tan beslenir).
 */
@Component({
  selector: 'app-live-plan-entry-add-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule,
    MatDialogModule, MatProgressSpinnerModule,
    MatSnackBarModule, MatTabsModule, MatDividerModule,
  ],
  template: `
    <h2 mat-dialog-title>Yeni Yayın Kaydı Ekle</h2>
    <mat-dialog-content class="add-dialog-content">
      <mat-tab-group [(selectedIndex)]="activeTab" animationDuration="150ms">

        <!-- ══ Sekme 1: Fikstürden Seç ════════════════════════════════ -->
        <mat-tab label="Fikstürden Seç">
          <div class="tab-body fixture-body">
            <div class="row">
              <mat-form-field appearance="outline" class="grow">
                <mat-label>İçerik Türü</mat-label>
                <mat-select [(ngModel)]="selectedBroadcastTypeId"
                            [ngModelOptions]="{standalone:true}"
                            [disabled]="broadcastTypesLoading() || saving()">
                  <mat-option [value]="null">— Tümü —</mat-option>
                  @for (bt of broadcastTypes(); track bt.id) {
                    <mat-option [value]="bt.id">{{ bt.description || bt.code }}</mat-option>
                  }
                </mat-select>
                @if (broadcastTypesLoading()) {
                  <mat-spinner matSuffix diameter="16"></mat-spinner>
                }
              </mat-form-field>

              <mat-form-field appearance="outline" class="grow">
                <mat-label>Lig / Turnuva</mat-label>
                <mat-select [ngModel]="selectedCompetitionCode()"
                            (ngModelChange)="onCompetitionChange($event)"
                            [ngModelOptions]="{standalone:true}"
                            [disabled]="competitionsLoading() || saving()">
                  <mat-option [value]="null">— Seçin —</mat-option>
                  @for (c of competitions(); track c.id + ':' + c.season) {
                    <mat-option [value]="c.id + ':' + c.season">
                      {{ c.name }} <span class="season-chip">{{ c.season }}</span>
                    </mat-option>
                  }
                </mat-select>
                @if (competitionsLoading()) {
                  <mat-spinner matSuffix diameter="16"></mat-spinner>
                }
              </mat-form-field>
            </div>

            <div class="fixtures-section">
              <div class="fixtures-header">
                <span class="fixtures-title">Fikstür</span>
                <span class="fixtures-meta">
                  @if (fixturesLoading()) { yükleniyor… }
                  @else if (!selectedCompetitionCode()) { lig seçin }
                  @else if (fixtures().length === 0) { gelecek fikstür yok }
                  @else { {{ fixtures().length }} maç (bugün ve sonrası) }
                </span>
              </div>

              <div class="fixtures-list">
                @if (fixturesLoading()) {
                  <div class="fixture-empty"><mat-spinner diameter="20"></mat-spinner></div>
                } @else if (!selectedCompetitionCode()) {
                  <div class="fixture-empty">Lig/Turnuva seçince fikstür listelenir.</div>
                } @else if (fixtures().length === 0) {
                  <div class="fixture-empty">Bu lig için gelecek fikstür bulunamadı.</div>
                } @else {
                  @for (f of fixtures(); track f.matchId) {
                    <button type="button"
                            class="fixture-row"
                            [class.selected]="selectedFixtureId() === f.matchId"
                            (click)="selectFixture(f.matchId)">
                      <span class="fx-date">{{ formatFixtureDate(f.matchDate) }}</span>
                      <span class="fx-time">{{ formatFixtureTime(f.matchDate) }}</span>
                      <span class="fx-teams">{{ f.homeTeamName }} <em>—</em> {{ f.awayTeamName }}</span>
                      @if (f.weekNumber != null) { <span class="fx-week">{{ f.weekNumber }}. Hafta</span> }
                    </button>
                  }
                }
              </div>
            </div>

            @if (errorMsg() && activeTab === 0) {
              <p class="err">{{ errorMsg() }}</p>
            }
          </div>
        </mat-tab>

        <!-- ══ Sekme 2: Manuel Giriş ══════════════════════════════════ -->
        <mat-tab label="Manuel Giriş">
          <div class="tab-body manual-body">
            <mat-form-field appearance="outline" class="full">
              <mat-label>Yayın Adı</mat-label>
              <input matInput
                     [(ngModel)]="manual.title"
                     [ngModelOptions]="{standalone:true}"
                     maxlength="500"
                     required>
            </mat-form-field>

            <div class="row">
              <mat-form-field appearance="outline" class="grow">
                <mat-label>Başlangıç Tarihi</mat-label>
                <input matInput type="date"
                       [(ngModel)]="manual.startDate"
                       [ngModelOptions]="{standalone:true}"
                       required>
              </mat-form-field>
              <mat-form-field appearance="outline" class="grow">
                <mat-label>Başlangıç Saati</mat-label>
                <input matInput type="time"
                       [(ngModel)]="manual.startTime"
                       [ngModelOptions]="{standalone:true}"
                       required>
              </mat-form-field>
              <mat-form-field appearance="outline" class="grow">
                <mat-label>Bitiş Tarihi</mat-label>
                <input matInput type="date"
                       [(ngModel)]="manual.endDate"
                       [ngModelOptions]="{standalone:true}"
                       required>
              </mat-form-field>
              <mat-form-field appearance="outline" class="grow">
                <mat-label>Bitiş Saati</mat-label>
                <input matInput type="time"
                       [(ngModel)]="manual.endTime"
                       [ngModelOptions]="{standalone:true}"
                       required>
              </mat-form-field>
            </div>

            <div class="row">
              <mat-form-field appearance="outline" class="grow">
                <mat-label>Takım 1</mat-label>
                <input matInput
                       [(ngModel)]="manual.team1Name"
                       [ngModelOptions]="{standalone:true}"
                       maxlength="200">
              </mat-form-field>
              <mat-form-field appearance="outline" class="grow">
                <mat-label>Takım 2</mat-label>
                <input matInput
                       [(ngModel)]="manual.team2Name"
                       [ngModelOptions]="{standalone:true}"
                       maxlength="200">
              </mat-form-field>
            </div>

            <mat-form-field appearance="outline" class="full">
              <mat-label>Operasyon Notları</mat-label>
              <textarea matInput
                        [(ngModel)]="manual.operationNotes"
                        [ngModelOptions]="{standalone:true}"
                        rows="3"
                        maxlength="8000"></textarea>
            </mat-form-field>

            @if (errorMsg() && activeTab === 1) {
              <p class="err">{{ errorMsg() }}</p>
            }
          </div>
        </mat-tab>

      </mat-tab-group>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>İptal</button>
      <button mat-raised-button color="primary"
              [disabled]="saving() || !canSave()"
              (click)="save()">
        @if (saving()) { <mat-spinner diameter="18" style="display:inline-block; vertical-align:middle"></mat-spinner> }
        @else { Kaydet }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .add-dialog-content {
      min-width: min(960px, 92vw);
      max-width: 96vw;
      max-height: 78vh;
      padding: 12px 16px 8px;
      overflow: auto;
    }
    .tab-body { display: flex; flex-direction: column; gap: 8px; padding: 16px 4px 0; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; }
    .row .grow { flex: 1 1 240px; min-width: 0; }
    .full { width: 100%; }
    mat-form-field { width: 100%; }
    .err  { color: #f44336; font-size: 12px; margin: 4px 0 0; }

    .fixture-body { min-height: 380px; }
    .season-chip { color: var(--bp-fg-3); font-size: 11px; margin-left: 6px; }

    .fixtures-section { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
    .fixtures-header {
      display: flex; justify-content: space-between; align-items: center;
      font-size: 12px; color: var(--bp-fg-2);
      border-bottom: 1px solid var(--bp-line-2); padding-bottom: 6px;
    }
    .fixtures-title { font-weight: 600; color: var(--bp-fg-1); letter-spacing: 0.02em; }
    .fixtures-meta  { color: var(--bp-fg-3); }
    .fixtures-list {
      display: flex; flex-direction: column; gap: 4px;
      max-height: 320px; overflow-y: auto; padding-right: 4px;
    }
    .fixture-row {
      display: grid;
      grid-template-columns: 110px 64px 1fr 90px;
      align-items: center; gap: 10px;
      padding: 10px 12px;
      background: var(--bp-bg-2, rgba(255,255,255,0.02));
      border: 1px solid var(--bp-line-2);
      border-radius: 8px;
      text-align: left;
      cursor: pointer;
      font-size: 13px;
      color: var(--bp-fg-1);
      transition: background 0.12s, border-color 0.12s;
    }
    .fixture-row:hover    { background: var(--bp-row-hover, rgba(255,255,255,0.06)); border-color: var(--bp-line-1); }
    .fixture-row.selected {
      background: var(--bp-row-selected, rgba(124, 77, 255, 0.16));
      border-color: var(--bp-accent, #7c4dff);
      box-shadow: inset 0 0 0 1px var(--bp-accent, #7c4dff);
    }
    .fx-date  { color: var(--bp-fg-2); font-variant-numeric: tabular-nums; }
    .fx-time  { color: var(--bp-fg-1); font-variant-numeric: tabular-nums; font-weight: 600; }
    .fx-teams { color: var(--bp-fg-1); }
    .fx-teams em { font-style: normal; color: var(--bp-fg-3); padding: 0 6px; }
    .fx-week  { color: var(--bp-fg-3); font-size: 11px; text-align: right; }
    .fixture-empty {
      min-height: 180px;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      text-align: center;
      color: var(--bp-fg-3);
      font-size: 13px;
      border: 1px dashed var(--bp-line-2);
      border-radius: 8px;
      background: var(--bp-bg-2, rgba(255,255,255,0.02));
    }

    /* Polish — disabled Kaydet butonu Material default'unda mor renkte
       kalıyordu; aktif/disabled ayrımı net görünsün. */
    :host ::ng-deep .mat-mdc-dialog-actions .mat-mdc-raised-button[disabled],
    :host ::ng-deep .mat-mdc-dialog-actions .mat-mdc-raised-button.mat-mdc-button-disabled {
      background-color: rgba(255,255,255,0.08) !important;
      color: rgba(255,255,255,0.42) !important;
      box-shadow: none !important;
    }
    /* Aktif tab vurgusunu güçlendir (Material default contrast düşük). */
    :host ::ng-deep .mat-mdc-tab.mdc-tab--active .mdc-tab__text-label {
      font-weight: 600;
    }
  `],
})
export class LivePlanEntryAddDialogComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<LivePlanEntryAddDialogComponent>);
  private service   = inject(ScheduleService);
  private snack     = inject(MatSnackBar);

  activeTab = 0;
  saving    = signal(false);
  errorMsg  = signal('');

  // ── Fikstürden Seç state ────────────────────────────────────────────────
  broadcastTypes        = signal<BroadcastType[]>([]);
  broadcastTypesLoading = signal(false);
  selectedBroadcastTypeId: number | null = null;

  competitions          = signal<FixtureCompetition[]>([]);
  competitionsLoading   = signal(false);
  /** Composite key: '<competitionId>:<season>' — competition+season çifti
   *  fixture endpoint için iki parametre gerektirir, mat-select tek değer. */
  private _selectedCompetitionCode = signal<string | null>(null);
  selectedCompetitionCode = this._selectedCompetitionCode.asReadonly();

  fixtures        = signal<OptaFixtureRow[]>([]);
  fixturesLoading = signal(false);
  selectedFixtureId = signal<string | null>(null);

  // ── Manuel state ────────────────────────────────────────────────────────
  manual = {
    title:          '',
    startDate:      '',
    startTime:      '',
    endDate:        '',
    endTime:        '',
    team1Name:      '',
    team2Name:      '',
    operationNotes: '',
  };

  canSave(): boolean {
    if (this.activeTab === 0) return !!this.selectedFixtureId();
    const m = this.manual;
    return !!(m.title.trim() && m.startDate && m.startTime && m.endDate && m.endTime);
  }

  /** Derived from active tab: header'da Kaydet butonu enable koşulu
   *  signals'a bağlı olsun diye computed. */
  saveEnabled = computed(() => {
    void this._selectedCompetitionCode();
    void this.selectedFixtureId();
    // saving signal'ı + canSave hesabı template'te yapılıyor; bu computed
    // sadece OnPush ipucu için (template'te [disabled] ifadesi yeterli).
    return !this.saving() && this.canSave();
  });

  ngOnInit(): void {
    this.loadBroadcastTypes();
    this.loadCompetitions();
  }

  // ── Fixture flow ────────────────────────────────────────────────────────
  private loadBroadcastTypes(): void {
    this.broadcastTypesLoading.set(true);
    this.service.getBroadcastTypes().subscribe({
      next: (rows) => { this.broadcastTypes.set(rows ?? []); this.broadcastTypesLoading.set(false); },
      error: () => { this.broadcastTypes.set([]); this.broadcastTypesLoading.set(false); },
    });
  }

  private loadCompetitions(): void {
    this.competitionsLoading.set(true);
    this.service.getFixtureCompetitions().subscribe({
      next: (rows) => { this.competitions.set(rows ?? []); this.competitionsLoading.set(false); },
      error: () => { this.competitions.set([]); this.competitionsLoading.set(false); },
    });
  }

  onCompetitionChange(code: string | null): void {
    this._selectedCompetitionCode.set(code);
    this.selectedFixtureId.set(null);
    this.fixtures.set([]);
    if (!code) return;

    const [competitionId, season] = code.split(':');
    if (!competitionId || !season) return;

    this.fixturesLoading.set(true);
    const fromIso = new Date(`${istanbulTodayDate()}T00:00:00+03:00`).toISOString();
    this.service.getOptaFixtures(competitionId, season, fromIso).subscribe({
      next: (rows) => { this.fixtures.set(rows ?? []); this.fixturesLoading.set(false); },
      error: () => { this.fixtures.set([]); this.fixturesLoading.set(false); },
    });
  }

  selectFixture(matchId: string): void {
    this.selectedFixtureId.set(matchId);
  }

  formatFixtureDate(iso: string): string { return formatIstanbulDateTr(iso); }
  formatFixtureTime(iso: string): string { return formatIstanbulTime(iso); }

  // ── Save ────────────────────────────────────────────────────────────────
  save(): void {
    if (!this.canSave() || this.saving()) return;
    this.saving.set(true);
    this.errorMsg.set('');

    if (this.activeTab === 0) {
      this.saveFromFixture();
      return;
    }
    this.saveManual();
  }

  private saveFromFixture(): void {
    const optaMatchId = this.selectedFixtureId();
    if (!optaMatchId) { this.saving.set(false); return; }

    this.service.createLivePlanFromOpta({ optaMatchId }).subscribe({
      next:  (created) => { this.saving.set(false); this.dialogRef.close(created); },
      error: (e: HttpErrorResponse) => this.handleSaveError(e),
    });
  }

  private saveManual(): void {
    const m = this.manual;
    // Timezone Lock: kullanıcı saatleri Türkiye; composeIstanbulIso ile UTC.
    const startISO = composeIstanbulIso(m.startDate, m.startTime);
    const endISO   = composeIstanbulIso(m.endDate, m.endTime);

    this.service.createLivePlanEntry({
      title:           m.title.trim(),
      eventStartTime:  startISO,
      eventEndTime:    endISO,
      ...(m.team1Name.trim()      ? { team1Name:      m.team1Name.trim() }      : {}),
      ...(m.team2Name.trim()      ? { team2Name:      m.team2Name.trim() }      : {}),
      ...(m.operationNotes.trim() ? { operationNotes: m.operationNotes.trim() } : {}),
    }).subscribe({
      next:  (created) => { this.saving.set(false); this.dialogRef.close(created); },
      error: (e: HttpErrorResponse) => this.handleSaveError(e),
    });
  }

  private handleSaveError(e: HttpErrorResponse): void {
    this.saving.set(false);
    const status = e?.status;
    let msg: string;
    if (status === 409) {
      msg = 'Bu fikstür için zaten aktif kayıt var (çoğaltmak için Çoğalt aksiyonunu kullanın)';
    } else if (status === 404) {
      msg = e?.error?.message ?? 'OPTA match bulunamadı';
    } else if (status === 400) {
      msg = e?.error?.message ?? 'Doğrulama hatası';
    } else if (status === 403) {
      msg = 'Bu işlem için yetki yok';
    } else {
      msg = e?.error?.message ?? e?.message ?? 'Yayın oluşturulamadı';
    }
    this.errorMsg.set(msg);
    this.snack.open(msg, 'Kapat', { duration: 5000 });
  }
}
