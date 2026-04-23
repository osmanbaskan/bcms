import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

export interface IngestPortBoardItemView {
  row: {
    id: string;
    source: 'live-plan' | 'studio-plan';
    sourceLabel: string;
    startTime: string;
    endTime: string;
    title: string;
    location: string;
  };
  gridRow: string;
  overlap: boolean;
}

export interface IngestPortBoardColumnView {
  port: string;
  items: IngestPortBoardItemView[];
}

export interface IngestPortBoardTimeLabel {
  label: string;
  gridRow: string;
}

@Component({
  selector: 'app-ingest-port-board',
  standalone: true,
  imports: [CommonModule, CdkDropList, CdkDrag, MatButtonModule, MatIconModule],
  template: `
    <div class="port-board-section" *ngIf="columns.length > 0">
      <div class="port-board-header">
        <div>
          <h3>Port Görünümü</h3>
          <p>Atanmış portlara göre ingest plan akışı</p>
        </div>
        <div class="port-board-actions">
          <span>{{ columns.length }} port</span>
          <button mat-stroked-button type="button" (click)="requestPrint.emit()">
            <mat-icon>print</mat-icon>
            Yazdır / Export
          </button>
        </div>
      </div>

      <div class="port-board-scroll">
        <div class="port-board-frame">
          <div class="port-board-times">
            <div class="port-board-times-head">Saat</div>
            <div class="port-board-times-body" [style.grid-template-rows]="gridTemplateRows">
              <div class="port-board-time-cell" *ngFor="let time of timeLabels" [style.grid-row]="time.gridRow">{{ time.label }}</div>
            </div>
          </div>

          <div
            class="port-board-grid"
            cdkDropList
            cdkDropListOrientation="horizontal"
            [cdkDropListData]="columns"
            (cdkDropListDropped)="onDrop($event)"
            [style.grid-template-columns]="'repeat(' + columns.length + ', minmax(220px, 1fr))'"
          >
            <section class="port-board-column" cdkDrag *ngFor="let column of columns; trackBy: trackPort">
              <header class="port-board-column-head">
                <button class="port-drag-handle" type="button" cdkDragHandle aria-label="Port kolonunu tası">
                  <mat-icon>drag_indicator</mat-icon>
                </button>
                <span>{{ column.port }}</span>
              </header>

              <div class="port-board-column-body" [style.grid-template-rows]="gridTemplateRows">
                <div class="port-board-slot-line" *ngFor="let time of timeLabels; trackBy: trackTime" [style.grid-row]="time.gridRow"></div>

                <article
                  class="port-board-item"
                  [class.overlap]="item.overlap"
                  [style.grid-row]="item.gridRow"
                  *ngFor="let item of column.items; trackBy: trackItem"
                >
                  <div class="port-board-time">{{ item.row.startTime }} - {{ item.row.endTime }}</div>
                  <strong>{{ item.row.title }}</strong>
                  <span>{{ item.row.location }}</span>
                  <span>{{ item.row.sourceLabel }}</span>
                  <span class="port-board-warning" *ngIf="item.overlap">Cakisma</span>
                </article>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .port-board-header,.port-board-actions,.port-board-times-head,.port-board-time-cell,.port-board-column-head,.port-drag-handle{display:flex;align-items:center}
    .port-board-section{margin:18px 14px 14px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(7,17,31,.7);overflow:hidden}
    .port-board-header{justify-content:space-between;gap:16px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08)}
    .port-board-header h3,.port-board-header p{margin:0}
    .port-board-header p{color:#9aa2b3;font-size:.8rem}
    .port-board-actions{gap:12px}
    .port-board-scroll{overflow-x:auto}
    .port-board-frame{display:grid;grid-template-columns:84px minmax(0,1fr);min-width:max-content}
    .port-board-times{border-right:1px solid rgba(255,255,255,.08);background:#203754}
    .port-board-times-head,.port-board-column-head{justify-content:center;min-height:42px;border-bottom:1px solid rgba(255,255,255,.08);background:#203754;font-weight:800}
    .port-board-times-head{color:#f5d24b;font-size:.82rem}
    .port-board-times-body{display:grid;background:rgba(189,210,232,.12)}
    .port-board-time-cell{justify-content:center;padding-top:6px;font-size:.74rem;font-weight:700;color:#d7e6f5}
    .port-board-grid{display:grid;min-width:max-content}
    .port-board-column{min-height:100%;border-right:1px solid rgba(255,255,255,.08);background:rgba(19,38,64,.72)}
    .port-board-column:last-child{border-right:0}
    .port-board-column-head{gap:4px;padding:0 8px;color:#f5d24b;font-size:.84rem;cursor:move}
    .port-drag-handle{justify-content:center;width:22px;height:22px;padding:0;border:0;background:transparent;color:#d9e6f2;cursor:move}
    .port-drag-handle mat-icon{font-size:18px;width:18px;height:18px}
    .port-board-column-body{position:relative;display:grid;padding:0;min-height:1176px;background:rgba(189,210,232,.08)}
    .port-board-slot-line{border-bottom:1px solid rgba(255,255,255,.07)}
    .port-board-item{z-index:1;margin:2px 4px;padding:8px 8px 9px;border:1px solid rgba(255,255,255,.08);background:#c7d8ec;color:#17304d;display:flex;flex-direction:column;gap:4px;overflow:hidden}
    .port-board-item.overlap{background:#ffd9d9;border-color:#ef5350}
    .port-board-time,.port-board-warning{font-weight:800}
    .port-board-warning{color:#b71c1c}
  `],
})
export class IngestPortBoardComponent {
  @Input() columns: IngestPortBoardColumnView[] = [];
  @Input() timeLabels: IngestPortBoardTimeLabel[] = [];
  @Input() gridTemplateRows = '';

  @Output() requestPrint = new EventEmitter<void>();
  @Output() portOrderChange = new EventEmitter<string[]>();

  trackPort = (_: number, column: IngestPortBoardColumnView) => column.port;
  trackTime = (_: number, time: IngestPortBoardTimeLabel) => time.label;
  trackItem = (_: number, item: IngestPortBoardItemView) => item.row.id;

  onDrop(event: CdkDragDrop<IngestPortBoardColumnView[]>) {
    if (event.previousIndex === event.currentIndex) return;
    const nextOrder = this.columns.map((column) => column.port);
    moveItemInArray(nextOrder, event.previousIndex, event.currentIndex);
    this.portOrderChange.emit(nextOrder);
  }
}
