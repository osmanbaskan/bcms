import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import type { StudioPlanListEntry } from '../studio-plan.types';

@Component({
  selector: 'app-studio-plan-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './studio-plan-list.component.html',
  styleUrl: './studio-plan-list.component.scss',
})
export class StudioPlanListComponent {
  @Input({ required: true }) entries: StudioPlanListEntry[] = [];
}
