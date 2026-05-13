import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, HostListener, Input, Output, ViewChild } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

export interface IngestPortBoardItemView {
  row: {
    id: string;
    source: 'live-plan' | 'studio-plan' | 'ingest-plan';
    sourceLabel: string;
    startTime: string;
    endTime: string;
    title: string;
    location: string;
    planNote: string;
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
                    <span class="port-board-note" *ngIf="item.row.planNote">{{ item.row.planNote }}</span>
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
    .port-board-section.is-fullscreen{display:flex;flex-direction:column;height:100vh;margin:0;border:0;border-radius:0;background:rgba(7,17,31,.96);zoom:100%}
    .port-board-section.is-fullscreen .port-board-header{flex:0 0 auto}
    /* Fullscreen: scroll kapatılır; içerik viewport'a sığar */
    .port-board-section.is-fullscreen .port-board-scroll{flex:1 1 auto;height:auto;min-height:0;overflow:hidden}
    .port-board-stack{display:flex;flex-direction:column;gap:10px;padding-bottom:10px}
    /* Fullscreen: satırlar eşit yükseklikte grid'e dönüşür, taşmaz */
    .port-board-section.is-fullscreen .port-board-stack{display:grid;grid-auto-rows:1fr;gap:4px;padding-bottom:0;height:100%;overflow:hidden}
    .port-board-frame{display:block;min-width:max-content}
    .port-board-section.is-fullscreen .port-board-frame{min-width:0;height:100%;overflow:hidden}
    .port-board-grid{display:grid;min-width:max-content}
    .port-board-section.is-fullscreen .port-board-grid{min-width:0;height:100%;overflow:hidden}
    .port-board-column{min-height:100%;border-right:1px solid rgba(255,255,255,.08);background:rgba(19,38,64,.72)}
    .port-board-column:last-child{border-right:0}
    .port-board-section.is-fullscreen .port-board-column{min-height:0;overflow:hidden}
    .port-board-column-tag{position:absolute;top:2px;left:2px;z-index:3;gap:1px;padding:0 4px;background:transparent;color:#f5d24b;font-size:3.48rem;cursor:move}
    /* Fullscreen: column tag bar'ı kompakt ama okunabilir port adı */
    .port-board-section.is-fullscreen .port-board-column-tag{font-size:1.55rem;line-height:1}
    .port-drag-handle{justify-content:center;width:18px;height:18px;padding:0;border:0;background:transparent;color:#d9e6f2;cursor:move}
    .port-drag-handle mat-icon{font-size:16px;width:16px;height:16px}
    .port-board-column-body{position:relative;display:grid;padding:0;min-height:240px;background:rgba(189,210,232,.08)}
    .port-board-section.is-fullscreen .port-board-column-body{min-height:0;height:100%}
    /* Fullscreen'de time-grid kaldırılır — 200px column'a 12+ saat sığdırmak
       item'ları okunmaz hale getiriyordu. Bunun yerine flex-column ile
       item'lar natural height'la üst üste dizilir. Time bilgisi item içinde
       (port-board-time div'inde) saklı. Saat görsel-precision kaybedilir;
       ama "hangi port'ta hangi içerik var?" sorusu net cevaplanır. */
    .port-board-section.is-fullscreen .port-board-column-body{
      display:flex;flex-direction:column;gap:3px;
      padding:1.85rem 3px 4px;  /* üst padding column-tag'e yer verir */
      overflow:hidden;
    }
    .port-board-item{z-index:1;margin:1px 0 0;padding:1px 1px 2px;border:1px solid rgba(255,255,255,.08);background:#c7d8ec;color:#17304d;display:flex;flex-direction:column;gap:1px;overflow:hidden}
    .port-board-item:first-of-type{margin-top:4rem}
    .port-board-section.is-fullscreen .port-board-item{
      margin:0 !important;
      grid-row:auto !important;  /* parent grid-template-rows etkisiz olsun */
      flex:0 0 auto;
      min-height:0;
    }
    .port-board-item.overlap{background:#ffd9d9;border-color:#ef5350}
    .port-board-item strong{display:flex;flex-direction:column;font-size:2.16rem;line-height:.92;overflow:hidden}
    .title-line{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .port-board-time{font-weight:bold;font-size:2.16rem;line-height:.92;color:#e65100}
    .port-board-warning{font-weight:bold;font-size:2.16rem;line-height:.92;color:#b71c1c}
    .port-board-note{font-size:2.16rem;font-weight:bold;line-height:.92;color:#4a148c;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    /* Fullscreen: item içerik fontları — okunaklı + sığabilir denge.
       Title öncelik 1, time öncelik 2, note öncelik 3. line-height:1 ile
       satır başına yer korunur (3-4 satır item'lar 200px column-body'ye sığar). */
    .port-board-section.is-fullscreen .port-board-item{padding:2px 3px 3px;gap:2px}
    .port-board-section.is-fullscreen .port-board-item strong{font-size:1.05rem;line-height:1.05;font-weight:700}
    .port-board-section.is-fullscreen .port-board-time{font-size:.95rem;line-height:1.05}
    .port-board-section.is-fullscreen .port-board-warning{font-size:.9rem;line-height:1.05}
    .port-board-section.is-fullscreen .port-board-note{font-size:.85rem;line-height:1.05;margin-top:1px}
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

  /**
   * 2026-05-14: "vs" yerine alt alta takım render ve trailing "(yedek)" ayrı
   * satır. Sıra:
   *   1) trim + trailing "(yedek)" tail'i ayır (case-insensitive)
   *   2) " vs " ile (space-vs-space, case-insensitive) ayır
   *   3) " - " (space-hyphen-space) fallback — "A-B" bölünmez
   *   4) Tek parça kaldıysa base title'ı tek satır olarak ver
   *   5) Tail varsa "(yedek)" en sona ayrı satır olarak ekle
   */
  titleLines(title: string): string[] {
    const trimmed = (title ?? '').trim();
    if (!trimmed) return [''];

    let base = trimmed;
    const yedekMatch = base.match(/^(.*?)\s*\(yedek\)\s*$/i);
    const yedekTail = yedekMatch ? '(yedek)' : null;
    if (yedekMatch) base = yedekMatch[1].trim();

    let parts = base.split(/\s+vs\s+/i).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) {
      parts = base.split(' - ').map((p) => p.trim()).filter(Boolean);
    }

    const lines: string[] = parts.length >= 2
      ? parts.slice(0, 3)
      : [base];

    if (yedekTail) lines.push(yedekTail);
    return lines;
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
    // Fullscreen: minmax kaldır, 1fr ile viewport'a sığdır (yatay scroll yok).
    if (this.isFullscreen) {
      return `repeat(${columns.length}, minmax(0, 1fr))`;
    }
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
