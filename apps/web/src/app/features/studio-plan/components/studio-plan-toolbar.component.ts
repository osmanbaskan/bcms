import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import type { StudioPlanColor, StudioPlanViewMode, StudioPlanWeekOption } from '../studio-plan.types';

@Component({
  selector: 'app-studio-plan-toolbar',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatIconModule,
    MatSelectModule,
  ],
  templateUrl: './studio-plan-toolbar.component.html',
  styleUrl: './studio-plan-toolbar.component.scss',
})
export class StudioPlanToolbarComponent {
  @Input({ required: true }) weekStart = '';
  @Input({ required: true }) weekOptions: StudioPlanWeekOption[] = [];
  @Input({ required: true }) viewMode: StudioPlanViewMode = 'table';
  @Input({ required: true }) programs: string[] = [];
  @Input({ required: true }) colors: StudioPlanColor[] = [];
  @Input({ required: true }) selectedProgram = '';
  @Input({ required: true }) selectedColor = '';
  @Input() eraserMode = false;
  @Input() loading = false;
  @Input() saving = false;
  @Input() saveError = '';
  @Input() lastSavedAt = '';

  @Output() weekStartChange = new EventEmitter<string>();
  @Output() viewModeChange = new EventEmitter<StudioPlanViewMode>();
  @Output() selectedProgramChange = new EventEmitter<string>();
  @Output() selectedColorChange = new EventEmitter<string>();
  @Output() clearSelection = new EventEmitter<void>();
  @Output() moveCurrentWeekToNextWeek = new EventEmitter<void>();
  @Output() eraserModeChange = new EventEmitter<boolean>();

  colorLabel(value: string): string {
    return this.colors.find((color) => color.value === value)?.label ?? 'Renk';
  }
}
