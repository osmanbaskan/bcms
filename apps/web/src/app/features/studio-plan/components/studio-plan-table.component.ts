import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { StudioPlanAssignment, StudioPlanDay } from '../studio-plan.types';

@Component({
  selector: 'app-studio-plan-table',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './studio-plan-table.component.html',
  styleUrl: './studio-plan-table.component.scss',
})
export class StudioPlanTableComponent {
  @Input({ required: true }) days: StudioPlanDay[] = [];
  @Input({ required: true }) studios: string[] = [];
  @Input({ required: true }) timeSlots: string[] = [];
  @Input({ required: true }) cells: Record<string, StudioPlanAssignment> = {};

  @Output() assignProgram = new EventEmitter<{ day: string; studio: string; time: string }>();

  programAt(day: string, studio: string, time: string): string {
    return this.cells[this.cellKey(day, studio, time)]?.program ?? '';
  }

  colorAt(day: string, studio: string, time: string): string | null {
    return this.cells[this.cellKey(day, studio, time)]?.color ?? null;
  }

  isContinuation(day: string, studio: string, time: string): boolean {
    const program = this.programAt(day, studio, time);
    const color = this.colorAt(day, studio, time);
    const previous = this.previousTime(time);
    return !!program && !!previous && this.programAt(day, studio, previous) === program && this.colorAt(day, studio, previous) === color;
  }

  continuesProgram(day: string, studio: string, time: string): boolean {
    const program = this.programAt(day, studio, time);
    const color = this.colorAt(day, studio, time);
    const next = this.nextTime(time);
    return !!program && !!next && this.programAt(day, studio, next) === program && this.colorAt(day, studio, next) === color;
  }

  runLength(day: string, studio: string, time: string): number {
    const program = this.programAt(day, studio, time);
    if (!program || this.isContinuation(day, studio, time)) return 1;

    let length = 1;
    let cursor = this.nextTime(time);
    const color = this.colorAt(day, studio, time);
    while (cursor && this.programAt(day, studio, cursor) === program && this.colorAt(day, studio, cursor) === color) {
      length++;
      cursor = this.nextTime(cursor);
    }
    return length;
  }

  programFontSize(day: string, studio: string, time: string): number {
    const program = this.programAt(day, studio, time);
    if (!program || this.isContinuation(day, studio, time)) return 11;

    const runLength = this.runLength(day, studio, time);
    const available = Math.max(1, runLength);
    const rawSize = Math.floor((available * 80) / Math.max(program.length, 12));
    return Math.max(7, Math.min(11, rawSize));
  }

  private cellKey(day: string, studio: string, time: string): string {
    return `${day}::${studio}::${time}`;
  }

  private previousTime(time: string): string | undefined {
    const index = this.timeSlots.indexOf(time);
    return index > 0 ? this.timeSlots[index - 1] : undefined;
  }

  private nextTime(time: string): string | undefined {
    const index = this.timeSlots.indexOf(time);
    return index >= 0 && index < this.timeSlots.length - 1 ? this.timeSlots[index + 1] : undefined;
  }
}
