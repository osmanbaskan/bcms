import { Component, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatNativeDateModule } from '@angular/material/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatChipsModule } from '@angular/material/chips';
import { ApiService } from '../../core/services/api.service';

/** JSON value tipi — `any` yerine güvenli union (HIGH-FE-001 fix 2026-05-05). */
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

interface AuditLog {
  id: number;
  entityType: string;
  entityId: number;
  action: string;
  beforePayload: JsonValue | null;
  afterPayload: JsonValue | null;
  user: string;
  ipAddress: string | null;
  timestamp: string;
}

interface AuditResponse {
  data: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const ENTITY_TYPES = [
  'Schedule', 'Booking', 'Channel', 'StudioPlan', 'StudioPlanSlot',
  'IngestJob', 'IngestPlanItem', 'RecordingPort', 'Incident',
  'User', 'Match', 'League', 'AuditLog',
];

const ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'UPSERT', 'CREATEMANY', 'UPDATEMANY', 'DELETEMANY'];

const ACTION_CLASS: Record<string, string> = {
  CREATE: 'a-create', CREATEMANY: 'a-create',
  UPDATE: 'a-update', UPDATEMANY: 'a-update', UPSERT: 'a-update',
  DELETE: 'a-delete', DELETEMANY: 'a-delete',
};

@Component({
  selector: 'app-audit-log',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule,
    MatSelectModule, MatDatepickerModule, MatNativeDateModule,
    MatProgressBarModule, MatChipsModule,
  ],
  template: `
    <div class="page-container">
      <div class="page-header">
        <div>
          <h1>Audit Logları</h1>
          <p class="subtitle">Tüm yazma işlemlerinin kayıtları — yalnızca SystemEng</p>
        </div>
        <button mat-stroked-button (click)="load()">
          <mat-icon>refresh</mat-icon> Yenile
        </button>
      </div>

      <!-- Filtreler -->
      <div class="filter-bar">
        <mat-form-field appearance="outline" class="filter-field">
          <mat-label>Tablo</mat-label>
          <mat-select [(ngModel)]="filterEntityType">
            <mat-option value="">Tümü</mat-option>
            @for (et of entityTypes; track et) {
              <mat-option [value]="et">{{ et }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline" class="filter-field">
          <mat-label>İşlem</mat-label>
          <mat-select [(ngModel)]="filterAction">
            <mat-option value="">Tümü</mat-option>
            @for (a of actions; track a) {
              <mat-option [value]="a">{{ a }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline" class="filter-field">
          <mat-label>Kullanıcı</mat-label>
          <input matInput [(ngModel)]="filterUser" (keyup.enter)="search()" />
        </mat-form-field>

        <mat-form-field appearance="outline" class="filter-field filter-field-sm">
          <mat-label>Kayıt ID</mat-label>
          <input matInput type="number" [(ngModel)]="filterEntityId" (keyup.enter)="search()" />
        </mat-form-field>

        <mat-form-field appearance="outline" class="filter-field">
          <mat-label>Başlangıç</mat-label>
          <input matInput [matDatepicker]="fromPicker" [(ngModel)]="filterFrom" />
          <mat-datepicker-toggle matIconSuffix [for]="fromPicker"></mat-datepicker-toggle>
          <mat-datepicker #fromPicker></mat-datepicker>
        </mat-form-field>

        <mat-form-field appearance="outline" class="filter-field">
          <mat-label>Bitiş</mat-label>
          <input matInput [matDatepicker]="toPicker" [(ngModel)]="filterTo" />
          <mat-datepicker-toggle matIconSuffix [for]="toPicker"></mat-datepicker-toggle>
          <mat-datepicker #toPicker></mat-datepicker>
        </mat-form-field>

        <button mat-flat-button color="primary" (click)="search()">
          <mat-icon>search</mat-icon> Ara
        </button>
        <button mat-stroked-button (click)="clearFilters()">
          <mat-icon>clear</mat-icon>
        </button>
      </div>

      @if (loading()) {
        <mat-progress-bar mode="indeterminate"></mat-progress-bar>
      }

      @if (!loading() && logs().length === 0) {
        <p class="empty">Kayıt bulunamadı.</p>
      }

      @if (logs().length > 0) {
        <div class="audit-table">
          <div class="audit-head">
            <span>Zaman</span>
            <span>İşlem</span>
            <span>Tablo</span>
            <span>ID</span>
            <span>Kullanıcı</span>
            <span>IP</span>
            <span></span>
          </div>

          @for (log of logs(); track log.id) {
            <div class="audit-row" [class.has-detail]="log.beforePayload || log.afterPayload">
              <span class="ts">{{ log.timestamp | date:'dd.MM.yy HH:mm:ss' }}</span>
              <span class="action-badge" [ngClass]="actionClass(log.action)">{{ log.action }}</span>
              <span class="entity-type">{{ log.entityType }}</span>
              <span class="entity-id">{{ log.entityId }}</span>
              <span class="user-col">{{ log.user }}</span>
              <span class="ip-col">{{ log.ipAddress || '—' }}</span>
              <button mat-icon-button class="expand-btn"
                      [disabled]="!log.beforePayload && !log.afterPayload"
                      (click)="toggleExpand(log.id)">
                <mat-icon>{{ expandedId() === log.id ? 'expand_less' : 'expand_more' }}</mat-icon>
              </button>
            </div>

            @if (expandedId() === log.id) {
              <div class="audit-detail">
                <div class="json-panels">
                  @if (log.beforePayload) {
                    <div class="json-panel">
                      <div class="json-label">
                        <mat-icon class="json-icon before">history</mat-icon> Önceki Durum
                      </div>
                      <pre class="json-pre">{{ formatJson(log.beforePayload) }}</pre>
                    </div>
                  }
                  @if (log.afterPayload) {
                    <div class="json-panel">
                      <div class="json-label">
                        <mat-icon class="json-icon after">update</mat-icon> Yeni Durum
                      </div>
                      <pre class="json-pre">{{ formatJson(log.afterPayload) }}</pre>
                    </div>
                  }
                </div>
              </div>
            }
          }
        </div>

        <!-- Sayfalama -->
        <div class="pagination">
          <span class="total-info">Toplam {{ total() }} kayıt · Sayfa {{ page() }} / {{ totalPages() }}</span>
          <div class="pag-buttons">
            <button mat-icon-button [disabled]="page() <= 1" (click)="goPage(1)">
              <mat-icon>first_page</mat-icon>
            </button>
            <button mat-icon-button [disabled]="page() <= 1" (click)="goPage(page() - 1)">
              <mat-icon>chevron_left</mat-icon>
            </button>
            <button mat-icon-button [disabled]="page() >= totalPages()" (click)="goPage(page() + 1)">
              <mat-icon>chevron_right</mat-icon>
            </button>
            <button mat-icon-button [disabled]="page() >= totalPages()" (click)="goPage(totalPages())">
              <mat-icon>last_page</mat-icon>
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    /* beINport UI V2 (2026-05-04) — token-based restyle, HTML/logic untouched */
    .page-container { padding: var(--bp-sp-6) var(--bp-sp-8) var(--bp-sp-8); }
    .page-header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      margin-bottom: var(--bp-sp-4);
    }
    .page-header h1 {
      margin: 0 0 4px;
      font-family: var(--bp-font-display);
      font-size: var(--bp-text-3xl);
      font-weight: var(--bp-fw-semibold);
      letter-spacing: var(--bp-ls-tight);
      color: var(--bp-fg-1);
    }
    .subtitle { margin: 0; color: var(--bp-fg-3); font-size: 12.5px; }
    .empty { color: var(--bp-fg-3); margin-top: var(--bp-sp-6); padding: var(--bp-sp-6); text-align: center; }

    .filter-bar {
      display: flex; align-items: center; gap: var(--bp-sp-2); flex-wrap: wrap;
      padding: var(--bp-sp-3) var(--bp-sp-4);
      margin-bottom: var(--bp-sp-4);
      background: var(--bp-bg-2);
      border: 1px solid var(--bp-line-2);
      border-radius: var(--bp-r-lg);
    }
    .filter-field { min-width: 140px; }
    .filter-field-sm { min-width: 100px; max-width: 110px; }
    .filter-field ::ng-deep .mat-mdc-form-field-subscript-wrapper { display: none; }
    .filter-field ::ng-deep .mat-mdc-text-field-wrapper { height: 42px; }
    .filter-field ::ng-deep .mat-mdc-form-field-infix { padding-top: 8px; padding-bottom: 8px; min-height: 42px; }

    .audit-table {
      background: var(--bp-bg-2);
      border: 1px solid var(--bp-line-2);
      border-radius: var(--bp-r-lg);
      overflow: hidden;
    }

    .audit-head {
      display: grid;
      grid-template-columns: 140px 110px 160px 60px 130px 120px 48px;
      padding: 10px 14px;
      background: var(--bp-bg-3);
      font-size: 9.5px;
      font-weight: var(--bp-fw-bold);
      text-transform: uppercase;
      letter-spacing: var(--bp-ls-eyebrow);
      color: var(--bp-fg-2);
      border-bottom: 1px solid var(--bp-line-2);
    }

    .audit-row {
      display: grid;
      grid-template-columns: 140px 110px 160px 60px 130px 120px 48px;
      align-items: center;
      padding: 9px 14px;
      font-size: 12.5px;
      border-bottom: 1px solid var(--bp-line-2);
      transition: background var(--bp-dur-fast);
      color: var(--bp-fg-1);
    }
    .audit-row:hover { background: rgba(124, 58, 237, 0.06); }
    .audit-row:last-child { border-bottom: none; }

    .ts {
      font-family: var(--bp-font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 11.5px;
      color: var(--bp-fg-3);
    }
    .entity-type { font-family: var(--bp-font-mono); font-size: 11.5px; color: var(--bp-fg-2); }
    .entity-id {
      font-family: var(--bp-font-mono);
      font-variant-numeric: tabular-nums;
      color: var(--bp-fg-3);
      font-size: 11.5px;
    }
    .user-col { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bp-fg-1); }
    .ip-col {
      font-family: var(--bp-font-mono);
      font-size: 11px;
      color: var(--bp-fg-3);
    }
    .expand-btn { width: 32px; height: 32px; line-height: 32px; }

    .action-badge {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 3px 8px; border-radius: var(--bp-r-sm);
      font-size: 9.5px; font-weight: var(--bp-fw-bold); letter-spacing: var(--bp-ls-status);
      width: fit-content;
    }
    .a-create { background: var(--bp-status-COMPLETED-bg); color: var(--bp-status-COMPLETED-fg); }
    .a-update { background: var(--bp-status-CONFIRMED-bg); color: var(--bp-status-CONFIRMED-fg); }
    .a-delete { background: var(--bp-status-REJECTED-bg);  color: var(--bp-status-REJECTED-fg); }

    .audit-detail {
      background: var(--bp-bg-0);
      border-bottom: 1px solid var(--bp-line-2);
      padding: var(--bp-sp-4);
    }
    .json-panels { display: flex; gap: var(--bp-sp-4); flex-wrap: wrap; }
    .json-panel { flex: 1; min-width: 280px; }
    .json-label {
      display: flex; align-items: center; gap: 6px;
      font-size: 10.5px; font-weight: var(--bp-fw-bold); text-transform: uppercase;
      letter-spacing: var(--bp-ls-eyebrow); color: var(--bp-fg-3);
      margin-bottom: 8px;
    }
    .json-icon { font-size: 15px; width: 15px; height: 15px; }
    .json-icon.before { color: var(--bp-status-REJECTED-fg); }
    .json-icon.after  { color: var(--bp-status-COMPLETED-fg); }
    .json-pre {
      margin: 0; padding: 10px 12px;
      background: var(--bp-bg-1);
      border: 1px solid var(--bp-line-2);
      border-radius: var(--bp-r-md);
      font-family: var(--bp-font-mono);
      font-size: 11.5px; line-height: 1.6;
      overflow-x: auto; max-height: 320px; overflow-y: auto;
      color: var(--bp-fg-2); white-space: pre-wrap; word-break: break-all;
    }

    .pagination {
      display: flex; align-items: center; justify-content: space-between;
      padding: var(--bp-sp-3) var(--bp-sp-1);
      margin-top: var(--bp-sp-2);
    }
    .total-info { font-size: 12px; color: var(--bp-fg-3); font-family: var(--bp-font-mono); }
    .pag-buttons { display: flex; gap: 2px; }
  `],
})
export class AuditLogComponent implements OnInit {
  readonly entityTypes = ENTITY_TYPES;
  readonly actions = ACTIONS;

  logs = signal<AuditLog[]>([]);
  total = signal(0);
  page = signal(1);
  totalPages = signal(1);
  loading = signal(false);
  expandedId = signal<number | null>(null);

  filterEntityType = '';
  filterAction = '';
  filterUser = '';
  filterEntityId: number | null = null;
  filterFrom: Date | null = null;
  filterTo: Date | null = null;

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.load();
  }

  search() {
    this.page.set(1);
    this.load();
  }

  load() {
    this.loading.set(true);
    const params: Record<string, any> = {
      page: this.page(),
      pageSize: 50,
    };
    if (this.filterEntityType) params['entityType'] = this.filterEntityType;
    if (this.filterAction)     params['action']     = this.filterAction;
    if (this.filterUser?.trim()) params['user']     = this.filterUser.trim();
    if (this.filterEntityId)   params['entityId']   = this.filterEntityId;
    if (this.filterFrom)       params['from']       = this.filterFrom.toISOString();
    if (this.filterTo) {
      const to = new Date(this.filterTo);
      to.setHours(23, 59, 59, 999);
      params['to'] = to.toISOString();
    }

    this.api.get<AuditResponse>('/audit', params).subscribe({
      next: (res) => {
        this.logs.set(res.data);
        this.total.set(res.total);
        this.totalPages.set(res.totalPages);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
      },
    });
  }

  goPage(p: number) {
    this.page.set(p);
    this.load();
  }

  toggleExpand(id: number) {
    this.expandedId.set(this.expandedId() === id ? null : id);
  }

  clearFilters() {
    this.filterEntityType = '';
    this.filterAction = '';
    this.filterUser = '';
    this.filterEntityId = null;
    this.filterFrom = null;
    this.filterTo = null;
    this.search();
  }

  actionClass(action: string): string {
    return ACTION_CLASS[action] ?? 'a-update';
  }

  formatJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
}
