import { CommonModule } from '@angular/common';
import { Component, Input, computed, signal } from '@angular/core';
import type { StudioPlanListEntry } from '../studio-plan.types';

@Component({
  selector: 'app-studio-plan-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './studio-plan-list.component.html',
  styleUrl: './studio-plan-list.component.scss',
})
export class StudioPlanListComponent {
  private readonly entriesSignal = signal<StudioPlanListEntry[]>([]);

  // 2026-05-28 (rev 5): 2 tone + gün geçiş şeridi.
  //
  // Her gün kendi içinde A/B/A/B zebra; gün değişince rowIdx sıfırlanır →
  // bir sonraki gün de yine A'dan başlar. Günler arası ayrımı kalın yatay
  // şerit (`day-boundary`) gösterir; sadece bir önceki gün varsa eklenir
  // (ilk günün ilk satırına şerit yok).
  //
  // Geçmiş gün filtresi parent `listEntries()` computed'unda; burada gelen
  // entries zaten bugün veya gelecek günler.
  private readonly classByEntry = computed(() => {
    const out = new Map<string, { tone: 'a' | 'b'; dayBoundary: boolean }>();
    let lastDay: string | null = null;
    let rowIdx = 0;
    for (const e of this.entriesSignal()) {
      let dayBoundary = false;
      if (e.dayDate !== lastDay) {
        rowIdx = 0;
        dayBoundary = lastDay !== null; // ilk günün ilk satırına şerit verme
        lastDay = e.dayDate;
      } else {
        rowIdx += 1;
      }
      const tone: 'a' | 'b' = rowIdx % 2 === 0 ? 'a' : 'b';
      out.set(e.id, { tone, dayBoundary });
    }
    return out;
  });

  @Input({ required: true })
  set entries(value: StudioPlanListEntry[]) {
    this.entriesSignal.set(value);
  }
  get entries(): StudioPlanListEntry[] {
    return this.entriesSignal();
  }

  toneClass(entry: StudioPlanListEntry): string[] {
    const c = this.classByEntry().get(entry.id);
    const cls: string[] = [c?.tone === 'b' ? 'list-tone-b' : 'list-tone-a'];
    if (c?.dayBoundary) cls.push('day-boundary');
    return cls;
  }
}
