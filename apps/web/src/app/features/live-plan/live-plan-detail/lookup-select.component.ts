import {
  ChangeDetectionStrategy, Component, EventEmitter,
  Input, OnInit, Output, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { FormsModule } from '@angular/forms';

import { ApiService } from '../../../core/services/api.service';
import {
  lookupEndpoint,
  type LookupListResponse,
  type LookupRow,
  type LookupType,
} from '../admin-lookups/lookup.types';

/**
 * Madde 5 M5-B10b — Reusable FK lookup selector.
 *
 * Backend: GET /api/v1/live-plan/lookups/:type → { items, total, page, pageSize }
 * Polymorphic tablolar (technical_companies, live_plan_equipment_options) için
 * `polymorphicType` set edilir → `?type=<POLY>` server-side filter.
 *
 * Component-local fetch (ApiService 60s cache kapsamında değil — lookup admin
 * write yapabilir; stale risk için içeride explicit refresh yok, tab reload ile
 * çözülür). Aktif olmayan kayıtlar backend filter (activeOnly=true default).
 */
@Component({
  selector: 'app-lookup-select',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule,
    MatFormFieldModule, MatSelectModule, MatProgressSpinnerModule,
  ],
  template: `
    <mat-form-field appearance="outline" subscriptSizing="dynamic" class="lookup-field">
      <mat-label>{{ label }}</mat-label>
      <mat-select
        [ngModel]="value"
        (ngModelChange)="onChange($event)"
        [disabled]="disabled || loading()"
        [compareWith]="compareById">
        <mat-option [value]="null">— Seçilmedi —</mat-option>
        @for (opt of options(); track opt.id) {
          <mat-option [value]="opt.id">{{ opt.label }}</mat-option>
        }
      </mat-select>
      @if (loading()) {
        <mat-spinner matSuffix diameter="16"></mat-spinner>
      }
      @if (errorMsg(); as e) {
        <mat-error>{{ e }}</mat-error>
      }
    </mat-form-field>
  `,
  styles: [`
    :host { display: block; }
    .lookup-field { width: 100%; }
  `],
})
export class LookupSelectComponent implements OnInit {
  private api = inject(ApiService);

  @Input({ required: true }) lookupType!: LookupType;
  @Input() polymorphicType?: string;
  @Input({ required: true }) label = '';
  @Input() value: number | null = null;
  @Input() disabled = false;

  @Output() valueChange = new EventEmitter<number | null>();

  options  = signal<LookupRow[]>([]);
  loading  = signal(true);
  errorMsg = signal<string | null>(null);

  ngOnInit(): void {
    this.fetch();
  }

  onChange(v: number | null): void {
    this.value = v;
    this.valueChange.emit(v);
  }

  compareById = (a: number | null, b: number | null): boolean => a === b;

  private fetch(): void {
    this.loading.set(true);
    this.errorMsg.set(null);
    const params: Record<string, string | number | boolean> = {
      activeOnly: true,
      page:       1,
      pageSize:   200, // backend cap 200; 1 panel-ful 200'ü aşan lookup beklenmez
    };
    if (this.polymorphicType) params['type'] = this.polymorphicType;
    this.api.get<LookupListResponse>(lookupEndpoint.list(this.lookupType), params).subscribe({
      next: (res) => {
        this.options.set(res.items);
        this.loading.set(false);
      },
      error: () => {
        this.options.set([]);
        this.loading.set(false);
        this.errorMsg.set('Lookup yüklenemedi');
      },
    });
  }
}
