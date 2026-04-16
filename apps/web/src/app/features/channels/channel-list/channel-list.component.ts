import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';

import { ApiService } from '../../../core/services/api.service';
import type { Channel } from '@bcms/shared';

@Component({
  selector: 'app-channel-list',
  standalone: true,
  imports: [CommonModule, MatTableModule, MatButtonModule, MatIconModule, MatChipsModule],
  template: `
    <div class="page-container">
      <h1>Kanallar</h1>
      <mat-table [dataSource]="channels()">
        <ng-container matColumnDef="name">
          <mat-header-cell *matHeaderCellDef>Kanal Adı</mat-header-cell>
          <mat-cell *matCellDef="let c">{{ c.name }}</mat-cell>
        </ng-container>
        <ng-container matColumnDef="type">
          <mat-header-cell *matHeaderCellDef>Tip</mat-header-cell>
          <mat-cell *matCellDef="let c"><mat-chip>{{ c.type }}</mat-chip></mat-cell>
        </ng-container>
        <ng-container matColumnDef="frequency">
          <mat-header-cell *matHeaderCellDef>Frekans</mat-header-cell>
          <mat-cell *matCellDef="let c">{{ c.frequency ?? '—' }}</mat-cell>
        </ng-container>
        <mat-header-row *matHeaderRowDef="['name','type','frequency']"></mat-header-row>
        <mat-row *matRowDef="let row; columns: ['name','type','frequency']"></mat-row>
      </mat-table>
    </div>
  `,
})
export class ChannelListComponent implements OnInit {
  channels = signal<Channel[]>([]);
  constructor(private api: ApiService) {}
  ngOnInit() { this.api.get<Channel[]>('/channels').subscribe((ch) => this.channels.set(ch)); }
}
