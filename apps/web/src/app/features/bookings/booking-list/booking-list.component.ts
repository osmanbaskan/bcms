import { Component, OnInit, signal, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { ApiService } from '../../../core/services/api.service';
import type { Booking, PaginatedResponse } from '@bcms/shared';

interface ImportResult {
  created: number;
  skipped: number;
  errors: { row: number; reason: string }[];
}

@Component({
  selector: 'app-booking-list',
  standalone: true,
  imports: [
    CommonModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatSnackBarModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <div class="page-container">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px">
        <h1 style="margin:0">Rezervasyonlar</h1>
        <div style="display:flex; gap:8px; align-items:center">
          <button mat-stroked-button color="primary" (click)="fileInput.click()" [disabled]="importing()">
            <mat-icon>upload_file</mat-icon>
            Excel İçe Aktar
          </button>
          <mat-spinner *ngIf="importing()" diameter="24"></mat-spinner>
          <input #fileInput type="file" accept=".xlsx" style="display:none"
            (change)="onFileSelected($event)">
        </div>
      </div>

      <!-- Import sonuç özeti -->
      <mat-card *ngIf="importResult()" style="margin-bottom:16px; background:#f5f5f5">
        <mat-card-content>
          <strong>Import Sonucu:</strong>
          oluşturuldu: {{ importResult()!.created }},
          atlandı: {{ importResult()!.skipped }}
          <span *ngIf="importResult()!.errors.length" style="color:#c62828">
            — {{ importResult()!.errors.length }} hata
            <span *ngFor="let e of importResult()!.errors">
              (Satır {{ e.row }}: {{ e.reason }})
            </span>
          </span>
        </mat-card-content>
      </mat-card>

      <mat-table [dataSource]="bookings()" class="mat-elevation-z2">
        <ng-container matColumnDef="schedule">
          <mat-header-cell *matHeaderCellDef>Program</mat-header-cell>
          <mat-cell *matCellDef="let b">{{ b.schedule?.title ?? '—' }}</mat-cell>
        </ng-container>
        <ng-container matColumnDef="requestedBy">
          <mat-header-cell *matHeaderCellDef>Talep Eden</mat-header-cell>
          <mat-cell *matCellDef="let b">{{ b.requestedBy }}</mat-cell>
        </ng-container>
        <ng-container matColumnDef="team">
          <mat-header-cell *matHeaderCellDef>Takım</mat-header-cell>
          <mat-cell *matCellDef="let b">{{ b.team?.name ?? '—' }}</mat-cell>
        </ng-container>
        <ng-container matColumnDef="status">
          <mat-header-cell *matHeaderCellDef>Durum</mat-header-cell>
          <mat-cell *matCellDef="let b">
            <span [class]="'status-badge ' + b.status">{{ statusLabel(b.status) }}</span>
          </mat-cell>
        </ng-container>
        <ng-container matColumnDef="version">
          <mat-header-cell *matHeaderCellDef>v</mat-header-cell>
          <mat-cell *matCellDef="let b">
            <span [matTooltip]="'Versiyon ' + b.version" style="color:#888; font-size:12px">
              v{{ b.version }}
            </span>
          </mat-cell>
        </ng-container>
        <ng-container matColumnDef="actions">
          <mat-header-cell *matHeaderCellDef></mat-header-cell>
          <mat-cell *matCellDef="let b">
            <button mat-icon-button color="primary" (click)="approve(b)"
              matTooltip="Onayla" [disabled]="b.status !== 'PENDING'">
              <mat-icon>check_circle</mat-icon>
            </button>
            <button mat-icon-button color="warn" (click)="reject(b)"
              matTooltip="Reddet" [disabled]="b.status !== 'PENDING'">
              <mat-icon>cancel</mat-icon>
            </button>
          </mat-cell>
        </ng-container>
        <mat-header-row *matHeaderRowDef="columns"></mat-header-row>
        <mat-row *matRowDef="let row; columns: columns"></mat-row>
      </mat-table>
    </div>
  `,
})
export class BookingListComponent implements OnInit {
  @ViewChild('fileInput') fileInputRef!: ElementRef<HTMLInputElement>;

  columns     = ['schedule', 'requestedBy', 'team', 'status', 'version', 'actions'];
  bookings    = signal<Booking[]>([]);
  importing   = signal(false);
  importResult = signal<ImportResult | null>(null);

  constructor(private api: ApiService, private snackBar: MatSnackBar) {}

  ngOnInit() {
    this.api.get<PaginatedResponse<Booking>>('/bookings').subscribe((res) => this.bookings.set(res.data));
  }

  approve(b: Booking) {
    this.api.patch(`/bookings/${b.id}`, { status: 'APPROVED' }, b.version).subscribe({
      next: () => this.ngOnInit(),
      error: (err) => this.showError(err),
    });
  }

  reject(b: Booking) {
    this.api.patch(`/bookings/${b.id}`, { status: 'REJECTED' }, b.version).subscribe({
      next: () => this.ngOnInit(),
      error: (err) => this.showError(err),
    });
  }

  onFileSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    this.importing.set(true);
    this.importResult.set(null);

    const fd = new FormData();
    fd.append('file', file);

    this.api.postFile<ImportResult>('/bookings/import', fd).subscribe({
      next: (result) => {
        this.importing.set(false);
        this.importResult.set(result);
        this.fileInputRef.nativeElement.value = '';
        this.snackBar.open(
          `Import tamamlandı: ${result.created} oluşturuldu, ${result.errors.length} hata`,
          'Kapat', { duration: 5000 }
        );
        this.ngOnInit();
      },
      error: (err) => {
        this.importing.set(false);
        this.fileInputRef.nativeElement.value = '';
        this.showError(err);
      },
    });
  }

  statusLabel(s: string): string {
    const map: Record<string, string> = {
      PENDING: 'Bekliyor', APPROVED: 'Onaylandı',
      REJECTED: 'Reddedildi', CANCELLED: 'İptal',
    };
    return map[s] ?? s;
  }

  private showError(err: { status?: number; error?: { message?: string } }) {
    const msg = err.status === 412
      ? 'Versiyon çakışması — sayfa yenileniyor'
      : (err.error?.message ?? 'Bir hata oluştu');
    this.snackBar.open(msg, 'Kapat', { duration: 4000 });
    if (err.status === 412) this.ngOnInit();
  }
}
