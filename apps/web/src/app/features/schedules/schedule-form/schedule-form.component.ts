import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatTabsModule } from '@angular/material/tabs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { ScheduleService } from '../../../core/services/schedule.service';
import { ApiService } from '../../../core/services/api.service';
import type {
  CreateScheduleDto, UpdateScheduleDto, ScheduleStatus,
  League, MatchListItem, OptaCompetition, OptaMatch,
} from '@bcms/shared';

@Component({
  selector: 'app-schedule-form',
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule, RouterLink,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule, MatSnackBarModule,
    MatCardModule, MatDividerModule, MatTabsModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <div class="page-container">
      <div class="page-header">
        <h1>{{ isEdit ? 'Programı Düzenle' : 'Yeni Program' }}</h1>
        <a mat-stroked-button routerLink="/schedules">
          <mat-icon>arrow_back</mat-icon> Geri
        </a>
      </div>

      <mat-card>
        <mat-card-content>
          <form [formGroup]="form" (ngSubmit)="submit()" class="schedule-form">

            <!-- ── Maç Kaynağı Sekmeleri ──────────────────────────────────── -->
            <div class="section-label">
              <mat-icon>sports_soccer</mat-icon>
              <span>Maç Seç <em>(opsiyonel)</em></span>
            </div>

            <mat-tab-group animationDuration="150ms" (selectedIndexChange)="onTabChange($event)">

              <!-- Sekme 1: Veritabanı Fikstürü -->
              <mat-tab label="Veritabanı">
                <div class="tab-content">
                  <div class="match-row">
                    <mat-form-field>
                      <mat-label>Lig</mat-label>
                      <mat-select [value]="selectedLeagueId()"
                                  (selectionChange)="onLeagueChange($event.value)">
                        <mat-option [value]="null">— Tümü —</mat-option>
                        @for (lg of leagues(); track lg.id) {
                          <mat-option [value]="lg.id">{{ lg.name }}</mat-option>
                        }
                      </mat-select>
                    </mat-form-field>

                    <mat-form-field>
                      <mat-label>Maç</mat-label>
                      <mat-select [value]="selectedMatchId()"
                                  (selectionChange)="onMatchSelect($event.value)"
                                  [disabled]="matches().length === 0">
                        <mat-option [value]="null">— Maç seçin —</mat-option>
                        @for (m of matches(); track m.id) {
                          <mat-option [value]="m.id">{{ m.label }}</mat-option>
                        }
                      </mat-select>
                      @if (matchesLoading()) {
                        <mat-hint>Yükleniyor...</mat-hint>
                      }
                    </mat-form-field>
                  </div>
                </div>
              </mat-tab>

              <!-- Sekme 2: OPTA Arşivi -->
              <mat-tab label="OPTA Arşivi">
                <div class="tab-content">

                  @if (optaError()) {
                    <div class="opta-error">
                      <mat-icon>error_outline</mat-icon>
                      <span>{{ optaError() }}</span>
                    </div>
                  } @else {

                    <div class="match-row">
                      <mat-form-field>
                        <mat-label>Turnuva / Lig</mat-label>
                        <mat-select [value]="optaCompId()"
                                    (selectionChange)="onOptaCompChange($event.value)"
                                    [disabled]="optaCompsLoading()">
                          <mat-option [value]="null">— Seçin —</mat-option>
                          @for (c of optaComps(); track c.id) {
                            <mat-option [value]="c.id">{{ c.name }}</mat-option>
                          }
                        </mat-select>
                        @if (optaCompsLoading()) {
                          <mat-hint>Yükleniyor...</mat-hint>
                        }
                      </mat-form-field>

                      <mat-form-field>
                        <mat-label>Sezon</mat-label>
                        <mat-select [value]="optaSeason()"
                                    (selectionChange)="onOptaSeasonChange($event.value)"
                                    [disabled]="optaSeasons().length === 0">
                          <mat-option [value]="null">— Seçin —</mat-option>
                          @for (s of optaSeasons(); track s) {
                            <mat-option [value]="s">{{ s }}</mat-option>
                          }
                        </mat-select>
                      </mat-form-field>
                    </div>

                    @if (optaMatchesLoading()) {
                      <div class="loading-row">
                        <mat-spinner diameter="24"></mat-spinner>
                        <span>Maçlar yükleniyor...</span>
                      </div>
                    } @else if (optaMatches().length > 0) {
                      <mat-form-field class="full-width">
                        <mat-label>Maç</mat-label>
                        <mat-select [value]="selectedOptaMatchId()"
                                    (selectionChange)="onOptaMatchSelect($event.value)">
                          <mat-option [value]="null">— Maç seçin —</mat-option>
                          @for (m of optaMatches(); track m.matchId) {
                            <mat-option [value]="m.matchId">
                              {{ m.homeTeamName }} - {{ m.awayTeamName }}
                              &nbsp;({{ m.matchDate | date:'dd MMM yyyy HH:mm' }})
                            </mat-option>
                          }
                        </mat-select>
                      </mat-form-field>
                    }

                    @if (selectedOptaMatch()) {
                      <div class="opta-selected-info">
                        <mat-icon>check_circle</mat-icon>
                        <span>
                          <strong>{{ selectedOptaMatch()!.homeTeamName }} - {{ selectedOptaMatch()!.awayTeamName }}</strong>
                          &nbsp;|&nbsp;{{ selectedOptaMatch()!.competitionName }}
                          &nbsp;|&nbsp;{{ selectedOptaMatch()!.matchDate | date:'dd MMM yyyy HH:mm' }}
                          @if (selectedOptaMatch()!.venue) {
                            &nbsp;|&nbsp;{{ selectedOptaMatch()!.venue }}
                          }
                        </span>
                        <button mat-icon-button type="button" (click)="clearOptaSelection()">
                          <mat-icon>close</mat-icon>
                        </button>
                      </div>
                    }
                  }
                </div>
              </mat-tab>

            </mat-tab-group>

            <mat-divider></mat-divider>

            <!-- ── Program Bilgileri ──────────────────────────────────────── -->
            <mat-form-field>
              <mat-label>Kanal</mat-label>
              <mat-select formControlName="channelId">
                @for (ch of channels(); track ch.id) {
                  <mat-option [value]="ch.id">{{ ch.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>

            <mat-form-field>
              <mat-label>Başlık</mat-label>
              <input matInput formControlName="title" placeholder="Lig A - Takım X vs Takım Y">
              <mat-error>Başlık zorunludur</mat-error>
            </mat-form-field>

            <div class="time-row">
              <mat-form-field>
                <mat-label>Başlangıç Zamanı</mat-label>
                <input matInput type="datetime-local" formControlName="startTime">
                <mat-error>Geçerli bir tarih giriniz</mat-error>
              </mat-form-field>

              <mat-form-field>
                <mat-label>Bitiş Zamanı</mat-label>
                <input matInput type="datetime-local" formControlName="endTime">
                <mat-error>Geçerli bir tarih giriniz</mat-error>
              </mat-form-field>
            </div>

            @if (isEdit) {
              <mat-form-field>
                <mat-label>Durum</mat-label>
                <mat-select formControlName="status">
                  <mat-option value="DRAFT">Taslak</mat-option>
                  <mat-option value="CONFIRMED">Onaylandı</mat-option>
                  <mat-option value="CANCELLED">İptal</mat-option>
                </mat-select>
              </mat-form-field>
            }

            @if (conflictError()) {
              <div class="conflict-error">
                <mat-icon>warning</mat-icon>
                <span>{{ conflictError() }}</span>
              </div>
            }

            <div class="form-actions">
              <button mat-raised-button color="primary" type="submit" [disabled]="form.invalid || saving()">
                @if (saving()) { <mat-icon class="spin">sync</mat-icon> }
                {{ isEdit ? 'Güncelle' : 'Oluştur' }}
              </button>
            </div>
          </form>
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: [`
    .page-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
    .schedule-form { display:flex; flex-direction:column; gap:16px; max-width:720px; }
    .section-label { display:flex; align-items:center; gap:8px; color:#555; font-size:14px; }
    .section-label em { color:#999; font-style:normal; }
    .tab-content { padding:16px 0 8px; }
    .match-row { display:flex; gap:16px; }
    .match-row mat-form-field { flex:1; }
    .full-width { width:100%; }
    .time-row { display:flex; gap:16px; }
    .time-row mat-form-field { flex:1; }
    .form-actions { display:flex; justify-content:flex-end; }
    .conflict-error { display:flex; align-items:center; gap:8px; color:#f44336; padding:8px; border:1px solid #f44336; border-radius:4px; }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    mat-divider { margin:4px 0; }
    .loading-row { display:flex; align-items:center; gap:10px; color:#666; font-size:13px; padding:8px 0; }
    .opta-selected-info {
      display:flex; align-items:center; gap:8px;
      background:#e8f5e9; border:1px solid #a5d6a7; border-radius:8px;
      padding:8px 12px; font-size:13px; color:#2e7d32; margin-top:8px;
    }
    .opta-selected-info mat-icon { color:#43a047; font-size:18px; height:18px; width:18px; flex-shrink:0; }
    .opta-selected-info button { margin-left:auto; }
    .opta-error { display:flex; align-items:center; gap:8px; color:#b71c1c; padding:8px; }
  `],
})
export class ScheduleFormComponent implements OnInit {
  form = this.fb.group({
    channelId:  [0, [Validators.required, Validators.min(1)]],
    title:      ['',  Validators.required],
    startTime:  ['',  Validators.required],
    endTime:    ['',  Validators.required],
    status:     ['DRAFT'],
  });

  // Veritabanı fikstür sinyalleri
  channels         = signal<{ id: number; name: string }[]>([]);
  leagues          = signal<League[]>([]);
  matches          = signal<MatchListItem[]>([]);
  matchesLoading   = signal(false);
  selectedLeagueId = signal<number | null>(null);
  selectedMatchId  = signal<number | null>(null);

  // OPTA sinyalleri
  optaComps            = signal<OptaCompetition[]>([]);
  optaCompsLoading     = signal(false);
  optaCompId           = signal<string | null>(null);
  optaSeasons          = signal<string[]>([]);
  optaSeason           = signal<string | null>(null);
  optaMatches          = signal<OptaMatch[]>([]);
  optaMatchesLoading   = signal(false);
  selectedOptaMatchId  = signal<string | null>(null);
  selectedOptaMatch    = signal<OptaMatch | null>(null);
  optaError            = signal('');

  saving        = signal(false);
  isEdit        = false;
  editId        = 0;
  editVersion   = 0;
  conflictError = signal('');

  constructor(
    private fb: FormBuilder,
    private scheduleSvc: ScheduleService,
    private api: ApiService,
    private router: Router,
    private route: ActivatedRoute,
    private snack: MatSnackBar,
  ) {}

  ngOnInit() {
    // HIGH-FE-008 fix (2026-05-05): subscribe'lara error handler eklendi.
    // Aksi halde RxJS unhandled error → console error + bazı durumlarda zone
    // exception, kullanıcıya feedback yok.
    this.api.get<{ id: number; name: string }[]>('/channels/catalog').subscribe({
      next:  (ch)  => this.channels.set(ch),
      error: (err) => this.snack.open('Kanal listesi yüklenemedi', 'Kapat', { duration: 4000 }),
    });
    this.api.get<League[]>('/matches/leagues').subscribe({
      next:  (lg)  => this.leagues.set(lg),
      error: (err) => this.snack.open('Lig listesi yüklenemedi', 'Kapat', { duration: 4000 }),
    });

    const id = this.route.snapshot.params['id'];
    if (id) {
      const numericId = Number(id);
      if (!Number.isFinite(numericId) || numericId <= 0) {
        this.snack.open('Geçersiz schedule ID', 'Kapat', { duration: 4000 });
        return;
      }
      this.isEdit  = true;
      this.editId  = numericId;
      this.scheduleSvc.getSchedule(this.editId).subscribe({
        next: (s) => {
          this.editVersion = s.version;
          this.form.patchValue({
            channelId: s.channelId,
            title:     s.title,
            startTime: s.startTime.slice(0, 16),
            endTime:   s.endTime.slice(0, 16),
            status:    s.status,
          });
        },
        error: () => this.snack.open('Yayın kaydı yüklenemedi', 'Kapat', { duration: 4000 }),
      });
    }
  }

  // OPTA sekmesi ilk açıldığında competition listesini yükle
  onTabChange(index: number) {
    if (index === 1 && this.optaComps().length === 0 && !this.optaCompsLoading()) {
      this.loadOptaCompetitions();
    }
  }

  private loadOptaCompetitions() {
    this.optaCompsLoading.set(true);
    this.optaError.set('');
    this.api.get<OptaCompetition[]>('/opta/competitions').subscribe({
      next: (comps) => {
        this.optaComps.set(comps);
        this.optaCompsLoading.set(false);
      },
      error: () => {
        this.optaError.set('OPTA arşivine erişilemedi. SMB bağlantısını kontrol edin.');
        this.optaCompsLoading.set(false);
      },
    });
  }

  onOptaCompChange(compId: string | null) {
    this.optaCompId.set(compId);
    this.optaSeason.set(null);
    this.optaMatches.set([]);
    this.selectedOptaMatchId.set(null);
    this.selectedOptaMatch.set(null);

    if (!compId) { this.optaSeasons.set([]); return; }

    const comp = this.optaComps().find((c) => c.id === compId);
    const seasons = comp ? [...comp.seasons].sort().reverse() : [];
    this.optaSeasons.set(seasons);

    if (seasons.length === 1) this.onOptaSeasonChange(seasons[0]);
  }

  onOptaSeasonChange(season: string | null) {
    this.optaSeason.set(season);
    this.optaMatches.set([]);
    this.selectedOptaMatchId.set(null);
    this.selectedOptaMatch.set(null);

    if (!season || !this.optaCompId()) return;

    this.optaMatchesLoading.set(true);
    this.api.get<OptaMatch[]>(`/opta/matches?competitionId=${this.optaCompId()}&season=${season}`).subscribe({
      next: (ms) => { this.optaMatches.set(ms); this.optaMatchesLoading.set(false); },
      error: ()  => { this.optaMatchesLoading.set(false); },
    });
  }

  onOptaMatchSelect(matchId: string | null) {
    this.selectedOptaMatchId.set(matchId);
    const match = this.optaMatches().find((m) => m.matchId === matchId) ?? null;
    this.selectedOptaMatch.set(match);
    if (!match) return;

    this.form.patchValue({
      title: `${match.competitionName} - ${match.homeTeamName} - ${match.awayTeamName}`,
    });
    const dt  = new Date(match.matchDate);
    const end = new Date(dt.getTime() + 2 * 60 * 60 * 1000);
    this.form.patchValue({
      startTime: toLocalDatetimeStr(dt),
      endTime:   toLocalDatetimeStr(end),
    });
  }

  clearOptaSelection() {
    this.selectedOptaMatchId.set(null);
    this.selectedOptaMatch.set(null);
  }

  onLeagueChange(leagueId: number | null) {
    this.selectedLeagueId.set(leagueId);
    this.selectedMatchId.set(null);
    this.matches.set([]);
    if (!leagueId) return;

    this.matchesLoading.set(true);
    this.api.get<MatchListItem[]>(`/matches?leagueId=${leagueId}`).subscribe({
      next:  (ms) => { this.matches.set(ms); this.matchesLoading.set(false); },
      error: ()   => { this.matchesLoading.set(false); },
    });
  }

  onMatchSelect(matchId: number | null) {
    this.selectedMatchId.set(matchId);
    if (!matchId) return;

    const match = this.matches().find((m) => m.id === matchId);
    if (!match) return;

    const leagueName = match.league?.name ?? '';
    this.form.patchValue({
      title: `${leagueName} - ${match.homeTeamName} - ${match.awayTeamName}`,
    });
    const matchDt = new Date(match.matchDate);
    const endDt   = new Date(matchDt.getTime() + 2 * 60 * 60 * 1000);
    this.form.patchValue({
      startTime: toLocalDatetimeStr(matchDt),
      endTime:   toLocalDatetimeStr(endDt),
    });
  }

  submit() {
    if (this.form.invalid) return;
    this.saving.set(true);
    this.conflictError.set('');

    const v = this.form.value;

    const optaMeta = this.selectedOptaMatch()
      ? { optaMatchId: this.selectedOptaMatch()!.matchId, source: 'opta' }
      : this.selectedMatchId()
        ? { matchId: this.selectedMatchId(), source: 'db' }
        : undefined;

    // HIGH-FE-007 fix (2026-05-05): safeToIso geçersiz tarih için throw eder.
    // submit() içinde try/catch ile yakalayıp UI'ı reset edilmeli; aksi halde
    // saving=true kilitli kalır, kullanıcı butona tekrar basamaz.
    let startISO: string;
    let endISO: string;
    try {
      startISO = this.safeToIso(v.startTime!);
      endISO   = this.safeToIso(v.endTime!);
    } catch {
      this.saving.set(false);
      this.snack.open('Geçersiz tarih/saat', 'Kapat', { duration: 4000 });
      return;
    }

    const req$ = this.isEdit
      ? this.scheduleSvc.updateSchedule(this.editId, {
          title:     v.title!,
          startTime: startISO,
          endTime:   endISO,
          ...(v.status ? { status: v.status as ScheduleStatus } : {}),
        } satisfies UpdateScheduleDto, this.editVersion)
      : this.scheduleSvc.createSchedule({
          channelId: v.channelId!,
          title:     v.title!,
          startTime: startISO,
          endTime:   endISO,
          ...(optaMeta ? { metadata: optaMeta } : {}),
        } satisfies CreateScheduleDto);

    req$.subscribe({
      next: () => {
        this.snack.open(this.isEdit ? 'Güncellendi' : 'Oluşturuldu', 'Tamam', { duration: 3000 });
        this.router.navigate(['/schedules']);
      },
      error: (err) => {
        this.saving.set(false);
        if (err.status === 409) {
          this.conflictError.set('Çakışan program var! Zaman dilimini kontrol ediniz.');
        } else if (err.status === 412) {
          this.conflictError.set('Versiyon çakışması — lütfen sayfayı yenileyip tekrar deneyin.');
        } else {
          this.snack.open('Hata oluştu', 'Kapat', { duration: 4000 });
        }
      },
    });
  }

  private safeToIso(value: string): string {
    const d = new Date(value);
    if (isNaN(d.getTime())) {
      throw new Error('Geçersiz tarih');
    }
    return d.toISOString();
  }
}

function toLocalDatetimeStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
