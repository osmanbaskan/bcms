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
import { MatCheckboxModule } from '@angular/material/checkbox';

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
import type { Schedule } from '@bcms/shared';

/**
 * 2026-05-12 update: çoklu OPTA fixture seçim + İçerik Türü kapısı.
 *
 * "Fikstürden Seç" sekmesi yalnız İçerik Türü = Müsabaka iken devreye girer
 * (Müsabaka = BroadcastType.code === 'MATCH'; description fallback "Müsab*"
 * desteklenir). Müsabaka seçili değilse Lig/Hafta/fikstür/Kaydet disabled.
 *
 * Lig + opsiyonel Hafta filtresi sonrası operatör birden fazla fixture
 * seçer (multi-select). Save: seçili her optaMatchId için sırayla
 * POST /api/v1/live-plan/from-opta — 409 (duplicate) batch'i bozmaz,
 * ayrı listede özetlenir.
 *
 * Backend DTO değişmez; İçerik Türü payload'a girmez.
 */

interface BatchResults {
  created:    Schedule[];
  duplicates: string[];                                  // 409
  errors:     Array<{ id: string; message: string }>;    // 400/403/404/5xx
}

/** 2026-05-12: `broadcast_types` seed boş kalan kurulumlar için fallback.
 *  Backend response'unda code='MATCH' veya description 'Müsab*' yoksa
 *  dropdown'a sentinel ile eklenir. Sentinel `id = -1`; create payload'a
 *  girmediği için backend FK çakışması riski yok. */
const FALLBACK_MUSABAKA: BroadcastType = { id: -1, code: 'MATCH', description: 'Müsabaka' };

function isMatchType(bt: BroadcastType): boolean {
  return bt.code === 'MATCH' || (bt.description ?? '').toLowerCase().startsWith('müsab');
}

@Component({
  selector: 'app-live-plan-entry-add-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule,
    MatDialogModule, MatProgressSpinnerModule,
    MatSnackBarModule, MatTabsModule, MatDividerModule,
    MatCheckboxModule,
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
                <mat-select [ngModel]="selectedBroadcastTypeId()"
                            (ngModelChange)="onBroadcastTypeChange($event)"
                            [ngModelOptions]="{standalone:true}"
                            [disabled]="broadcastTypesLoading() || saving()">
                  <mat-option [value]="null">— Seçin —</mat-option>
                  @for (bt of displayBroadcastTypes(); track bt.id) {
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
                            [disabled]="!isOptaMode() || competitionsLoading() || saving()">
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

              <mat-form-field appearance="outline" class="grow">
                <mat-label>Hafta</mat-label>
                <mat-select [ngModel]="selectedWeek()"
                            (ngModelChange)="onWeekChange($event)"
                            [ngModelOptions]="{standalone:true}"
                            [disabled]="!isOptaMode() || !selectedCompetitionCode() || fixturesLoading() || saving() || fixtures().length === 0">
                  <mat-option [value]="null">— Tüm Haftalar —</mat-option>
                  @for (w of availableWeeks(); track w) {
                    <mat-option [value]="w">{{ w }}. Hafta</mat-option>
                  }
                </mat-select>
              </mat-form-field>
            </div>

            <div class="fixtures-section">
              <div class="fixtures-header">
                <div class="fixtures-header-left">
                  <span class="fixtures-title">Fikstür</span>
                  <mat-checkbox class="select-all"
                                [disabled]="selectAllDisabled()"
                                [checked]="allFilteredSelected()"
                                [indeterminate]="someFilteredSelected() && !allFilteredSelected()"
                                (change)="toggleAllVisible()">
                    Tümünü Seç
                  </mat-checkbox>
                </div>
                <span class="fixtures-meta">
                  @if (!isOptaMode()) {
                    İçerik Türü = Müsabaka seçin
                  } @else if (fixturesLoading()) {
                    yükleniyor…
                  } @else if (!selectedCompetitionCode()) {
                    lig seçin
                  } @else if (filteredFixtures().length === 0) {
                    gelecek fikstür yok
                  } @else {
                    {{ filteredFixtures().length }} maç · Seçilen: {{ selectedCount() }}
                  }
                </span>
              </div>

              <div class="fixtures-list">
                @if (!isOptaMode()) {
                  <div class="fixture-empty">
                    OPTA fikstürü için İçerik Türü olarak Müsabaka seçin.
                  </div>
                } @else if (fixturesLoading()) {
                  <div class="fixture-empty"><mat-spinner diameter="20"></mat-spinner></div>
                } @else if (!selectedCompetitionCode()) {
                  <div class="fixture-empty">Lig/Turnuva seçince fikstür listelenir.</div>
                } @else if (filteredFixtures().length === 0) {
                  <div class="fixture-empty">Bu seçim için gelecek fikstür bulunamadı.</div>
                } @else {
                  @for (f of filteredFixtures(); track f.matchId) {
                    <button type="button"
                            class="fixture-row"
                            [class.selected]="isFixtureSelected(f.matchId)"
                            [disabled]="saving()"
                            (click)="toggleFixture(f.matchId)">
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
        @if (saving()) {
          <mat-spinner diameter="18" style="display:inline-block; vertical-align:middle"></mat-spinner>
        } @else {
          {{ saveButtonLabel() }}
        }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .add-dialog-content {
      min-width: min(960px, 92vw);
      max-width: 96vw;
      /* 2026-05-12: dikey yükseklik ~%50 artışı — fixture listesi nefes alsın.
         1366x768'de viewport'a sığar (88vh ≈ 676px, dialog actions + header
         hariç içerik ~580px). */
      max-height: 88vh;
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
      gap: 12px; flex-wrap: wrap;
    }
    .fixtures-header-left {
      display: flex; align-items: center; gap: 14px;
    }
    .fixtures-title { font-weight: 600; color: var(--bp-fg-1); letter-spacing: 0.02em; }
    .fixtures-meta  { color: var(--bp-fg-3); }
    .select-all { font-size: 12px; }
    :host ::ng-deep .select-all .mdc-form-field { font-size: 12px; }
    .fixtures-list {
      display: flex; flex-direction: column; gap: 4px;
      /* 2026-05-12: liste yüksekliği ~%50 artışı (320 → 480). */
      max-height: 480px; overflow-y: auto; padding-right: 4px;
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
    .fixture-row[disabled] { opacity: 0.55; cursor: not-allowed; }
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

    :host ::ng-deep .mat-mdc-dialog-actions .mat-mdc-raised-button[disabled],
    :host ::ng-deep .mat-mdc-dialog-actions .mat-mdc-raised-button.mat-mdc-button-disabled {
      background-color: rgba(255,255,255,0.08) !important;
      color: rgba(255,255,255,0.42) !important;
      box-shadow: none !important;
    }
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
  broadcastTypes          = signal<BroadcastType[]>([]);
  broadcastTypesLoading   = signal(false);
  selectedBroadcastTypeId = signal<number | null>(null);

  competitions             = signal<FixtureCompetition[]>([]);
  competitionsLoading      = signal(false);
  selectedCompetitionCode  = signal<string | null>(null);

  fixtures        = signal<OptaFixtureRow[]>([]);
  fixturesLoading = signal(false);

  /** null = Tüm Haftalar; spesifik hafta = weekNumber. */
  selectedWeek    = signal<number | null>(null);

  /** Çoklu seçim. Set primitif olduğu için signal'ı yeni Set ile günceller. */
  selectedFixtureIds = signal<Set<string>>(new Set());

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

  // ── Computed ────────────────────────────────────────────────────────────
  /** Dropdown'da gösterilecek liste: backend response + fallback Müsabaka
   *  (backend zaten MATCH/Müsabaka döndürdüyse duplicate eklenmez). */
  displayBroadcastTypes = computed<BroadcastType[]>(() => {
    const fromApi = this.broadcastTypes();
    const hasMatch = fromApi.some(isMatchType);
    return hasMatch ? fromApi : [FALLBACK_MUSABAKA, ...fromApi];
  });

  /** İçerik Türü "Müsabaka" mı? code='MATCH' canonical; description fallback
   *  "Müsab"* prefix'iyle daha esnek (seed/Türkçe label varyasyonları için).
   *  Sentinel fallback (id=-1) de aynı kontrolden geçer (code='MATCH'). */
  isOptaMode = computed(() => {
    const id = this.selectedBroadcastTypeId();
    if (id == null) return false;
    const bt = this.displayBroadcastTypes().find((b) => b.id === id);
    if (!bt) return false;
    return isMatchType(bt);
  });

  /** fixtures listesinden distinct weekNumber (null hariç), artan sıralı. */
  availableWeeks = computed(() => {
    const weeks = new Set<number>();
    for (const f of this.fixtures()) {
      if (f.weekNumber != null) weeks.add(f.weekNumber);
    }
    return Array.from(weeks).sort((a, b) => a - b);
  });

  /** Hafta filtresi:
   *   - null (Tüm Haftalar) → tüm fixture'lar (weekNumber null dahil)
   *   - spesifik hafta      → sadece o haftaya ait fixture'lar (null hariç) */
  filteredFixtures = computed(() => {
    const all = this.fixtures();
    const week = this.selectedWeek();
    if (week == null) return all;
    return all.filter((f) => f.weekNumber === week);
  });

  selectedCount = computed(() => this.selectedFixtureIds().size);

  /** Görünen (week filter uygulanmış) fixture'ların tamamı seçili mi. */
  allFilteredSelected = computed(() => {
    const visible = this.filteredFixtures();
    if (visible.length === 0) return false;
    const sel = this.selectedFixtureIds();
    return visible.every((f) => sel.has(f.matchId));
  });

  /** Görünenlerden en az biri seçili mi (indeterminate hesabı için). */
  someFilteredSelected = computed(() => {
    const sel = this.selectedFixtureIds();
    return this.filteredFixtures().some((f) => sel.has(f.matchId));
  });

  selectAllDisabled = computed(() =>
    !this.isOptaMode()
    || !this.selectedCompetitionCode()
    || this.fixturesLoading()
    || this.filteredFixtures().length === 0
    || this.saving(),
  );

  saveButtonLabel = computed(() => {
    if (this.activeTab === 0) {
      const n = this.selectedCount();
      return n > 0 ? `${n} Kaydı Ekle` : 'Kaydet';
    }
    return 'Kaydet';
  });

  // ── Save enable ─────────────────────────────────────────────────────────
  canSave(): boolean {
    if (this.activeTab === 0) {
      return this.isOptaMode() && this.selectedFixtureIds().size > 0;
    }
    const m = this.manual;
    return !!(m.title.trim() && m.startDate && m.startTime && m.endDate && m.endTime);
  }

  ngOnInit(): void {
    this.loadBroadcastTypes();
    this.loadCompetitions();
  }

  // ── Loaders ─────────────────────────────────────────────────────────────
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

  // ── Handlers ────────────────────────────────────────────────────────────
  onBroadcastTypeChange(id: number | null): void {
    this.selectedBroadcastTypeId.set(id);
    // İçerik Türü değişince lig/hafta/fixture/selection reset (Müsabaka değilse zaten disabled).
    this.selectedCompetitionCode.set(null);
    this.selectedWeek.set(null);
    this.fixtures.set([]);
    this.selectedFixtureIds.set(new Set());
  }

  onCompetitionChange(code: string | null): void {
    this.selectedCompetitionCode.set(code);
    this.selectedWeek.set(null);
    this.selectedFixtureIds.set(new Set());
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

  onWeekChange(week: number | null): void {
    this.selectedWeek.set(week);
    // Filter sonrası görünmeyen seçimleri ayıklamaya gerek yok: backend için
    // matchId hâlâ geçerli (gizli olsa bile operatör daha önce seçtiyse niyet
    // kasıtlı). Operatör kaldırmak isterse Tüm Haftalar'a dön + tıkla.
  }

  isFixtureSelected(matchId: string): boolean {
    return this.selectedFixtureIds().has(matchId);
  }

  toggleFixture(matchId: string): void {
    const next = new Set(this.selectedFixtureIds());
    if (next.has(matchId)) next.delete(matchId);
    else next.add(matchId);
    this.selectedFixtureIds.set(next);
  }

  /** "Tümünü Seç" toggle — yalnız görünen (week filter uygulanmış) fixture'ları
   *  etkiler. Tamamı seçiliyse → görünen seçimleri kaldır; değilse → görünenleri
   *  ekle. Görünmeyen (gizli) seçimler korunur. */
  toggleAllVisible(): void {
    if (this.selectAllDisabled()) return;
    const visible = this.filteredFixtures();
    const next = new Set(this.selectedFixtureIds());
    const allSelected = this.allFilteredSelected();
    if (allSelected) {
      for (const f of visible) next.delete(f.matchId);
    } else {
      for (const f of visible) next.add(f.matchId);
    }
    this.selectedFixtureIds.set(next);
  }

  formatFixtureDate(iso: string): string { return formatIstanbulDateTr(iso); }
  formatFixtureTime(iso: string): string { return formatIstanbulTime(iso); }

  // ── Save ────────────────────────────────────────────────────────────────
  save(): void {
    if (!this.canSave() || this.saving()) return;
    this.saving.set(true);
    this.errorMsg.set('');

    if (this.activeTab === 0) {
      const ids = Array.from(this.selectedFixtureIds());
      const results: BatchResults = { created: [], duplicates: [], errors: [] };
      this.batchFromOpta(ids, 0, results);
      return;
    }
    this.saveManual();
  }

  /** Sıralı recursive subscribe — `of(...)` ile mock'lar sync olduğu için
   *  Karma timing'i deterministik; production HttpClient ile network sırası
   *  korunur. */
  private batchFromOpta(ids: string[], i: number, results: BatchResults): void {
    if (i >= ids.length) {
      this.finalizeBatch(results);
      return;
    }
    const id = ids[i];
    this.service.createLivePlanFromOpta({ optaMatchId: id }).subscribe({
      next: (created) => {
        results.created.push(created);
        this.batchFromOpta(ids, i + 1, results);
      },
      error: (e: HttpErrorResponse) => {
        if (e?.status === 409) {
          results.duplicates.push(id);
        } else {
          const msg = e?.error?.message ?? this.statusMessage(e?.status) ?? 'Hata';
          results.errors.push({ id, message: msg });
        }
        this.batchFromOpta(ids, i + 1, results);
      },
    });
  }

  private finalizeBatch(r: BatchResults): void {
    this.saving.set(false);
    const okCount   = r.created.length;
    const dupCount  = r.duplicates.length;
    const errCount  = r.errors.length;

    const parts: string[] = [];
    if (okCount  > 0) parts.push(`${okCount} kayıt oluşturuldu`);
    if (dupCount > 0) parts.push(`${dupCount} mevcut (atlandı)`);
    if (errCount > 0) parts.push(`${errCount} hata`);
    const summary = parts.join(' · ') || 'Sonuç yok';

    if (okCount > 0) {
      this.snack.open(summary, 'Kapat', { duration: 5500 });
      // En az bir başarı → dialog kapanır, list reload tetiklenir.
      this.dialogRef.close({ created: r.created, duplicates: r.duplicates, errors: r.errors });
      return;
    }
    // Hiç başarı yok → dialog açık kalır, durum gösterilir.
    this.errorMsg.set(summary);
    this.snack.open(summary, 'Kapat', { duration: 5500 });
  }

  private statusMessage(status?: number): string | null {
    if (status === 404) return 'OPTA match bulunamadı';
    if (status === 400) return 'Doğrulama hatası';
    if (status === 403) return 'Bu işlem için yetki yok';
    return null;
  }

  private saveManual(): void {
    const m = this.manual;
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
      error: (e: HttpErrorResponse) => this.handleManualError(e),
    });
  }

  private handleManualError(e: HttpErrorResponse): void {
    this.saving.set(false);
    const status = e?.status;
    let msg: string;
    if (status === 400) msg = e?.error?.message ?? 'Doğrulama hatası';
    else if (status === 403) msg = 'Bu işlem için yetki yok';
    else msg = e?.error?.message ?? e?.message ?? 'Yayın oluşturulamadı';
    this.errorMsg.set(msg);
    this.snack.open(msg, 'Kapat', { duration: 4000 });
  }
}
