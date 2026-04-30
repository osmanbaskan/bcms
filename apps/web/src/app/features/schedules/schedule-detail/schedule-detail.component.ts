import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';

import { ScheduleService } from '../../../core/services/schedule.service';
import type { Schedule, Incident } from '@bcms/shared';

@Component({
  selector: 'app-schedule-detail',
  standalone: true,
  imports: [
    CommonModule, RouterLink,
    MatCardModule, MatTabsModule, MatButtonModule, MatIconModule, MatTableModule,
  ],
  template: `
    <div class="page-container">
      @if (schedule()) {
        <div class="page-header">
          <div>
            <h1>{{ schedule()!.title }}</h1>
            <span [class]="'status-badge ' + schedule()!.status">{{ schedule()!.status }}</span>
          </div>
          <div class="header-actions">
            <a mat-stroked-button routerLink="/schedules">
              <mat-icon>arrow_back</mat-icon> Geri
            </a>
            <a mat-raised-button color="primary" [routerLink]="['/schedules', schedule()!.id, 'edit']">
              <mat-icon>edit</mat-icon> Düzenle
            </a>
          </div>
        </div>

        <mat-card class="info-card">
          <mat-card-content>
            <div class="info-grid">
              <div><label>Kanal</label><span>{{ schedule()!.channel?.name }}</span></div>
              <div><label>Başlangıç</label><span>{{ schedule()!.startTime | date:'dd.MM.yyyy HH:mm' }}</span></div>
              <div><label>Bitiş</label><span>{{ schedule()!.endTime | date:'dd.MM.yyyy HH:mm' }}</span></div>
              <div><label>Oluşturan</label><span>{{ schedule()!.createdBy }}</span></div>
              <div><label>Versiyon</label><span>v{{ schedule()!.version }}</span></div>
            </div>
          </mat-card-content>
        </mat-card>

        <mat-tab-group>
          <mat-tab label="Ekip iş takip ({{ schedule()!.bookings?.length ?? 0 }})">
            <div class="tab-content">
              @if (schedule()!.bookings?.length) {
                <mat-table [dataSource]="schedule()!.bookings!">
                  <ng-container matColumnDef="requestedBy">
                    <mat-header-cell *matHeaderCellDef>Talep Eden</mat-header-cell>
                    <mat-cell *matCellDef="let b">{{ b.requestedBy }}</mat-cell>
                  </ng-container>
                  <ng-container matColumnDef="status">
                    <mat-header-cell *matHeaderCellDef>Durum</mat-header-cell>
                    <mat-cell *matCellDef="let b"><span [class]="'status-badge '+b.status">{{ b.status }}</span></mat-cell>
                  </ng-container>
                  <ng-container matColumnDef="createdAt">
                    <mat-header-cell *matHeaderCellDef>Tarih</mat-header-cell>
                    <mat-cell *matCellDef="let b">{{ b.createdAt | date:'dd.MM.yyyy HH:mm' }}</mat-cell>
                  </ng-container>
                  <mat-header-row *matHeaderRowDef="['requestedBy','status','createdAt']"></mat-header-row>
                  <mat-row *matRowDef="let row; columns: ['requestedBy','status','createdAt']"></mat-row>
                </mat-table>
              } @else {
                <p class="empty-state">Rezervasyon yok</p>
              }
            </div>
          </mat-tab>

          <mat-tab label="Olaylar ({{ schedule()!.incidents?.length ?? 0 }})">
            <div class="tab-content">
              @for (inc of schedule()!.incidents; track inc.id) {
                <div class="incident-item">
                  <span [class]="'status-badge ' + inc.severity">{{ inc.severity }}</span>
                  <span>{{ inc.eventType }}</span>
                  <span class="tc">{{ inc.tcIn }}</span>
                  <small>{{ inc.createdAt | date:'HH:mm:ss' }}</small>
                </div>
              }
              @if (!schedule()!.incidents?.length) {
                <p class="empty-state">Olay kaydı yok</p>
              }
            </div>
          </mat-tab>
        </mat-tab-group>
      }
    </div>
  `,
  styles: [`
    .page-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px; }
    .header-actions { display:flex; gap:8px; }
    .info-card { margin-bottom:16px; }
    .info-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:16px; }
    .info-grid div label { display:block; font-size:0.75rem; color:#aaa; margin-bottom:2px; }
    .tab-content { padding:16px 0; }
    .incident-item { display:flex; gap:12px; align-items:center; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.05); }
    .tc { font-family:monospace; font-size:0.85rem; color:#aaa; }
    .empty-state { color:#777; padding:16px 0; }
  `],
})
export class ScheduleDetailComponent implements OnInit {
  schedule = signal<(Schedule & { bookings?: unknown[]; incidents?: Incident[]; channel?: { name: string } | null }) | null>(null);

  constructor(
    private scheduleSvc: ScheduleService,
    private route: ActivatedRoute,
  ) {}

  ngOnInit() {
    const id = Number(this.route.snapshot.params['id']);
    this.scheduleSvc.getSchedule(id).subscribe({
      next: (s) => this.schedule.set(s),
      error: () => this.schedule.set(null),
    });
  }
}
