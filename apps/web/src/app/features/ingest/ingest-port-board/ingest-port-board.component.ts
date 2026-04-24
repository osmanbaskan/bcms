import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, HostListener, Input, Output, ViewChild } from '@angular/core';
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

type PortBoardZoom = 'tight' | 'normal' | 'wide';

@Component({
  selector: 'app-ingest-port-board',
  standalone: true,
  imports: [CommonModule, CdkDropList, CdkDrag, MatButtonModule, MatIconModule],
  template: `
    <div class="port-board-section" [class.full-page]="fullPage" [class.is-fullscreen]="isFullscreen" *ngIf="columns.length > 0" #boardRoot>
      <div class="port-board-header">
        <div>
          <h3>Port Görünümü</h3>
          <p>Atanmış portlara göre ingest plan akışı</p>
        </div>
        <div class="port-board-actions">
          <div class="port-board-zoom" role="group" aria-label="Zoom Seviyesi">
            <button type="button" [class.active]="zoom === 'tight'" (click)="setZoom('tight')">Sıkı</button>
            <button type="button" [class.active]="zoom === 'normal'" (click)="setZoom('normal')">Normal</button>
            <button type="button" [class.active]="zoom === 'wide'" (click)="setZoom('wide')">Geniş</button>
          </div>
          <span>{{ columns.length }} port</span>
          <button mat-stroked-button type="button" (click)="toggleFullscreen()">
            <mat-icon>{{ isFullscreen ? 'fullscreen_exit' : 'fullscreen' }}</mat-icon>
            {{ isFullscreen ? 'Tam Ekrandan Çık' : 'Tam Ekran' }}
          </button>
          <button mat-stroked-button type="button" (click)="requestPrint.emit()">
            <mat-icon>print</mat-icon>
            Yazdır / Export
          </button>
        </div>
      </div>

      <div class="port-board-scroll">
        <div class="port-board-stack">
          <div class="port-board-frame" *ngFor="let rowColumns of portColumnRows(); let rowIndex = index">
            <div
              class="port-board-grid"
              cdkDropList
              cdkDropListOrientation="horizontal"
              [cdkDropListData]="rowColumns"
              (cdkDropListDropped)="onDrop($event, rowIndex)"
              [style.grid-template-columns]="gridTemplateColumns(rowColumns)"
            >
              <section class="port-board-column" cdkDrag *ngFor="let column of rowColumns; trackBy: trackPort">
                <div class="port-board-column-body" [style.grid-template-rows]="gridTemplateRows">
                  <div class="port-board-column-tag">
                    <button class="port-drag-handle" type="button" cdkDragHandle aria-label="Port kolonunu tası">
                      <mat-icon>drag_indicator</mat-icon>
                    </button>
                    <span>{{ column.port }}</span>
                  </div>

                  <article
                    class="port-board-item"
                    [class.overlap]="item.overlap"
                    [style.grid-row]="item.gridRow"
                    *ngFor="let item of column.items; trackBy: trackItem"
                  >
                    <div class="port-board-time">{{ item.row.startTime }} - {{ item.row.endTime }}</div>
                    <strong [title]="item.row.title">
                      <span class="title-line" *ngFor="let line of titleLines(item.row.title)">{{ line }}</span>
                    </strong>
                    <span class="port-board-warning" *ngIf="item.overlap">Cakisma</span>
                  </article>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .port-board-header,.port-board-actions,.port-drag-handle,.port-board-column-tag{display:flex;align-items:center}
    .port-board-section{margin:18px 14px 14px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(7,17,31,.7);overflow:hidden}
    .port-board-section.full-page{margin:0;border-radius:0;border-left:0;border-right:0}
    .port-board-header{justify-content:space-between;gap:16px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08)}
    .port-board-header h3,.port-board-header p{margin:0}
    .port-board-header p{color:#9aa2b3;font-size:.8rem}
    .port-board-actions{gap:12px;flex-wrap:wrap;justify-content:flex-end}
    .port-board-zoom{display:inline-flex;border:1px solid rgba(255,255,255,.14);border-radius:999px;overflow:hidden}
    .port-board-zoom button{min-width:64px;height:34px;border:0;background:transparent;color:#c8d3e5}
    .port-board-zoom button.active{background:rgba(155,211,255,.16);color:#fff}
    .port-board-scroll{overflow-x:auto}
    .port-board-section.full-page .port-board-scroll{height:calc(100vh - 250px);overflow:auto}
    .port-board-section.is-fullscreen{margin:0;border:0;border-radius:0}
    .port-board-section.is-fullscreen .port-board-scroll{height:calc(100vh - 72px)}
    .port-board-stack{display:flex;flex-direction:column;gap:10px;padding-bottom:10px}
    .port-board-frame{display:block;min-width:max-content}
    .port-board-grid{display:grid;min-width:max-content}
    .port-board-column{min-height:100%;border-right:1px solid rgba(255,255,255,.08);background:rgba(19,38,64,.72)}
    .port-board-column:last-child{border-right:0}
    .port-board-column-tag{position:absolute;top:2px;left:2px;z-index:3;gap:1px;padding:0 2px;background:transparent;color:#f5d24b;font-size:.58rem;cursor:move}
    .port-drag-handle{justify-content:center;width:18px;height:18px;padding:0;border:0;background:transparent;color:#d9e6f2;cursor:move}
    .port-drag-handle mat-icon{font-size:16px;width:16px;height:16px}
    .port-board-column-body{position:relative;display:grid;padding:0;min-height:240px;background:rgba(189,210,232,.08)}
    .port-board-item{z-index:1;margin:1px 0 0;padding:1px 1px 2px;border:1px solid rgba(255,255,255,.08);background:#c7d8ec;color:#17304d;display:flex;flex-direction:column;gap:1px;overflow:hidden}
    .port-board-item:first-of-type{margin-top:10px}
    .port-board-item.overlap{background:#ffd9d9;border-color:#ef5350}
    .port-board-item strong{display:flex;flex-direction:column;font-size:1.44rem;line-height:.92;overflow:hidden}
    .title-line{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .port-board-time,.port-board-warning{font-weight:800;font-size:1rem;line-height:1}
    .port-board-warning{color:#b71c1c}
  `],
})
export class IngestPortBoardComponent {
  @ViewChild('boardRoot') boardRoot?: ElementRef<HTMLElement>;
  @Input() columns: IngestPortBoardColumnView[] = [];
  @Input() timeLabels: IngestPortBoardTimeLabel[] = [];
  @Input() gridTemplateRows = '';
  @Input() fullPage = false;
  @Input() columnMinWidth = 220;
  @Input() rowCount = 5;

  @Output() requestPrint = new EventEmitter<void>();
  @Output() portOrderChange = new EventEmitter<string[]>();

  zoom: PortBoardZoom = 'normal';
  isFullscreen = false;

  trackPort = (_: number, column: IngestPortBoardColumnView) => column.port;
  trackItem = (_: number, item: IngestPortBoardItemView) => item.row.id;

  titleLines(title: string): string[] {
    const parts = title.split(' - ').map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts.slice(0, 3) : [title];
  }

  portColumnRows(): IngestPortBoardColumnView[][] {
    const chunkSize = Math.max(1, Math.ceil(this.columns.length / this.rowCount));
    const rows: IngestPortBoardColumnView[][] = [];
    for (let index = 0; index < this.columns.length; index += chunkSize) {
      rows.push(this.columns.slice(index, index + chunkSize));
    }
    return rows;
  }

  gridTemplateColumns(columns: IngestPortBoardColumnView[]): string {
    return `repeat(${columns.length}, minmax(${this.currentColumnWidth()}px, 1fr))`;
  }

  setZoom(zoom: PortBoardZoom) {
    this.zoom = zoom;
  }

  async toggleFullscreen() {
    const root = this.boardRoot?.nativeElement;
    if (!root) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      this.isFullscreen = false;
      return;
    }
    await root.requestFullscreen();
    this.isFullscreen = true;
  }

  @HostListener('document:fullscreenchange')
  syncFullscreenState() {
    this.isFullscreen = !!document.fullscreenElement;
  }

  onDrop(event: CdkDragDrop<IngestPortBoardColumnView[]>, rowIndex: number) {
    if (event.previousIndex === event.currentIndex) return;
    const rows = this.portColumnRows().map((row) => [...row]);
    const targetRow = rows[rowIndex] ?? [];
    const nextOrder = this.columns.map((column) => column.port);
    const startOffset = rows.slice(0, rowIndex).reduce((sum, row) => sum + row.length, 0);
    moveItemInArray(targetRow, event.previousIndex, event.currentIndex);
    nextOrder.splice(startOffset, targetRow.length, ...targetRow.map((column) => column.port));
    this.portOrderChange.emit(nextOrder);
  }

  private currentColumnWidth(): number {
    if (this.zoom === 'tight') return Math.max(24, this.columnMinWidth - 12);
    if (this.zoom === 'wide') return this.columnMinWidth + 12;
    return this.columnMinWidth;
  }
}
