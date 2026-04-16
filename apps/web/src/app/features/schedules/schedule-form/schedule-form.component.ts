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

import { ScheduleService } from '../../../core/services/schedule.service';
import { ApiService } from '../../../core/services/api.service';
import type { CreateScheduleDto, UpdateScheduleDto, ScheduleStatus, League, MatchListItem } from '@bcms/shared';

@Component({
  selector: 'app-schedule-form',
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule, RouterLink,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule, MatSnackBarModule, MatCardModule, MatDividerModule,
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

            <!-- ── Maç Seçimi (Opsiyonel) ─────────────────────────────────── -->
            <div class="section-label">
              <mat-icon>sports_soccer</mat-icon>
              <span>Fikstürden Maç Seç <em>(opsiyonel)</em></span>
            </div>

            <div class="match-row">
              <mat-form-field>
                <mat-label>Lig</mat-label>
                <mat-select [value]="selectedLeagueId()" (selectionChange)="onLeagueChange($event.value)">
                  <mat-option [value]="null">— Tümü —</mat-option>
                  @for (lg of leagues(); track lg.id) {
                    <mat-option [value]="lg.id">{{ lg.name }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>

              <mat-form-field>
                <mat-label>Maç</mat-label>
                <mat-select [value]="selectedMatchId()" (selectionChange)="onMatchSelect($event.value)"
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
    .schedule-form { display:flex; flex-direction:column; gap:16px; max-width:680px; }
    .section-label { display:flex; align-items:center; gap:8px; color:#555; font-size:14px; }
    .section-label em { color:#999; font-style:normal; }
    .match-row { display:flex; gap:16px; }
    .match-row mat-form-field { flex:1; }
    .time-row { display:flex; gap:16px; }
    .time-row mat-form-field { flex:1; }
    .form-actions { display:flex; justify-content:flex-end; }
    .conflict-error { display:flex; align-items:center; gap:8px; color:#f44336; padding:8px; border:1px solid #f44336; border-radius:4px; }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    mat-divider { margin: 4px 0; }
  `],
})
export class ScheduleFormComponent implements OnInit {
  form = this.fb.group({
    channelId:  [0,   Validators.required],
    title:      ['',  Validators.required],
    startTime:  ['',  Validators.required],
    endTime:    ['',  Validators.required],
    status:     ['DRAFT'],
  });

  channels        = signal<{ id: number; name: string }[]>([]);
  leagues         = signal<League[]>([]);
  matches         = signal<MatchListItem[]>([]);
  matchesLoading  = signal(false);
  selectedLeagueId = signal<number | null>(null);
  selectedMatchId  = signal<number | null>(null);
  saving          = signal(false);
  isEdit          = false;
  editId          = 0;
  editVersion     = 0;
  conflictError   = signal('');

  constructor(
    private fb: FormBuilder,
    private scheduleSvc: ScheduleService,
    private api: ApiService,
    private router: Router,
    private route: ActivatedRoute,
    private snack: MatSnackBar,
  ) {}

  ngOnInit() {
    this.api.get<{ id: number; name: string }[]>('/channels').subscribe((ch) => this.channels.set(ch));
    this.api.get<League[]>('/matches/leagues').subscribe((lg) => this.leagues.set(lg));

    const id = this.route.snapshot.params['id'];
    if (id) {
      this.isEdit  = true;
      this.editId  = Number(id);
      this.scheduleSvc.getSchedule(this.editId).subscribe((s) => {
        this.editVersion = s.version;
        this.form.patchValue({
          channelId: s.channelId,
          title:     s.title,
          startTime: s.startTime.slice(0, 16),
          endTime:   s.endTime.slice(0, 16),
          status:    s.status,
        });
      });
    }
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

    // Başlık otomatik doldur: "Süper Lig - GS - FB"
    const leagueName = match.league?.name ?? '';
    this.form.patchValue({
      title: `${leagueName} - ${match.homeTeamName} - ${match.awayTeamName}`,
    });

    // Başlangıç saatini maç saatiyle doldur, bitiş = +2 saat
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

    const req$ = this.isEdit
      ? this.scheduleSvc.updateSchedule(this.editId, {
          title:     v.title!,
          startTime: new Date(v.startTime!).toISOString(),
          endTime:   new Date(v.endTime!).toISOString(),
          ...(v.status ? { status: v.status as ScheduleStatus } : {}),
        } satisfies UpdateScheduleDto, this.editVersion)
      : this.scheduleSvc.createSchedule({
          channelId: v.channelId!,
          title:     v.title!,
          startTime: new Date(v.startTime!).toISOString(),
          endTime:   new Date(v.endTime!).toISOString(),
          ...(this.selectedMatchId() ? { metadata: { matchId: this.selectedMatchId() } } : {}),
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
}

// datetime-local input'u için yerel tarih dizgisi üret (YYYY-MM-DDTHH:mm)
function toLocalDatetimeStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
