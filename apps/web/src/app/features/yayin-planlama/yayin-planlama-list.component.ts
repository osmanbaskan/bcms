import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { HttpErrorResponse } from '@angular/common/http';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  DateAdapter, MAT_DATE_FORMATS, MAT_DATE_LOCALE,
  MatNativeDateModule, NativeDateAdapter,
} from '@angular/material/core';
import { KeycloakService } from 'keycloak-angular';
import { GROUP, PERMISSIONS, type LivePlanEntry } from '@bcms/shared';
import { isSkipAuthAllowed } from '../../core/auth/skip-auth';
import type { BcmsTokenParsed } from '../../core/types/auth';
import { ApiService } from '../../core/services/api.service';
import {
  composeIstanbulIso, formatIstanbulDate, formatIstanbulDateTr, formatIstanbulTime,
} from '../../core/time/tz.helpers';
import { YayinPlanlamaService, type LeagueFilterOption } from '../../core/services/yayin-planlama.service';

/**
 * 2026-05-13: Yayın Planlama list, Canlı Yayın Plan kayıtlarını gösterir.
 * Veri kaynağı `GET /api/v1/live-plan` (entry-level; eventKey/schedule şartı
 * yok). EventKey filtresi kaldırıldı; Lig/Hafta filter eklendi.
 *
 * Önceki kontrat: `GET /api/v1/schedules/broadcast` (broadcast-complete row
 * guarantee) — geriye-uyumluluk amacıyla service'te `getList()` korunur
 * (yeni create akışı `/yayin-planlama/new` form için). Bu liste artık
 * `getLivePlanList()` kullanır.
 *
 * Row aksiyonları (Düzenle / Sil) bu iterasyonda **gizli** — önceki shema
 * `Schedule.id` bekliyordu, yeni row tipi `LivePlanEntry`. Aksiyonların
 * canlı yayın plan entry'sine mi yoksa bağlı broadcast schedule'a mı işaret
 * etmesi karar bekleyen tasarım sorusu (raporda detay).
 *
 * 2026-05-13 UI sadeleştirme:
 *   - "Başlık" + "Takım" iki kolonu tek "Karşılaşma" kolonuna birleştirildi
 *     (team1/team2 varsa "X vs Y"; yoksa title fallback; title takım
 *     bilgisinden farklıysa küçük secondary satır).
 *   - "Kanallar" kolonu count yerine kanal **adlarını** alt alta gösterir
 *     (channel id → name resolve `/channels/catalog` lookup üzerinden).
 */

const PAGE_SIZE_DEFAULT = 25;

interface ChannelCatalogItem { id: number; name: string; }

// 2026-05-13: Filter bar Başlangıç/Bitiş için MatDatepicker (Türkçe locale,
// dd.MM.yyyy display). Pattern paritesi: live-plan-entry-edit-dialog.
const TR_DATE_FORMATS = {
  parse: { dateInput: 'dd.MM.yyyy' },
  display: {
    dateInput: 'dd.MM.yyyy',
    monthYearLabel: { month: 'short', year: 'numeric' },
    dateA11yLabel: { day: '2-digit', month: 'long', year: 'numeric' },
    monthYearA11yLabel: { month: 'long', year: 'numeric' },
  },
};

class TrDateAdapter extends NativeDateAdapter {
  override parse(value: string | null, _parseFormat: unknown): Date | null {
    if (!value) return null;
    const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim());
    if (match) {
      const d = new Date(+match[3], +match[2] - 1, +match[1]);
      return isNaN(d.getTime()) ? null : d;
    }
    return super.parse(value, _parseFormat);
  }
  override format(date: Date, displayFormat: unknown): string {
    if (displayFormat === 'dd.MM.yyyy') {
      return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
    }
    return super.format(date, displayFormat as object);
  }
}

/** MatDatepicker Date → "YYYY-MM-DD" (browser local; BCMS Türkiye-only). */
function dateToYmd(d: Date): string {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

@Component({
  selector: 'app-yayin-planlama-list',
  standalone: true,
  providers: [
    { provide: MAT_DATE_LOCALE,  useValue: 'tr-TR' },
    { provide: MAT_DATE_FORMATS, useValue: TR_DATE_FORMATS },
    { provide: DateAdapter,      useClass: TrDateAdapter, deps: [MAT_DATE_LOCALE] },
  ],
  imports: [
    CommonModule, FormsModule, RouterLink,
    MatTableModule, MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatSelectModule, MatPaginatorModule,
    MatTooltipModule, MatDialogModule, MatSnackBarModule, MatProgressSpinnerModule,
    MatDatepickerModule, MatNativeDateModule, MatCheckboxModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Yayın Planlama</h2>
        <div class="header-actions">
          <button mat-stroked-button
                  [disabled]="selectionCount() === 0 || exporting()"
                  (click)="exportExcel()">
            <mat-icon>download</mat-icon>
            Excel ({{ selectionCount() }})
          </button>
          <button mat-stroked-button
                  [disabled]="selectionCount() === 0 || exporting()"
                  (click)="exportPdf()">
            <mat-icon>print</mat-icon>
            PDF ({{ selectionCount() }})
          </button>
          @if (canWrite()) {
            <button mat-raised-button color="primary" routerLink="/yayin-planlama/new">
              <mat-icon>add</mat-icon> Yeni
            </button>
          }
        </div>
      </div>

      <div class="filter-bar">
        <mat-form-field appearance="outline">
          <mat-label>Başlangıç</mat-label>
          <input matInput [matDatepicker]="fromPicker"
                 [(ngModel)]="dateFrom" name="from"
                 (dateChange)="reload()" />
          <mat-datepicker-toggle matIconSuffix [for]="fromPicker"></mat-datepicker-toggle>
          <mat-datepicker #fromPicker></mat-datepicker>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Bitiş</mat-label>
          <input matInput [matDatepicker]="toPicker"
                 [(ngModel)]="dateTo" name="to"
                 (dateChange)="reload()" />
          <mat-datepicker-toggle matIconSuffix [for]="toPicker"></mat-datepicker-toggle>
          <mat-datepicker #toPicker></mat-datepicker>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Lig</mat-label>
          <mat-select [(ngModel)]="leagueId" name="leagueId" (selectionChange)="onLeagueChange()">
            <mat-option [value]="null">Tümü</mat-option>
            @for (lg of leagues(); track lg.id) {
              <mat-option [value]="lg.id">{{ lg.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Hafta</mat-label>
          <mat-select [(ngModel)]="weekNumber" name="weekNumber"
                      [disabled]="leagueId == null"
                      (selectionChange)="reload()">
            <mat-option [value]="null">Tüm Haftalar</mat-option>
            @for (w of weeks(); track w) {
              <mat-option [value]="w">{{ w }}. Hafta</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <button mat-button (click)="reload()">
          <mat-icon>refresh</mat-icon> Yenile
        </button>
      </div>

      @if (loading()) {
        <div class="state state-loading">
          <mat-progress-spinner mode="indeterminate" diameter="32"></mat-progress-spinner>
        </div>
      } @else if (error()) {
        <div class="state state-error">
          <mat-icon>error_outline</mat-icon>
          <span>{{ error() }}</span>
        </div>
      } @else if (rows().length === 0) {
        <div class="state state-empty">
          <mat-icon>event_available</mat-icon>
          <span>Yayın Planlama kaydı bulunamadı.</span>
        </div>
      } @else {
        <div class="table-scroll">
        <table mat-table [dataSource]="rows()" class="yp-table">
          <ng-container matColumnDef="select">
            <th mat-header-cell *matHeaderCellDef class="th-select">
              <mat-checkbox
                [checked]="allOnPageSelected()"
                [indeterminate]="someOnPageSelected()"
                (change)="toggleAllOnPage($event.checked)"
                aria-label="Tümünü seç">
              </mat-checkbox>
            </th>
            <td mat-cell *matCellDef="let r" class="td-select">
              <mat-checkbox
                [checked]="isSelected(r.id)"
                (change)="toggleOne(r.id, $event.checked)"
                aria-label="Satırı seç">
              </mat-checkbox>
            </td>
          </ng-container>
          <ng-container matColumnDef="date">
            <th mat-header-cell *matHeaderCellDef>Tarih</th>
            <td mat-cell *matCellDef="let r">{{ formatDate(r.eventStartTime) }}</td>
          </ng-container>
          <ng-container matColumnDef="time">
            <th mat-header-cell *matHeaderCellDef>Saat</th>
            <td mat-cell *matCellDef="let r">{{ formatTime(r.eventStartTime) }}</td>
          </ng-container>
          <ng-container matColumnDef="match">
            <th mat-header-cell *matHeaderCellDef>Karşılaşma</th>
            <td mat-cell *matCellDef="let r" class="td-match">
              <div class="match-primary">{{ primaryMatchLabel(r) }}</div>
              @if (secondaryTitle(r); as st) {
                <div class="match-secondary">{{ st }}</div>
              }
            </td>
          </ng-container>
          <ng-container matColumnDef="league">
            <th mat-header-cell *matHeaderCellDef>Lig</th>
            <td mat-cell *matCellDef="let r">{{ r.leagueName ?? '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="week">
            <th mat-header-cell *matHeaderCellDef>Hafta</th>
            <td mat-cell *matCellDef="let r">{{ r.weekNumber ?? '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="channels">
            <th mat-header-cell *matHeaderCellDef>Kanallar</th>
            <td mat-cell *matCellDef="let r" class="td-channels">
              @if (canEditLivePlan()) {
                <div class="ch-edit">
                  @for (slot of channelSlots; track slot) {
                    <mat-form-field appearance="outline" subscriptSizing="dynamic" class="ch-select">
                      <mat-select
                        [ngModel]="channelSlotValue(r, slot)"
                        (ngModelChange)="onChannelChange(r, slot, $event)"
                        [disabled]="savingRowId() === r.id"
                        [ngModelOptions]="{standalone: true}">
                        <mat-option [value]="null">—</mat-option>
                        @for (ch of channelCatalog(); track ch.id) {
                          <mat-option [value]="ch.id">{{ ch.name }}</mat-option>
                        }
                      </mat-select>
                    </mat-form-field>
                  }
                  @if (savingRowId() === r.id) {
                    <mat-progress-spinner mode="indeterminate" diameter="14"
                                          class="ch-spinner"></mat-progress-spinner>
                  }
                </div>
              } @else {
                <span class="ch-readonly">{{ channelNamesStack(r) }}</span>
              }
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="cols"></tr>
          <tr mat-row *matRowDef="let row; columns: cols;"></tr>
        </table>
        </div>
        <mat-paginator
          [length]="total()"
          [pageSize]="pageSize()"
          [pageIndex]="page() - 1"
          [pageSizeOptions]="[10, 25, 50, 100]"
          (page)="onPage($event)">
        </mat-paginator>
      }
    </div>
  `,
  styles: [`
    .page { padding: 24px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px; flex-wrap: wrap; }
    .page-header h2 { margin: 0; font-size: 20px; font-weight: 600; }
    .header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .th-select, .td-select { width: 40px; padding-left: 8px; padding-right: 0; }
    .filter-bar { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 16px; }
    /* 2026-05-13: Table horizontal scroll wrapper — dar ekran/dolu sütun
       senaryosunda cell'leri kırpmak yerine yatay scroll. */
    .table-scroll { overflow-x: auto; width: 100%; }
    .yp-table { width: max-content; min-width: 100%; }
    .state { display: flex; align-items: center; gap: 12px; padding: 48px; justify-content: center; color: var(--mat-sys-on-surface-variant); }
    .state-error { color: var(--mat-sys-error); }
    .td-match { min-width: 220px; max-width: 360px; }
    .match-primary { font-weight: 500; }
    .match-secondary { font-size: 11px; opacity: 0.65; margin-top: 2px; }
    /* 2026-05-13: Kanallar hücresi — 3 mat-select için yeterli min genişlik
       (3×140px + 12px gap = ~432px); grid layout ile her kutu eşit + tam
       görünür, kırpma/üst üste binme yok. Spinner absolute (layout bozmaz). */
    .td-channels {
      font-size: 12px;
      line-height: 1.35;
      min-width: 460px;
    }
    .td-channels .ch-readonly { white-space: pre-line; }
    .ch-edit {
      display: grid;
      grid-template-columns: repeat(3, minmax(140px, 1fr));
      gap: 6px;
      align-items: center;
      position: relative;
    }
    .ch-edit .ch-select { width: 100%; }
    .ch-edit .ch-select ::ng-deep .mat-mdc-form-field-infix { padding: 4px 0; min-height: 28px; }
    .ch-edit .ch-spinner { position: absolute; top: 2px; right: 2px; }

  `],
})
export class YayinPlanlamaListComponent implements OnInit {
  private api      = inject(ApiService);
  private service  = inject(YayinPlanlamaService);
  private snack    = inject(MatSnackBar);
  private keycloak = inject(KeycloakService, { optional: true });

  // 2026-05-13: Durum kolonu + Durum filtresi kaldırıldı (UX sadeleştirme).
  // 2026-05-13: `select` kolonu en başa eklendi (seçimli Excel/PDF export).
  protected cols = ['select', 'date', 'time', 'match', 'league', 'week', 'channels'];
  protected readonly channelSlots: ReadonlyArray<1 | 2 | 3> = [1, 2, 3];

  // Filter state — MatDatepicker Date | null modeli
  protected dateFrom:   Date | null = null;
  protected dateTo:     Date | null = null;
  protected leagueId:   number | null = null;
  protected weekNumber: number | null = null;

  // Filter dropdown options
  protected leagues = signal<LeagueFilterOption[]>([]);
  protected weeks   = signal<number[]>([]);

  // Channel id → name lookup (GET /channels/catalog — schedule-list paritesi)
  protected channelCatalog = signal<ChannelCatalogItem[]>([]);

  // Page state
  protected rows     = signal<LivePlanEntry[]>([]);
  protected total    = signal(0);
  protected page     = signal(1);
  protected pageSize = signal(PAGE_SIZE_DEFAULT);
  protected loading  = signal(false);
  protected error    = signal<string | null>(null);

  /** Inline kanal düzenleme sırasında o satırın id'si (UI lock). */
  protected savingRowId = signal<number | null>(null);

  // ── 2026-05-13: Seçimli export ──────────────────────────────────────────
  /** Yalnız mevcut sayfa için. Page/reload temizlenir. */
  protected selectedIds = signal<Set<number>>(new Set());
  protected exporting   = signal<boolean>(false);

  protected selectionCount = computed(() => this.selectedIds().size);
  protected allOnPageSelected = computed(() => {
    const rows = this.rows();
    if (rows.length === 0) return false;
    const sel = this.selectedIds();
    return rows.every((r) => sel.has(r.id));
  });
  protected someOnPageSelected = computed(() => {
    const rows = this.rows();
    const sel = this.selectedIds();
    const c = rows.filter((r) => sel.has(r.id)).length;
    return c > 0 && c < rows.length;
  });

  /** "Yeni" butonu yetkilenmesi — `/yayin-planlama/new` broadcast schedule
   *  create form'u canlı kalıyor; `schedules.write` grup seti. */
  protected canWrite = computed<boolean>(() => this.hasGroup(PERMISSIONS.schedules.write));

  /** Inline kanal düzenleme yetkilenmesi — `PATCH /api/v1/live-plan/:id`
   *  endpoint'i `PERMISSIONS.livePlan.write` ister. Bu sekme artık LivePlanEntry
   *  üstüne yazar (Schedule DEĞİL); doğru permission anahtarı budur. */
  protected canEditLivePlan = computed<boolean>(() => this.hasGroup(PERMISSIONS.livePlan.write));

  ngOnInit(): void {
    this.loadLeagues();
    this.loadChannelCatalog();
    this.reload();
  }

  reload(): void {
    // Filtre değişimi / pagination ile selection temizlenir (yalnız mevcut
    // sayfa kapsamı kararı).
    this.clearSelection();
    this.loading.set(true);
    this.error.set(null);
    // MatDatepicker Date → Türkiye gün boundary compose (00:00 / 23:59:59).
    // composeIstanbulIso `+03:00` ile UTC ISO üretir; backend datetime kabul eder.
    const fromIso = this.dateFrom ? composeIstanbulIso(dateToYmd(this.dateFrom), '00:00')    : undefined;
    const toIso   = this.dateTo   ? composeIstanbulIso(dateToYmd(this.dateTo),   '23:59:59') : undefined;
    this.service.getLivePlanList({
      from:       fromIso,
      to:         toIso,
      leagueId:   this.leagueId   ?? undefined,
      weekNumber: this.weekNumber ?? undefined,
      page:       this.page(),
      pageSize:   this.pageSize(),
    }).subscribe({
      next: (res) => {
        this.rows.set(res.items);
        this.total.set(res.total);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message ?? 'Liste yüklenemedi.');
        this.loading.set(false);
      },
    });
  }

  onLeagueChange(): void {
    // Lig değişti → weekNumber resetlensin ve hafta options yeniden yüklensin.
    this.weekNumber = null;
    this.loadWeeks(this.leagueId ?? undefined);
    this.reload();
  }

  private loadLeagues(): void {
    this.service.getLeagueFilterOptions().subscribe({
      next: (items) => this.leagues.set(items),
      error: () => this.leagues.set([]),
    });
  }

  private loadWeeks(leagueId?: number): void {
    if (leagueId === undefined) { this.weeks.set([]); return; }
    this.service.getWeekFilterOptions(leagueId).subscribe({
      next: (items) => this.weeks.set(items),
      error: () => this.weeks.set([]),
    });
  }

  private loadChannelCatalog(): void {
    this.api.get<ChannelCatalogItem[]>('/channels/catalog').subscribe({
      next: (res) => this.channelCatalog.set(Array.isArray(res) ? res : []),
      error: () => this.channelCatalog.set([]),
    });
  }

  onPage(ev: PageEvent): void {
    this.page.set(ev.pageIndex + 1);
    this.pageSize.set(ev.pageSize);
    this.reload();
  }

  /** UTC ISO → Türkiye yerel tarihi "DD.MM.YYYY" (gg.aa.yyyy). */
  protected formatDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    try {
      return formatIstanbulDateTr(iso);
    } catch {
      return '—';
    }
  }

  /** UTC ISO → Türkiye yerel saati "HH:mm". */
  protected formatTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    try {
      return formatIstanbulTime(iso);
    } catch {
      return '—';
    }
  }

  /**
   * Karşılaşma primary label:
   *   - team1Name + team2Name varsa "X vs Y"
   *   - yoksa entry title (fallback)
   *   - hiçbiri yoksa "—"
   */
  protected primaryMatchLabel(row: LivePlanEntry): string {
    if (row.team1Name && row.team2Name) {
      return `${row.team1Name} vs ${row.team2Name}`;
    }
    return row.title?.trim() || '—';
  }

  /**
   * Secondary satır: entry title takım bilgisinden anlamlı şekilde
   * farklıysa göster. OPTA path'te title genelde "Team A vs Team B"
   * olduğu için aynı çıkar → secondary boş döner (tekrar yok).
   */
  protected secondaryTitle(row: LivePlanEntry): string | null {
    const title = row.title?.trim();
    if (!title) return null;
    if (!row.team1Name || !row.team2Name) return null; // primary zaten title
    if (title === this.primaryMatchLabel(row)) return null;
    return title;
  }

  /**
   * Kanal id → name resolve; üç slottan dolu olanları "\n" ile join eder
   * (CSS `white-space: pre-line` ile alt alta render olur). Boş slot
   * hariç. Hiç kanal yoksa "—".
   */
  protected channelNamesStack(row: LivePlanEntry): string {
    const names: string[] = [];
    const lookup = this.channelCatalog();
    for (const id of [row.channel1Id, row.channel2Id, row.channel3Id]) {
      if (id == null) continue;
      const ch = lookup.find((c) => c.id === id);
      if (ch?.name) names.push(ch.name);
    }
    return names.length ? names.join('\n') : '—';
  }

  /** Inline edit select için slot başına mevcut değer. */
  protected channelSlotValue(row: LivePlanEntry, slot: 1 | 2 | 3): number | null {
    if (slot === 1) return row.channel1Id ?? null;
    if (slot === 2) return row.channel2Id ?? null;
    return row.channel3Id ?? null;
  }

  /**
   * 2026-05-13: Operatör select değiştirdi → otomatik kaydet.
   * No-op aynı değer için. Yeni değerle compose edip `saveChannels` çağırır.
   */
  protected onChannelChange(row: LivePlanEntry, slot: 1 | 2 | 3, newId: number | null): void {
    const current = this.channelSlotValue(row, slot);
    const normalizedNew = newId ?? null;
    if (current === normalizedNew) return;
    this.saveChannels(row, slot, normalizedNew);
  }

  /**
   * PATCH /api/v1/live-plan/:id (Schedule DEĞİL) + If-Match: row.version.
   * Optimistic UI: local row'u hemen güncelle; success'te server response ile
   * yer değiştir (yeni version); error'da eski snapshot'a geri dön. 412 →
   * "kayıt başkası tarafından güncellendi" + liste reload.
   */
  private saveChannels(row: LivePlanEntry, slot: 1 | 2 | 3, newId: number | null): void {
    const dto = {
      channel1Id: slot === 1 ? newId : (row.channel1Id ?? null),
      channel2Id: slot === 2 ? newId : (row.channel2Id ?? null),
      channel3Id: slot === 3 ? newId : (row.channel3Id ?? null),
    };
    // Optimistic update — kullanıcı select'i bıraktığında anında yansır.
    const oldRows = this.rows();
    this.rows.set(oldRows.map((r) => (r.id === row.id ? { ...r, ...dto } : r)));
    this.savingRowId.set(row.id);

    this.service.updateLivePlanChannels(row.id, dto, row.version).subscribe({
      next: (updated) => {
        // Server response yeni version'lu row; local replace (optimistic
        // başarı path'ini de tek yerden senkronize eder).
        this.rows.update((rs) => rs.map((r) => (r.id === updated.id ? updated : r)));
        this.savingRowId.set(null);
        this.snack.open('Kanallar güncellendi.', 'Kapat', { duration: 2000 });
      },
      error: (err: HttpErrorResponse) => {
        this.savingRowId.set(null);
        // Optimistic rollback
        this.rows.set(oldRows);
        if (err?.status === 412) {
          this.snack.open(
            'Kayıt başka biri tarafından güncellendi. Liste yenileniyor.',
            'Kapat',
            { duration: 4000 },
          );
          this.reload();
          return;
        }
        const msg = err?.error?.message ?? 'Kanal güncellenemedi.';
        this.snack.open(msg, 'Kapat', { duration: 4000 });
      },
    });
  }

  // ── 2026-05-13: Selection toggle handlers ─────────────────────────────
  protected isSelected(id: number): boolean {
    return this.selectedIds().has(id);
  }

  protected toggleOne(id: number, checked: boolean): void {
    const next = new Set(this.selectedIds());
    if (checked) next.add(id); else next.delete(id);
    this.selectedIds.set(next);
  }

  protected toggleAllOnPage(checked: boolean): void {
    const next = new Set(this.selectedIds());
    for (const r of this.rows()) {
      if (checked) next.add(r.id); else next.delete(r.id);
    }
    this.selectedIds.set(next);
  }

  private clearSelection(): void {
    if (this.selectedIds().size > 0) this.selectedIds.set(new Set());
  }

  // ── 2026-05-13: Excel export — backend xlsx blob ──────────────────────
  protected exportExcel(): void {
    const ids = Array.from(this.selectedIds());
    if (ids.length === 0) return;
    this.exporting.set(true);
    this.service.exportLivePlanExcel(ids, 'Yayın Planlama').subscribe({
      next: (blob) => {
        this.exporting.set(false);
        const dateStr = formatIstanbulDate(new Date());
        this.downloadBlob(blob, `yayin-planlama_${dateStr}.xlsx`);
      },
      error: (err: HttpErrorResponse) => {
        this.exporting.set(false);
        const msg = err?.error?.message ?? 'Excel indirilemedi.';
        this.snack.open(msg, 'Kapat', { duration: 4000 });
      },
    });
  }

  // ── 2026-05-13: PDF export — frontend print HTML ──────────────────────
  protected exportPdf(): void {
    const sel = this.selectedIds();
    if (sel.size === 0) return;
    const rows = this.rows().filter((r) => sel.has(r.id));
    const html = this.buildPrintableHtml(rows);
    const win = window.open('', '_blank', 'width=1200,height=800');
    if (!win) {
      this.snack.open('PDF penceresi açılamadı.', 'Kapat', { duration: 4000 });
      return;
    }
    win.opener = null;
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private buildPrintableHtml(rows: LivePlanEntry[]): string {
    const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c] as string));
    const bodyRows = rows.map((r) => {
      const teams = (r.team1Name && r.team2Name)
        ? `${r.team1Name} vs ${r.team2Name}`
        : (r.title ?? '');
      const channels = this.channelNamesStack(r).replace(/\n/g, ', ');
      return `
        <tr>
          <td>${esc(this.formatDate(r.eventStartTime))}</td>
          <td>${esc(this.formatTime(r.eventStartTime))}</td>
          <td>${esc(teams)}</td>
          <td>${esc(r.leagueName ?? '—')}</td>
          <td>${esc(r.weekNumber != null ? String(r.weekNumber) : '—')}</td>
          <td>${esc(channels)}</td>
        </tr>`;
    }).join('');
    return `<!DOCTYPE html>
<html lang="tr"><head>
<meta charset="utf-8">
<title>Yayın Planlama</title>
<style>
  body { font-family: 'Segoe UI', Roboto, Arial, sans-serif; padding: 24px; color: #222; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  .meta { font-size: 11px; color: #666; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 6px 8px; border: 1px solid #ccc; text-align: left; vertical-align: top; }
  th { background: #f3f3f3; font-weight: 600; }
  @media print { body { padding: 0; } }
</style>
</head><body>
<h1>Yayın Planlama</h1>
<div class="meta">${esc(formatIstanbulDateTr(new Date()))} — ${rows.length} kayıt</div>
<table>
  <thead>
    <tr>
      <th>Tarih</th><th>Saat</th><th>Karşılaşma</th><th>Lig</th><th>Hafta</th><th>Kanallar</th>
    </tr>
  </thead>
  <tbody>${bodyRows}</tbody>
</table>
</body></html>`;
  }

  private hasGroup(allowed: readonly string[]): boolean {
    if (allowed.length === 0) return true;
    if (isSkipAuthAllowed()) return true;
    const groups = (this.keycloak?.getKeycloakInstance()?.tokenParsed as BcmsTokenParsed | undefined)?.groups ?? [];
    if (groups.includes(GROUP.Admin)) return true;
    return groups.some((g) => allowed.includes(g));
  }
}
