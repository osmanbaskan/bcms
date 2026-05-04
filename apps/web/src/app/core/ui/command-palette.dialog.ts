import {
  Component, ElementRef, ViewChild, AfterViewInit,
  computed, signal, inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';

export interface CommandItem {
  label: string;
  icon: string;
  route: string;
  group?: string;
}

/**
 * CommandPalette — Cmd+K / Ctrl+K hızlı arama.
 * beINport search bar pattern + arrow key navigation + enter ile git.
 */
@Component({
  selector: 'bp-command-palette',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule],
  template: `
    <div class="palette">
      <div class="search">
        <mat-icon class="material-icons-outlined search-icon">search</mat-icon>
        <input #searchInput
               type="text"
               placeholder="Yayın, kanal, takım, port ara… (sayfa adı yaz)"
               [(ngModel)]="query"
               (ngModelChange)="onQueryChange()"
               (keydown.enter)="navigate(results()[selectedIndex()])"
               (keydown.arrowDown)="moveSelection(1, $event)"
               (keydown.arrowUp)="moveSelection(-1, $event)"
               (keydown.escape)="dialogRef.close()" />
        <span class="kbd">ESC</span>
      </div>
      <div class="results">
        @for (item of results(); track item.route; let i = $index) {
          <button class="item"
                  [class.active]="i === selectedIndex()"
                  (click)="navigate(item)"
                  (mouseenter)="selectedIndex.set(i)">
            <mat-icon class="material-icons-outlined item-icon">{{ item.icon }}</mat-icon>
            <span class="item-label">
              @if (item.group) { <span class="item-group">{{ item.group }} ›</span> }
              {{ item.label }}
            </span>
            <span class="item-route">{{ item.route }}</span>
          </button>
        } @empty {
          <div class="empty">Sonuç bulunamadı</div>
        }
      </div>
    </div>
  `,
  styles: [`
    .palette { width: 560px; max-width: 92vw; background: var(--bp-bg-2); }
    .search {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 18px;
      border-bottom: 1px solid var(--bp-line-2);
    }
    .search-icon {
      color: var(--bp-fg-3);
      font-size: 20px !important;
      width: 20px !important;
      height: 20px !important;
    }
    .search input {
      flex: 1;
      border: 0;
      outline: 0;
      background: transparent;
      font-family: var(--bp-font-sans);
      font-size: var(--bp-text-md);
      color: var(--bp-fg-1);
    }
    .search input::placeholder { color: var(--bp-fg-3); }
    .kbd {
      font-size: var(--bp-text-xs);
      font-family: var(--bp-font-mono);
      color: var(--bp-fg-3);
      background: var(--bp-bg-0);
      padding: 2px 6px;
      border-radius: 3px;
      border: 1px solid var(--bp-line-2);
    }
    .results { max-height: 420px; overflow-y: auto; padding: 8px; }
    .item {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 10px 12px;
      background: transparent;
      border: 0;
      cursor: pointer;
      border-radius: var(--bp-r-md);
      text-align: left;
      transition: background var(--bp-dur-fast) var(--bp-ease);
      font-family: var(--bp-font-sans);
    }
    .item.active { background: rgba(124, 58, 237, 0.18); }
    .item-icon {
      color: var(--bp-fg-3);
      font-size: 18px !important;
      width: 18px !important;
      height: 18px !important;
    }
    .item.active .item-icon { color: var(--bp-purple-300); }
    .item-label {
      color: var(--bp-fg-1);
      font-weight: var(--bp-fw-medium);
      flex: 1;
      font-size: var(--bp-text-md);
    }
    .item-group {
      color: var(--bp-fg-3);
      font-weight: var(--bp-fw-regular);
      margin-right: 4px;
    }
    .item-route {
      color: var(--bp-fg-4);
      font-size: var(--bp-text-xs);
      font-family: var(--bp-font-mono);
    }
    .empty {
      padding: 32px;
      text-align: center;
      color: var(--bp-fg-3);
    }
  `],
})
export class CommandPaletteComponent implements AfterViewInit {
  @ViewChild('searchInput') searchInput!: ElementRef<HTMLInputElement>;

  protected dialogRef = inject<MatDialogRef<CommandPaletteComponent, string | undefined>>(MatDialogRef);
  private data = inject<{ items: CommandItem[] }>(MAT_DIALOG_DATA);

  query = signal('');
  selectedIndex = signal(0);

  results = computed(() => {
    const q = this.query().toLowerCase().trim();
    if (!q) return this.data.items.slice(0, 12);
    return this.data.items
      .filter((item) => `${item.label} ${item.group ?? ''} ${item.route}`.toLowerCase().includes(q))
      .slice(0, 12);
  });

  ngAfterViewInit() {
    queueMicrotask(() => this.searchInput?.nativeElement.focus());
  }

  onQueryChange() {
    this.selectedIndex.set(0);
  }

  navigate(item?: CommandItem) {
    if (item) this.dialogRef.close(item.route);
  }

  moveSelection(delta: number, event: Event) {
    event.preventDefault();
    const max = this.results().length;
    if (max <= 0) return;
    const next = (this.selectedIndex() + delta + max) % max;
    this.selectedIndex.set(next);
  }
}
