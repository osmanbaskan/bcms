import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ApiService } from '../../core/services/api.service';
import { YayinPlanlamaService } from '../../core/services/yayin-planlama.service';
import {
  SCHEDULE_LOOKUP_TYPES,
  type CreateBroadcastScheduleDto,
  type Schedule,
  type ScheduleLookupOption,
  type UpdateBroadcastScheduleDto,
} from '@bcms/shared';
import type { LivePlanEntry } from '../live-plan/live-plan.types';
import { LivePlanEntryPickerDialog } from './live-plan-entry-picker.dialog';

/**
 * SCHED-B4 — Yayın Planlama Create/Edit form (page-level).
 *
 * Routes:
 *   /yayin-planlama/new           → create mode (picker zorunlu)
 *   /yayin-planlama/:id/edit      → edit mode (entry değiştirilemez; K-B3)
 *
 * Body: backend /schedules/broadcast contract
 *   create: eventKey + selectedLivePlanEntryId + scheduleDate + scheduleTime
 *           + 3 channel slot? + 3 lookup option?
 *   update: yukarıdaki ekonomi (eventKey + entry değişmez); scheduleDate/Time
 *           + slotlar update edilir.
 *
 * Lookup type stringleri sadece SHARED const üzerinden gelir; magic string yok.
 *
 * Channel duplicate validation: 3 slot farklı olmak zorunda (CHECK 23514
 * backend zaten engeller; frontend pre-check UX).
 */

interface ChannelOption { id: number; name: string; }

@Component({
  selector: 'app-yayin-planlama-form',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink, MatCardModule, MatFormFieldModule,
    MatInputModule, MatSelectModule, MatButtonModule, MatIconModule,
    MatDialogModule, MatProgressSpinnerModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <button mat-icon-button routerLink="/yayin-planlama" aria-label="Geri">
          <mat-icon>arrow_back</mat-icon>
        </button>
        <h1>{{ isEdit() ? 'Yayın Planlama Düzenle' : 'Yeni Yayın Planlama' }}</h1>
      </div>

      @if (loading()) {
        <div class="state state-loading">
          <mat-progress-spinner mode="indeterminate" diameter="32"></mat-progress-spinner>
          <span>Yükleniyor…</span>
        </div>
      } @else {
        <mat-card class="form-card">
          <form (submit)="submit($event)" #f="ngForm" novalidate>
            <!-- ── Live-plan entry seçimi (create-only picker; edit read-only) ── -->
            <section class="section">
              <h2>Canlı Yayın Plan</h2>
              <div class="entry-row">
                <div class="entry-summary">
                  @if (selectedEntry()) {
                    <div class="entry-title">{{ selectedEntry()!.title }}</div>
                    @if (selectedEntry()!.team1Name && selectedEntry()!.team2Name) {
                      <div class="entry-teams">
                        {{ selectedEntry()!.team1Name }} vs {{ selectedEntry()!.team2Name }}
                      </div>
                    }
                    <div class="entry-meta">
                      <span class="event-key">{{ selectedEntry()!.eventKey || '—' }}</span>
                      @if (selectedEntry()!.sourceType) {
                        <span class="source-badge">{{ selectedEntry()!.sourceType }}</span>
                      }
                    </div>
                  } @else {
                    <div class="entry-empty">Seçim yapılmadı</div>
                  }
                </div>
                @if (!isEdit()) {
                  <button mat-stroked-button type="button" (click)="openPicker()">
                    <mat-icon>list</mat-icon>
                    {{ selectedEntry() ? 'Değiştir' : 'Seç' }}
                  </button>
                }
              </div>
            </section>

            <!-- ── Tarih + Saat ── -->
            <section class="section">
              <h2>Yayın Zamanı</h2>
              <div class="row">
                <mat-form-field appearance="outline">
                  <mat-label>Tarih</mat-label>
                  <input matInput type="date" name="scheduleDate"
                         [(ngModel)]="scheduleDate" required />
                </mat-form-field>
                <mat-form-field appearance="outline">
                  <mat-label>Saat</mat-label>
                  <input matInput type="time" name="scheduleTime"
                         [(ngModel)]="scheduleTime" required />
                </mat-form-field>
              </div>
            </section>

            <!-- ── Kanal slotları (3 adet, duplicate yasak) ── -->
            <section class="section">
              <h2>Kanal Atamaları</h2>
              <div class="row">
                @for (slot of channelSlots; track slot.field) {
                  <mat-form-field appearance="outline">
                    <mat-label>{{ slot.label }}</mat-label>
                    <mat-select [(ngModel)]="channels[slot.field]" [name]="slot.field">
                      <mat-option [value]="null">(boş)</mat-option>
                      @for (c of channels$(); track c.id) {
                        <mat-option [value]="c.id">{{ c.name }}</mat-option>
                      }
                    </mat-select>
                  </mat-form-field>
                }
              </div>
              @if (channelDuplicateError()) {
                <div class="field-error">
                  <mat-icon>error_outline</mat-icon>
                  Aynı kanal birden fazla slotta seçilemez.
                </div>
              }
            </section>

            <!-- ── 3 Lookup option ── -->
            <section class="section">
              <h2>Yayın Detayları</h2>
              <div class="row">
                <mat-form-field appearance="outline">
                  <mat-label>Reklam Seçeneği</mat-label>
                  <mat-select [(ngModel)]="commercialOptionId" name="commercialOptionId">
                    <mat-option [value]="null">(boş)</mat-option>
                    @for (o of commercialOptions(); track o.id) {
                      <mat-option [value]="o.id">{{ o.label }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
                <mat-form-field appearance="outline">
                  <mat-label>Logo Seçeneği</mat-label>
                  <mat-select [(ngModel)]="logoOptionId" name="logoOptionId">
                    <mat-option [value]="null">(boş)</mat-option>
                    @for (o of logoOptions(); track o.id) {
                      <mat-option [value]="o.id">{{ o.label }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
                <mat-form-field appearance="outline">
                  <mat-label>Format Seçeneği</mat-label>
                  <mat-select [(ngModel)]="formatOptionId" name="formatOptionId">
                    <mat-option [value]="null">(boş)</mat-option>
                    @for (o of formatOptions(); track o.id) {
                      <mat-option [value]="o.id">{{ o.label }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
              </div>
            </section>

            @if (submitError()) {
              <div class="form-error">
                <mat-icon>error_outline</mat-icon>
                {{ submitError() }}
              </div>
            }

            <div class="actions">
              <button mat-button type="button" routerLink="/yayin-planlama">İptal</button>
              <button mat-raised-button color="primary" type="submit"
                      [disabled]="submitting() || !canSubmit()">
                {{ isEdit() ? 'Güncelle' : 'Kaydet' }}
              </button>
            </div>
          </form>
        </mat-card>
      }
    </div>
  `,
  styles: [`
    .page { padding: 24px; max-width: 960px; margin: 0 auto; }
    .page-header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
    .page-header h1 { margin: 0; font-size: 20px; font-weight: 600; }
    .form-card { padding: 24px; }
    .section { margin-bottom: 24px; }
    .section h2 { font-size: 15px; font-weight: 600; margin: 0 0 12px; color: var(--mat-sys-on-surface-variant); }
    .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    .entry-row { display: flex; align-items: center; gap: 16px; padding: 12px; background: var(--mat-sys-surface-container-low); border-radius: 4px; flex-wrap: wrap; }
    .entry-summary { flex: 1 1 280px; min-width: 0; }
    .entry-row > button { flex-shrink: 0; }
    @media (max-width: 600px) {
      // Mobile: entry-summary butonun click alanını overlap etmesin (Pixel 7
      // viewport 412px; flex row'da text growth pointer-event intercept ederdi).
      .entry-row { flex-direction: column; align-items: stretch; }
      .entry-row > button { width: 100%; }
    }
    .entry-title { font-weight: 500; }
    .entry-teams { font-size: 13px; color: var(--mat-sys-on-surface-variant); }
    .entry-meta { display: flex; gap: 8px; align-items: center; margin-top: 4px; font-size: 12px; }
    .entry-meta .event-key { font-family: monospace; color: var(--mat-sys-primary); }
    .entry-meta .source-badge { padding: 2px 6px; background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container); border-radius: 4px; font-weight: 500; }
    .entry-empty { color: var(--mat-sys-on-surface-variant); font-style: italic; }
    .field-error, .form-error { display: flex; align-items: center; gap: 8px; color: var(--mat-sys-error); font-size: 13px; padding: 8px 0; }
    .form-error { padding: 12px; background: var(--mat-sys-error-container); color: var(--mat-sys-on-error-container); border-radius: 4px; margin-bottom: 16px; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
    .state { display: flex; align-items: center; gap: 12px; padding: 24px; justify-content: center; color: var(--mat-sys-on-surface-variant); }
  `],
})
export class YayinPlanlamaFormComponent implements OnInit {
  private route   = inject(ActivatedRoute);
  private router  = inject(Router);
  private dialog  = inject(MatDialog);
  private snack   = inject(MatSnackBar);
  private api     = inject(ApiService);
  private service = inject(YayinPlanlamaService);

  protected readonly channelSlots = [
    { field: 'channel1Id' as const, label: 'Kanal 1' },
    { field: 'channel2Id' as const, label: 'Kanal 2' },
    { field: 'channel3Id' as const, label: 'Kanal 3' },
  ];

  protected loading      = signal(false);
  protected submitting   = signal(false);
  protected submitError  = signal<string | null>(null);

  // Edit mode tarafından doldurulan ID (varsa) ve mevcut version (If-Match).
  protected scheduleId      = signal<number | null>(null);
  protected scheduleVersion = signal<number | null>(null);

  protected selectedEntry = signal<LivePlanEntry | null>(null);

  // Form state
  protected scheduleDate = '';
  protected scheduleTime = '';
  protected channels: { channel1Id: number | null; channel2Id: number | null; channel3Id: number | null } =
    { channel1Id: null, channel2Id: null, channel3Id: null };
  protected commercialOptionId: number | null = null;
  protected logoOptionId:       number | null = null;
  protected formatOptionId:     number | null = null;

  // Catalog signals
  protected channels$         = signal<ChannelOption[]>([]);
  protected commercialOptions = signal<ScheduleLookupOption[]>([]);
  protected logoOptions       = signal<ScheduleLookupOption[]>([]);
  protected formatOptions     = signal<ScheduleLookupOption[]>([]);

  // ngModel plain-object binding (channels, scheduleDate, scheduleTime); signal
  // dependency yok, bu yüzden `computed` yerine method (template'te aynı şekilde
  // çağrılır; her change-detection cycle'da yeniden hesaplanır).
  protected isEdit(): boolean {
    return this.scheduleId() !== null;
  }

  protected channelDuplicateError(): boolean {
    const ids = [this.channels.channel1Id, this.channels.channel2Id, this.channels.channel3Id]
      .filter((v): v is number => v != null);
    return new Set(ids).size !== ids.length;
  }

  protected canSubmit(): boolean {
    if (!this.selectedEntry()) return false;
    if (!this.scheduleDate || !this.scheduleTime) return false;
    if (this.channelDuplicateError()) return false;
    return true;
  }

  ngOnInit(): void {
    this.loadCatalogs();
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.scheduleId.set(Number(id));
      this.loadSchedule(Number(id));
    }
  }

  private loadCatalogs(): void {
    this.api.get<ChannelOption[]>('/channels/catalog').subscribe({
      next: (cs) => this.channels$.set(cs),
    });
    // SCHEDULE_LOOKUP_TYPES whitelist ile her 3 lookup'ı çek; magic string yok.
    const [commercial, logo, format] = SCHEDULE_LOOKUP_TYPES;
    this.service.getLookupOptions(commercial).subscribe((items) => this.commercialOptions.set(items));
    this.service.getLookupOptions(logo).subscribe((items) => this.logoOptions.set(items));
    this.service.getLookupOptions(format).subscribe((items) => this.formatOptions.set(items));
  }

  private loadSchedule(id: number): void {
    this.loading.set(true);
    this.service.getById(id).subscribe({
      next: (sch) => {
        this.scheduleVersion.set(sch.version);
        this.scheduleDate = sch.scheduleDate?.slice(0, 10) ?? '';
        this.scheduleTime = this.normalizeTimeFromIso(sch.scheduleTime);
        this.channels.channel1Id   = sch.channel1Id   ?? null;
        this.channels.channel2Id   = sch.channel2Id   ?? null;
        this.channels.channel3Id   = sch.channel3Id   ?? null;
        this.commercialOptionId    = sch.commercialOptionId ?? null;
        this.logoOptionId          = sch.logoOptionId       ?? null;
        this.formatOptionId        = sch.formatOptionId     ?? null;
        // Live-plan entry "skeleton": form'da read-only gösterim için title/team
        // schedule satırından alınır (B3a: schedule.title entry'den kopya).
        const entryId = sch.selectedLivePlanEntryId ?? null;
        if (entryId) {
          this.selectedEntry.set({
            id:             entryId,
            title:          sch.title,
            eventStartTime: sch.startTime,
            eventEndTime:   sch.endTime,
            matchId:        sch.matchId ?? null,
            optaMatchId:    sch.optaMatchId ?? null,
            status:         'PLANNED',
            operationNotes: null,
            createdBy:      null,
            version:        0,
            createdAt:      sch.createdAt,
            updatedAt:      sch.updatedAt,
            deletedAt:      null,
            eventKey:       sch.eventKey ?? null,
            team1Name:      sch.team1Name ?? null,
            team2Name:      sch.team2Name ?? null,
          });
        }
        this.loading.set(false);
      },
      error: (err) => {
        this.snack.open(err?.error?.message ?? 'Yükleme başarısız', 'Kapat', { duration: 5000 });
        this.loading.set(false);
      },
    });
  }

  /** scheduleTime backend `@db.Time(6)` Prisma'dan ISO `1970-01-01THH:MM:SS.000Z`
   *  döner; HTML `<input type="time">` için HH:MM normalize. */
  private normalizeTimeFromIso(value: string | null | undefined): string {
    if (!value) return '';
    const m = /T(\d{2}:\d{2})/.exec(value);
    return m?.[1] ?? '';
  }

  openPicker(): void {
    const ref = this.dialog.open(LivePlanEntryPickerDialog, { width: '900px' });
    ref.afterClosed().subscribe((entry: LivePlanEntry | undefined) => {
      if (entry) {
        this.selectedEntry.set(entry);
        // Pre-fill scheduleDate/scheduleTime entry'nin eventStartTime'ından
        // (operatör değiştirebilir; backend canonical alanlardır).
        if (!this.scheduleDate) this.scheduleDate = entry.eventStartTime.slice(0, 10);
        if (!this.scheduleTime) {
          const m = /T(\d{2}:\d{2})/.exec(entry.eventStartTime);
          this.scheduleTime = m?.[1] ?? '';
        }
      }
    });
  }

  submit(ev: Event): void {
    ev.preventDefault();
    this.submitError.set(null);
    if (!this.canSubmit()) return;

    this.submitting.set(true);
    const time = this.normalizeScheduleTime(this.scheduleTime);

    if (this.isEdit()) {
      const id      = this.scheduleId()!;
      const version = this.scheduleVersion()!;
      const dto: UpdateBroadcastScheduleDto = {
        scheduleDate:       this.scheduleDate,
        scheduleTime:       time,
        channel1Id:         this.channels.channel1Id,
        channel2Id:         this.channels.channel2Id,
        channel3Id:         this.channels.channel3Id,
        commercialOptionId: this.commercialOptionId,
        logoOptionId:       this.logoOptionId,
        formatOptionId:     this.formatOptionId,
      };
      this.service.update(id, dto, version).subscribe({
        next: () => {
          this.snack.open('Yayın planlama güncellendi.', 'Kapat', { duration: 3000 });
          this.router.navigate(['/yayin-planlama']);
        },
        error: (err) => this.handleSubmitError(err),
      });
    } else {
      const entry = this.selectedEntry()!;
      const dto: CreateBroadcastScheduleDto = {
        eventKey:                entry.eventKey ?? '',
        selectedLivePlanEntryId: entry.id,
        scheduleDate:            this.scheduleDate,
        scheduleTime:            time,
        channel1Id:              this.channels.channel1Id,
        channel2Id:              this.channels.channel2Id,
        channel3Id:              this.channels.channel3Id,
        commercialOptionId:      this.commercialOptionId,
        logoOptionId:            this.logoOptionId,
        formatOptionId:          this.formatOptionId,
      };
      this.service.create(dto).subscribe({
        next: () => {
          this.snack.open('Yayın planlama kaydedildi.', 'Kapat', { duration: 3000 });
          this.router.navigate(['/yayin-planlama']);
        },
        error: (err) => this.handleSubmitError(err),
      });
    }
  }

  /** Backend HH:MM ve HH:MM:SS kabul eder (Zod regex); HH:MM input'u service
   *  tarafından normalize edilir (saniye eklenmez — backend tolerant). */
  private normalizeScheduleTime(value: string): string {
    return /^\d{2}:\d{2}$/.test(value) ? value : value;
  }

  private handleSubmitError(err: unknown): void {
    const e = err as { status?: number; error?: { message?: string; issues?: { message: string }[] } };
    const msg =
      e?.error?.issues?.[0]?.message ??
      e?.error?.message ??
      'Kaydetme başarısız.';
    if (e?.status === 409) {
      this.submitError.set(`Bu event zaten Yayın Planlama'da var: ${msg}`);
    } else if (e?.status === 412) {
      this.submitError.set('Kayıt başka kullanıcı tarafından güncellenmiş; sayfayı yenileyin.');
    } else {
      this.submitError.set(msg);
    }
    this.submitting.set(false);
  }
}
