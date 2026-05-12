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

@Component({
  selector: 'app-yayin-planlama-list',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink,
    MatTableModule, MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatSelectModule, MatPaginatorModule,
    MatTooltipModule, MatDialogModule, MatSnackBarModule, MatProgressSpinnerModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h2>Yayın Planlama</h2>
        @if (canWrite()) {
          <button mat-raised-button color="primary" routerLink="/yayin-planlama/new">
            <mat-icon>add</mat-icon> Yeni
          </button>
        }
      </div>

      <div class="filter-bar">
        <mat-form-field appearance="outline">
          <mat-label>Başlangıç</mat-label>
          <input matInput type="date" name="from" [(ngModel)]="dateFrom" (change)="reload()" />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Bitiş</mat-label>
          <input matInput type="date" name="to" [(ngModel)]="dateTo" (change)="reload()" />
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
        <table mat-table [dataSource]="rows()" class="yp-table">
          <ng-container matColumnDef="date">
            <th mat-header-cell *matHeaderCellDef>Tarih</th>
            <td mat-cell *matCellDef="let r" class="td-date">
              @if (canEditLivePlan()) {
                <input type="date" class="date-input"
                       [ngModel]="dateInputValue(r)"
                       (ngModelChange)="onDateChange(r, $event)"
                       [disabled]="savingRowId() === r.id"
                       [ngModelOptions]="{standalone: true}" />
              } @else {
                <span>{{ formatDate(r.eventStartTime) }}</span>
              }
            </td>
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
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .page-header h2 { margin: 0; font-size: 20px; font-weight: 600; }
    .filter-bar { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 16px; }
    .yp-table { width: 100%; }
    .state { display: flex; align-items: center; gap: 12px; padding: 48px; justify-content: center; color: var(--mat-sys-on-surface-variant); }
    .state-error { color: var(--mat-sys-error); }
    .td-match { min-width: 220px; max-width: 360px; }
    .match-primary { font-weight: 500; }
    .match-secondary { font-size: 11px; opacity: 0.65; margin-top: 2px; }
    .td-channels {
      font-size: 12px;
      line-height: 1.35;
      min-width: 340px;
    }
    .td-channels .ch-readonly { white-space: pre-line; }
    /* 2026-05-13: 3 kanal seçim kutusu yan yana (önceki alt alta).
       Desktop'ta tek satır; dar ekranda flex-wrap ile alta düşer. */
    .ch-edit {
      display: flex; flex-direction: row; gap: 6px;
      align-items: center; flex-wrap: wrap;
    }
    .ch-edit .ch-select { width: 104px; }
    .ch-edit .ch-select ::ng-deep .mat-mdc-form-field-infix { padding: 4px 0; min-height: 28px; }
    .ch-edit .ch-spinner { margin-left: 4px; flex-shrink: 0; }

    /* Inline tarih input — compact, mat-form-field DEĞİL (native HTML5
       date input; layout simplicity). */
    .td-date .date-input {
      font: inherit;
      padding: 4px 6px;
      border: 1px solid rgba(0,0,0,0.2);
      border-radius: 4px;
      background: transparent;
      color: inherit;
      width: 130px;
    }
    .td-date .date-input:focus { outline: 2px solid var(--mat-sys-primary); outline-offset: -1px; }
    .td-date .date-input:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class YayinPlanlamaListComponent implements OnInit {
  private api      = inject(ApiService);
  private service  = inject(YayinPlanlamaService);
  private snack    = inject(MatSnackBar);
  private keycloak = inject(KeycloakService, { optional: true });

  // 2026-05-13: Durum kolonu + Durum filtresi kaldırıldı (UX sadeleştirme).
  // Tarih + Saat en başta; Tarih inline editable (yetkili kullanıcı).
  protected cols = ['date', 'time', 'match', 'league', 'week', 'channels'];
  protected readonly channelSlots: ReadonlyArray<1 | 2 | 3> = [1, 2, 3];

  // Filter state
  protected dateFrom   = '';
  protected dateTo     = '';
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
    this.loading.set(true);
    this.error.set(null);
    // `from/to` UI'dan YYYY-MM-DD geliyor; backend `from/to` ISO datetime
    // bekliyor — gün başlangıcı/sonu olarak compose.
    const fromIso = this.dateFrom ? `${this.dateFrom}T00:00:00.000Z` : undefined;
    const toIso   = this.dateTo   ? `${this.dateTo}T23:59:59.999Z`   : undefined;
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

  // ── 2026-05-13: Inline tarih düzenleme ─────────────────────────────────
  /**
   * HTML5 `<input type="date">` value formatı — YYYY-MM-DD (Türkiye tarihi).
   */
  protected dateInputValue(row: LivePlanEntry): string {
    if (!row.eventStartTime) return '';
    try {
      return formatIstanbulDate(row.eventStartTime); // "YYYY-MM-DD"
    } catch {
      return '';
    }
  }

  /**
   * Operatör date input'u değiştirdi → mevcut Türkiye saatini koruyarak
   * yeni UTC ISO compose et + PATCH.
   */
  protected onDateChange(row: LivePlanEntry, newLocalDate: string): void {
    if (!newLocalDate) return; // Browser temizleme — yoksay
    const currentDate = this.dateInputValue(row);
    if (currentDate === newLocalDate) return; // no-op
    // Mevcut Türkiye saatini koru (örn. "22:00")
    let currentTime: string;
    try {
      currentTime = formatIstanbulTime(row.eventStartTime); // "HH:mm"
    } catch {
      currentTime = '00:00';
    }
    let newIso: string;
    try {
      newIso = composeIstanbulIso(newLocalDate, currentTime);
    } catch {
      this.snack.open('Tarih biçimi geçersiz.', 'Kapat', { duration: 4000 });
      return;
    }
    this.saveEventStart(row, newIso);
  }

  /**
   * PATCH /api/v1/live-plan/:id (Schedule DEĞİL) + If-Match: row.version.
   * Body: `{ eventStartTime }`. Backend autoEndForStartOnly ile eventEndTime
   * +2h placeholder olarak update edilir (mevcut davranış).
   * Optimistic UI: local row hemen güncellenir; error'da rollback.
   */
  private saveEventStart(row: LivePlanEntry, newIso: string): void {
    const oldRows = this.rows();
    this.rows.set(oldRows.map((r) =>
      r.id === row.id ? { ...r, eventStartTime: newIso } : r,
    ));
    this.savingRowId.set(row.id);

    this.service.updateLivePlanEventStart(row.id, newIso, row.version).subscribe({
      next: (updated) => {
        this.rows.update((rs) => rs.map((r) => (r.id === updated.id ? updated : r)));
        this.savingRowId.set(null);
        this.snack.open('Tarih güncellendi.', 'Kapat', { duration: 2000 });
      },
      error: (err: HttpErrorResponse) => {
        this.savingRowId.set(null);
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
        const msg = err?.error?.message ?? 'Tarih güncellenemedi.';
        this.snack.open(msg, 'Kapat', { duration: 4000 });
      },
    });
  }

  private hasGroup(allowed: readonly string[]): boolean {
    if (allowed.length === 0) return true;
    if (isSkipAuthAllowed()) return true;
    const groups = (this.keycloak?.getKeycloakInstance()?.tokenParsed as BcmsTokenParsed | undefined)?.groups ?? [];
    if (groups.includes(GROUP.Admin)) return true;
    return groups.some((g) => allowed.includes(g));
  }
}
