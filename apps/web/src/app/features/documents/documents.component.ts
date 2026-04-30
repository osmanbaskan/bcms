import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-documents',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatIconModule],
  template: `
    <mat-card class="documents-card">
      <mat-card-header>
        <mat-card-title>
          <mat-icon class="title-icon">description</mat-icon>
          Dökümanlar
        </mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <p class="placeholder">İçerik yakında eklenecek.</p>
      </mat-card-content>
    </mat-card>
  `,
  styles: [`
    .documents-card { max-width: 960px; margin: 0 auto; }
    .title-icon { vertical-align: middle; margin-right: 8px; }
    .placeholder { color: rgba(0,0,0,0.54); padding: 16px 0; }
  `],
})
export class DocumentsComponent {}
