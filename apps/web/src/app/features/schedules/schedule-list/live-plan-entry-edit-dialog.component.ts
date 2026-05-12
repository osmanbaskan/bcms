import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { forkJoin, of, Observable } from 'rxjs';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatSelectModule } from '@angular/material/select';

import { ApiService } from '../../../core/services/api.service';
import {
  composeIstanbulIso,
  formatIstanbulDate,
  formatIstanbulTime,
} from '../../../core/time/tz.helpers';
import { LookupSelectComponent } from '../../live-plan/live-plan-detail/lookup-select.component';
import { livePlanEndpoint, type LivePlanEntry } from '../../live-plan/live-plan.types';
import type {
  TechnicalDetailsRow,
  UpdateTechnicalDetailsBody,
} from '../../live-plan/live-plan-detail/technical-details.types';
import type { Channel, Schedule } from '@bcms/shared';

/**
 * Düzenle dialog (2026-05-11): görsel kompakt grid + canonical 3-channel slot
 * model. Tek "Kaydet" arkası iki ayrı PATCH:
 *   1) PATCH /live-plan/:id          + If-Match livePlanVersion
 *   2) PATCH /technical-details      + If-Match technicalDetailsVersion
 *     (yoksa önce POST {} ile satır create edilir)
 *
 * Lig OPTA read-only (Match.league.name join'i; backend GET response). Kayıt
 * Yeri YOK. Yabancı Dil canonical (`secondLanguageId` → live_plan_languages).
 *
 * Partial failure UX: E1 412 → entry+tech reload; E1 OK + E2 412 → tech reload,
 * tech dirty kalır; 400/403 → snack mesajı.
 */

type EntryDiff = {
  title?:          string;
  eventStartTime?: string;
  eventEndTime?:   string;
  operationNotes?: string | null;
  channel1Id?:     number | null;
  channel2Id?:     number | null;
  channel3Id?:     number | null;
};

/** İki ISO instant string'i aynı zaman anına işaret ediyor mu (string eşitliği
 *  yetmez; backend `2026-06-01T17:00:00.000Z` döndürürken compose
 *  `2026-06-01T17:00:00Z` üretebilir). Date.getTime() ile normalize karşılaştırma. */
function sameIsoInstant(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

const TECH_FIELD_KEYS = [
  'modulationTypeId', 'videoCodingId',
  'ird1Id', 'ird2Id', 'ird3Id',
  'fiber1Id', 'fiber2Id', 'demodId',
  'tieId', 'virtualResourceId',
  'hdvgResourceId', 'int1ResourceId', 'int2ResourceId',
  'offTubeId', 'languageId', 'secondLanguageId',
] as const;
type TechFieldKey = typeof TECH_FIELD_KEYS[number];

@Component({
  selector: 'app-live-plan-entry-edit-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule,
    MatDialogModule, MatProgressSpinnerModule,
    MatSnackBarModule,
    LookupSelectComponent,
  ],
  template: `
    <h2 mat-dialog-title>Kaydı Düzenle</h2>
    <mat-dialog-content class="edit-dialog-content">
      @if (loading()) {
        <div class="loading"><mat-spinner diameter="32"></mat-spinner></div>
      } @else {
        <!-- Satır 1: Yayın Adı + Lig (read-only) -->
        <div class="row">
          <mat-form-field appearance="outline" class="grow">
            <mat-label>Yayın Adı</mat-label>
            <input matInput required maxlength="500"
                   [(ngModel)]="form.title"
                   [ngModelOptions]="{standalone:true}">
          </mat-form-field>
          <mat-form-field appearance="outline" class="grow" floatLabel="always">
            <mat-label>Lig</mat-label>
            <input matInput readonly
                   [value]="form.leagueName || '—'">
          </mat-form-field>
        </div>

        <!-- Satır 2: Kanal 1/2/3, Tarih, Başlangıç, Bitiş -->
        <div class="row compact">
          <mat-form-field appearance="outline">
            <mat-label>Kanal 1</mat-label>
            <mat-select [(ngModel)]="form.channel1Id"
                        [ngModelOptions]="{standalone:true}"
                        [compareWith]="compareById">
              <mat-option [value]="null">— Seçilmedi —</mat-option>
              @for (ch of channels(); track ch.id) {
                <mat-option [value]="ch.id">{{ ch.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Kanal 2</mat-label>
            <mat-select [(ngModel)]="form.channel2Id"
                        [ngModelOptions]="{standalone:true}"
                        [compareWith]="compareById">
              <mat-option [value]="null">— Seçilmedi —</mat-option>
              @for (ch of channels(); track ch.id) {
                <mat-option [value]="ch.id">{{ ch.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Kanal 3</mat-label>
            <mat-select [(ngModel)]="form.channel3Id"
                        [ngModelOptions]="{standalone:true}"
                        [compareWith]="compareById">
              <mat-option [value]="null">— Seçilmedi —</mat-option>
              @for (ch of channels(); track ch.id) {
                <mat-option [value]="ch.id">{{ ch.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Karşılaşma Tarihi</mat-label>
            <input matInput required type="date"
                   [(ngModel)]="form.startDate"
                   [ngModelOptions]="{standalone:true}">
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Karşılaşma Başlangıç</mat-label>
            <input matInput required type="time"
                   [(ngModel)]="form.startTime"
                   [ngModelOptions]="{standalone:true}">
          </mat-form-field>
        </div>

        <!-- Transmisyon süresi — live_plan_technical_details.planned_*_time
             (M5-B10b §5.2 "Trans. Başlangıç" / "Trans. Bitiş"). Karşılaşma
             bitiş saati domain kararıyla UI'da YOK. -->
        <div class="row">
          <mat-form-field appearance="outline">
            <mat-label>Transmisyon Başlangıç Tarihi</mat-label>
            <input matInput type="date"
                   [(ngModel)]="form.plannedStartDate"
                   [ngModelOptions]="{standalone:true}">
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Transmisyon Başlangıç Saati</mat-label>
            <input matInput type="time"
                   [(ngModel)]="form.plannedStartTime"
                   [ngModelOptions]="{standalone:true}">
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Transmisyon Bitiş Tarihi</mat-label>
            <input matInput type="date"
                   [(ngModel)]="form.plannedEndDate"
                   [ngModelOptions]="{standalone:true}">
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Transmisyon Bitiş Saati</mat-label>
            <input matInput type="time"
                   [(ngModel)]="form.plannedEndTime"
                   [ngModelOptions]="{standalone:true}">
          </mat-form-field>
        </div>

        <!-- Teknik FK grid (16 alan) -->
        <div class="grid">
          <app-lookup-select label="Mod Tipi"      lookupType="transmission_modulation_types"
                             [value]="tech.modulationTypeId"   (valueChange)="onTech('modulationTypeId',  $event)"></app-lookup-select>
          <app-lookup-select label="Coding Tipi"   lookupType="transmission_video_codings"
                             [value]="tech.videoCodingId"      (valueChange)="onTech('videoCodingId',     $event)"></app-lookup-select>
          <app-lookup-select label="IRD1"          lookupType="transmission_irds"
                             [value]="tech.ird1Id"             (valueChange)="onTech('ird1Id',            $event)"></app-lookup-select>
          <app-lookup-select label="IRD2"          lookupType="transmission_irds"
                             [value]="tech.ird2Id"             (valueChange)="onTech('ird2Id',            $event)"></app-lookup-select>
          <app-lookup-select label="IRD3"          lookupType="transmission_irds"
                             [value]="tech.ird3Id"             (valueChange)="onTech('ird3Id',            $event)"></app-lookup-select>
          <app-lookup-select label="FIBER 1"       lookupType="transmission_fibers"
                             [value]="tech.fiber1Id"           (valueChange)="onTech('fiber1Id',          $event)"></app-lookup-select>
          <app-lookup-select label="FIBER 2"       lookupType="transmission_fibers"
                             [value]="tech.fiber2Id"           (valueChange)="onTech('fiber2Id',          $event)"></app-lookup-select>
          <app-lookup-select label="Demod"         lookupType="transmission_demod_options"
                             [value]="tech.demodId"            (valueChange)="onTech('demodId',           $event)"></app-lookup-select>
          <app-lookup-select label="TTE"           lookupType="transmission_tie_options"
                             [value]="tech.tieId"              (valueChange)="onTech('tieId',             $event)"></app-lookup-select>
          <app-lookup-select label="Sana"          lookupType="transmission_virtual_resources"
                             [value]="tech.virtualResourceId"  (valueChange)="onTech('virtualResourceId', $event)"></app-lookup-select>
          <app-lookup-select label="HDVG"          lookupType="transmission_int_resources"
                             [value]="tech.hdvgResourceId"     (valueChange)="onTech('hdvgResourceId',    $event)"></app-lookup-select>
          <app-lookup-select label="Int"           lookupType="transmission_int_resources"
                             [value]="tech.int1ResourceId"     (valueChange)="onTech('int1ResourceId',    $event)"></app-lookup-select>
          <app-lookup-select label="Int 2"         lookupType="transmission_int_resources"
                             [value]="tech.int2ResourceId"     (valueChange)="onTech('int2ResourceId',    $event)"></app-lookup-select>
          <app-lookup-select label="Off Tube"      lookupType="live_plan_off_tube_options"
                             [value]="tech.offTubeId"          (valueChange)="onTech('offTubeId',         $event)"></app-lookup-select>
          <app-lookup-select label="Dil"           lookupType="live_plan_languages"
                             [value]="tech.languageId"         (valueChange)="onTech('languageId',        $event)"></app-lookup-select>
          <app-lookup-select label="Yabancı Dil"   lookupType="live_plan_languages"
                             [value]="tech.secondLanguageId"   (valueChange)="onTech('secondLanguageId',  $event)"></app-lookup-select>
        </div>

        <!-- Notlar -->
        <mat-form-field appearance="outline" class="full">
          <mat-label>Açıklama ve Notlar</mat-label>
          <textarea matInput rows="6" maxlength="8000"
                    [(ngModel)]="form.operationNotes"
                    [ngModelOptions]="{standalone:true}"></textarea>
        </mat-form-field>

        @if (errorMsg(); as e) { <p class="err">{{ e }}</p> }
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>İptal</button>
      <button mat-raised-button color="primary"
              [disabled]="loading() || saving() || !canSave()"
              (click)="save()">
        @if (saving()) {
          <mat-spinner diameter="18" style="display:inline-block; vertical-align:middle"></mat-spinner>
        } @else { Kaydet }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .edit-dialog-content {
      min-width: min(1240px, 96vw);
      max-width: 98vw;
      /* 2026-05-12: yükseklik artışı — dialog daha çok dikey alan kullansın.
         min-height ile boş form bile dolu görünür; max-height viewport sınırı. */
      min-height: 78vh;
      max-height: 92vh;
      overflow: auto;
    }
    /* Playwright probe (2026-05-12): mat-dialog-content Material MDC default
       padding rule (.mat-mdc-dialog-content padding: 20px 24px) component
       CSS override edip padding-top 0 yapiyordu. Yayin Adi / Lig outlined
       label notch dialog ust kenarinin 6.75px ustune cikti, overflow:auto
       label kirpti. !important ile Material default override ediliyor;
       class specificity esit oldugundan deterministik tek cozum bu. */
    :host ::ng-deep .mat-mdc-dialog-content.edit-dialog-content {
      padding: 24px 16px 12px !important;
    }
    .loading { display:flex; justify-content:center; padding: 48px; }
    .row { display:flex; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
    .row.compact mat-form-field { flex: 1 1 140px; min-width: 0; }
    .grow { flex: 1 1 280px; min-width: 0; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 10px 12px;
      margin: 8px 0 12px;
    }
    .grid app-lookup-select { display:block; min-width: 0; }
    .full { width: 100%; }
    .err  { color: #f44336; font-size: 12px; margin: 4px 0 0; }
    mat-form-field { width: 100%; }

    /* Polish — disabled Kaydet butonu net görünsün; tab başlıkları okunaklı. */
    :host ::ng-deep .mat-mdc-dialog-actions .mat-mdc-raised-button[disabled],
    :host ::ng-deep .mat-mdc-dialog-actions .mat-mdc-raised-button.mat-mdc-button-disabled {
      background-color: rgba(255,255,255,0.08) !important;
      color: rgba(255,255,255,0.42) !important;
      box-shadow: none !important;
    }
  `],
})
export class LivePlanEntryEditDialogComponent implements OnInit {
  data       = inject<{ schedule: Schedule }>(MAT_DIALOG_DATA);
  dialogRef  = inject(MatDialogRef<LivePlanEntryEditDialogComponent>);
  private api   = inject(ApiService);
  private snack = inject(MatSnackBar);

  loading  = signal(true);
  saving   = signal(false);
  errorMsg = signal('');

  channels = signal<Channel[]>([]);
  entry    = signal<LivePlanEntry | null>(null);
  techRow  = signal<TechnicalDetailsRow | null>(null);

  /** Original snapshots (dirty diff için). */
  private originalEntry: LivePlanEntry | null = null;
  private originalTech: TechnicalDetailsRow | null = null;

  form = {
    title:             '',
    leagueName:        '',
    channel1Id:        null as number | null,
    channel2Id:        null as number | null,
    channel3Id:        null as number | null,
    // Karşılaşma Başlangıç → live_plan_entries.event_start_time
    startDate:         '',
    startTime:         '',
    // Transmisyon → live_plan_technical_details.planned_*_time
    plannedStartDate:  '',
    plannedStartTime:  '',
    plannedEndDate:    '',
    plannedEndTime:    '',
    operationNotes:    '' as string | null,
  };

  tech: Record<TechFieldKey, number | null> = this.emptyTech();

  /** Tek event handler — child component'lerden gelen FK değişimi state'e patch. */
  onTech(key: TechFieldKey, value: number | null): void {
    this.tech = { ...this.tech, [key]: value };
  }

  compareById = (a: number | null, b: number | null): boolean => a === b;

  canSave = computed(() => {
    const f = this.form;
    return !this.loading() && !!f.title.trim() && !!f.startDate && !!f.startTime;
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.errorMsg.set('');
    const entryId = this.data.schedule.id;
    forkJoin({
      entry:    this.api.get<LivePlanEntry>(livePlanEndpoint.detail(entryId)),
      tech:     this.api.get<TechnicalDetailsRow | null>(livePlanEndpoint.technicalDetails(entryId)),
      channels: this.api.get<Channel[]>('/channels/catalog'),
    }).subscribe({
      next: ({ entry, tech, channels }) => {
        this.entry.set(entry);
        this.originalEntry = entry;
        this.applyEntryToForm(entry);

        this.techRow.set(tech);
        this.originalTech = tech;
        this.applyTechToForm(tech);

        this.channels.set(Array.isArray(channels) ? channels : []);
        this.loading.set(false);
      },
      error: (e: HttpErrorResponse) => {
        this.loading.set(false);
        this.errorMsg.set(e?.error?.message ?? 'Kayıt yüklenemedi');
      },
    });
  }

  save(): void {
    if (!this.canSave() || this.saving()) return;
    this.saving.set(true);
    this.errorMsg.set('');

    const entryDiff = this.buildEntryDiff();
    const techDiff  = this.buildTechDiff();
    const entryId   = this.data.schedule.id;

    // Sıralı RxJS chain (`of()` synchronous emit; spec timing'i deterministic).
    this.runEntryStep$(entryDiff, entryId).subscribe({
      next: () => {
        this.runTechStep$(techDiff, entryId).subscribe({
          next: () => this.finalizeSave(),
          error: (e: HttpErrorResponse) => this.handleSaveError(e),
        });
      },
      error: (e: HttpErrorResponse) => this.handleSaveError(e),
    });
  }

  private runEntryStep$(diff: EntryDiff, entryId: number): Observable<void> {
    if (Object.keys(diff).length === 0) return of(void 0);
    const version = this.originalEntry?.version ?? 0;
    return new Observable<void>((sub) => {
      this.api.patch<LivePlanEntry>(
        livePlanEndpoint.detail(entryId),
        diff,
        version,
      ).subscribe({
        next: (updated) => {
          this.entry.set(updated);
          this.originalEntry = updated;
          sub.next(void 0); sub.complete();
        },
        error: (e) => sub.error(e),
      });
    });
  }

  private runTechStep$(diff: UpdateTechnicalDetailsBody, entryId: number): Observable<void> {
    if (Object.keys(diff).length === 0) return of(void 0);
    return new Observable<void>((sub) => {
      const sendPatch = (rowVersion: number): void => {
        this.api.patch<TechnicalDetailsRow>(
          livePlanEndpoint.technicalDetails(entryId),
          diff,
          rowVersion,
        ).subscribe({
          next: (updated) => {
            this.techRow.set(updated);
            this.originalTech = updated;
            sub.next(void 0); sub.complete();
          },
          error: (e) => sub.error(e),
        });
      };
      const existing = this.techRow();
      if (existing) {
        sendPatch(existing.version);
      } else {
        this.api.post<TechnicalDetailsRow>(
          livePlanEndpoint.technicalDetails(entryId),
          {},
        ).subscribe({
          next: (created) => {
            this.techRow.set(created);
            this.originalTech = created;
            sendPatch(created.version);
          },
          error: (e) => sub.error(e),
        });
      }
    });
  }

  private finalizeSave(): void {
    this.saving.set(false);
    this.snack.open('Kayıt güncellendi', 'Kapat', { duration: 3000 });
    this.dialogRef.close({ updated: this.entry() });
  }

  private handleSaveError(err: HttpErrorResponse): void {
    this.saving.set(false);
    const status = err?.status;
    if (status === 412) {
      this.snack.open(
        'Kayıt başka biri tarafından güncellenmiş; form yenileniyor',
        'Kapat',
        { duration: 5000 },
      );
      this.load();
      return;
    }
    if (status === 403) {
      this.errorMsg.set('Bu kaydı düzenleme yetkisi yok');
      this.snack.open('Yetkisiz', 'Kapat', { duration: 4000 });
      return;
    }
    if (status === 400) {
      const issues = err?.error?.issues;
      const msg = Array.isArray(issues) && issues.length > 0
        ? `Doğrulama hatası: ${issues[0]?.message ?? 'alan değerini kontrol edin'}`
        : (err?.error?.message ?? 'Doğrulama hatası');
      this.errorMsg.set(msg);
      this.snack.open(msg, 'Kapat', { duration: 5000 });
      return;
    }
    if (status === 409) {
      this.errorMsg.set('Geçersiz seçim — seçimleri kontrol edin');
      this.snack.open('Çakışma / geçersiz referans', 'Kapat', { duration: 5000 });
      return;
    }
    const msg = err?.error?.message ?? err?.message ?? 'Kaydedilemedi';
    this.errorMsg.set(msg);
    this.snack.open(msg, 'Kapat', { duration: 4000 });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  private applyEntryToForm(e: LivePlanEntry): void {
    this.form.title          = e.title ?? '';
    this.form.leagueName     = e.leagueName ?? '';
    this.form.channel1Id     = e.channel1Id ?? null;
    this.form.channel2Id     = e.channel2Id ?? null;
    this.form.channel3Id     = e.channel3Id ?? null;
    this.form.startDate      = formatIstanbulDate(e.eventStartTime);
    this.form.startTime      = formatIstanbulTime(e.eventStartTime);
    this.form.operationNotes = e.operationNotes ?? '';
  }

  private applyTechToForm(r: TechnicalDetailsRow | null): void {
    if (!r) {
      this.tech = this.emptyTech();
      this.form.plannedStartDate = '';
      this.form.plannedStartTime = '';
      this.form.plannedEndDate   = '';
      this.form.plannedEndTime   = '';
      return;
    }
    const next = this.emptyTech();
    for (const k of TECH_FIELD_KEYS) {
      const v = (r as unknown as Record<string, unknown>)[k];
      next[k] = typeof v === 'number' ? v : null;
    }
    this.tech = next;
    // Transmisyon süresi → Türkiye saatine split (ISO UTC stored).
    this.form.plannedStartDate = r.plannedStartTime ? formatIstanbulDate(r.plannedStartTime) : '';
    this.form.plannedStartTime = r.plannedStartTime ? formatIstanbulTime(r.plannedStartTime) : '';
    this.form.plannedEndDate   = r.plannedEndTime   ? formatIstanbulDate(r.plannedEndTime)   : '';
    this.form.plannedEndTime   = r.plannedEndTime   ? formatIstanbulTime(r.plannedEndTime)   : '';
  }

  private emptyTech(): Record<TechFieldKey, number | null> {
    const out: Record<TechFieldKey, number | null> = {} as Record<TechFieldKey, number | null>;
    for (const k of TECH_FIELD_KEYS) out[k] = null;
    return out;
  }

  private buildEntryDiff(): EntryDiff {
    const out: EntryDiff = {};
    const orig = this.originalEntry;
    if (!orig) return out;
    const f = this.form;

    const titleNext = f.title.trim();
    if (titleNext !== (orig.title ?? '')) out.title = titleNext;

    const notesNext = (f.operationNotes ?? '').trim();
    const origNotes = orig.operationNotes ?? '';
    if (notesNext !== origNotes) {
      out.operationNotes = notesNext === '' ? null : notesNext;
    }

    if ((f.channel1Id ?? null) !== (orig.channel1Id ?? null)) out.channel1Id = f.channel1Id ?? null;
    if ((f.channel2Id ?? null) !== (orig.channel2Id ?? null)) out.channel2Id = f.channel2Id ?? null;
    if ((f.channel3Id ?? null) !== (orig.channel3Id ?? null)) out.channel3Id = f.channel3Id ?? null;

    // Karşılaşma Başlangıç Saati (eventStartTime) — operatör değiştirir.
    // Karşılaşma bitiş saati UI'da YOK (domain kararı 2026-05-12); frontend
    // yalnız eventStartTime gönderir. Backend service update tarafı
    // eventEndTime'ı (+2h) bağımsız olarak ayarlar (live-plan.service.ts
    // autoEndForStartOnly bloğu), bu sayede payload'da uydurma placeholder
    // göndermek gerekmez.
    const origStartDate = formatIstanbulDate(orig.eventStartTime);
    const origStartTime = formatIstanbulTime(orig.eventStartTime);

    if (f.startDate !== origStartDate || f.startTime !== origStartTime) {
      out.eventStartTime = composeIstanbulIso(f.startDate, f.startTime);
    }

    return out;
  }

  private buildTechDiff(): UpdateTechnicalDetailsBody {
    const out: Record<string, number | string | null> = {};
    const orig = this.originalTech;
    for (const k of TECH_FIELD_KEYS) {
      const before = orig ? ((orig as unknown as Record<string, unknown>)[k] as number | null) : null;
      const after  = this.tech[k];
      if ((before ?? null) === (after ?? null)) continue;
      out[k] = after;
    }
    // Transmisyon süreleri (plannedStartTime / plannedEndTime, DateTime ISO):
    // form'da ayrı date+time alan; gönderirken Türkiye saatinden UTC ISO compose.
    // null gönderimi backend U7 ile "kolonu temizle"; boş input → null.
    const f = this.form;
    const origStartIso = orig?.plannedStartTime ?? null;
    const origEndIso   = orig?.plannedEndTime   ?? null;
    const nextStartIso = (f.plannedStartDate && f.plannedStartTime)
      ? composeIstanbulIso(f.plannedStartDate, f.plannedStartTime)
      : null;
    const nextEndIso = (f.plannedEndDate && f.plannedEndTime)
      ? composeIstanbulIso(f.plannedEndDate, f.plannedEndTime)
      : null;
    if (!sameIsoInstant(origStartIso, nextStartIso)) out['plannedStartTime'] = nextStartIso;
    if (!sameIsoInstant(origEndIso,   nextEndIso))   out['plannedEndTime']   = nextEndIso;
    return out as UpdateTechnicalDetailsBody;
  }
}
