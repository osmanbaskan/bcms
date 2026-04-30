import { Component, Input, Output, EventEmitter } from '@angular/core';
import { TestBed, fakeAsync, tick, flush } from '@angular/core/testing';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { KeycloakService } from 'keycloak-angular';
import { of, Subject, delay } from 'rxjs';

import { StudioPlanComponent } from './studio-plan.component';
import { StudioPlanService } from '../../core/services/studio-plan.service';
import type { StudioPlan } from '@bcms/shared';

@Component({ selector: 'app-studio-plan-list', template: '', standalone: true })
class StubStudioPlanListComponent {
  @Input() entries: unknown[] = [];
}

@Component({ selector: 'app-studio-plan-table', template: '', standalone: true })
class StubStudioPlanTableComponent {
  @Input() days: unknown[] = [];
  @Input() studios: string[] = [];
  @Input() timeSlots: string[] = [];
  @Input() cells: Record<string, unknown> = {};
  @Output() assignProgram = new EventEmitter<unknown>();
}

@Component({ selector: 'app-studio-plan-toolbar', template: '', standalone: true })
class StubStudioPlanToolbarComponent {
  @Input() weekStart = '';
  @Input() weekOptions: unknown[] = [];
  @Input() viewMode = '';
  @Input() programs: string[] = [];
  @Input() colors: unknown[] = [];
  @Input() selectedProgram = '';
  @Input() selectedColor = '';
  @Input() readonly = false;
  @Input() eraserMode = false;
  @Input() loading = false;
  @Input() saving = false;
  @Input() saveError = '';
  @Input() lastSavedAt = '';
  @Output() weekStartChange = new EventEmitter<string>();
  @Output() viewModeChange = new EventEmitter<string>();
  @Output() selectedProgramChange = new EventEmitter<string>();
  @Output() selectedColorChange = new EventEmitter<string>();
  @Output() clearSelection = new EventEmitter<void>();
  @Output() moveCurrentWeekToNextWeek = new EventEmitter<void>();
  @Output() eraserModeChange = new EventEmitter<boolean>();
}

describe('StudioPlanComponent', () => {
  let component: StudioPlanComponent;
  let fixture: import('@angular/core/testing').ComponentFixture<StudioPlanComponent>;
  let studioPlanService: jasmine.SpyObj<StudioPlanService>;
  let keycloakService: jasmine.SpyObj<KeycloakService>;

  const mockPlan: StudioPlan = {
    id: 1,
    weekStart: '2024-01-01',
    slots: [],
    version: 1,
    createdBy: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    studioPlanService = jasmine.createSpyObj('StudioPlanService', [
      'getPlan',
      'savePlan',
      'getCatalog',
    ]);

    keycloakService = jasmine.createSpyObj('KeycloakService', [
      'getKeycloakInstance',
    ]);

    keycloakService.getKeycloakInstance.and.returnValue({
      tokenParsed: { groups: ['Admin'] },
    } as any);

    studioPlanService.getCatalog.and.returnValue(
      of({ programs: [], colors: [] }),
    );
    studioPlanService.getPlan.and.returnValue(of(mockPlan));
    studioPlanService.savePlan.and.returnValue(of(mockPlan));

    TestBed.configureTestingModule({
      imports: [StudioPlanComponent],
      providers: [
        { provide: StudioPlanService, useValue: studioPlanService },
        { provide: KeycloakService, useValue: keycloakService },
      ],
    }).overrideComponent(StudioPlanComponent, {
      set: {
        imports: [
          CommonModule,
          MatButtonModule,
          MatIconModule,
          StubStudioPlanListComponent,
          StubStudioPlanTableComponent,
          StubStudioPlanToolbarComponent,
        ],
      },
    });

    fixture = TestBed.createComponent(StudioPlanComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('oluşturulmalı', () => {
    expect(component).toBeTruthy();
  });

  it('hızlı ardışık atamalarda debounce sonrası tek savePlan çağrılmalı', fakeAsync(() => {
    component.assignProgram('2024-01-01', 'Stüdyo 1', '10:00');
    component.assignProgram('2024-01-01', 'Stüdyo 1', '10:30');
    component.assignProgram('2024-01-01', 'Stüdyo 1', '11:00');

    expect(studioPlanService.savePlan).not.toHaveBeenCalled();

    tick(400);
    expect(studioPlanService.savePlan).toHaveBeenCalledTimes(1);

    tick(100);
  }));

  it('debounce sonrası saving signal true olmalı ve tamamlandığında false olmalı', fakeAsync(() => {
    studioPlanService.savePlan.and.returnValue(of(mockPlan).pipe(delay(50)));

    component.assignProgram('2024-01-01', 'Stüdyo 1', '10:00');
    expect(component.saving()).toBeFalse();

    tick(400);
    expect(component.saving()).toBeTrue();

    tick(50);
    expect(component.saving()).toBeFalse();

    tick(100);
  }));

  it('ardışık atamalarda sadece son debounce sonrası kayıt gönderilmeli', fakeAsync(() => {
    component.assignProgram('2024-01-01', 'Stüdyo 1', '10:00');
    tick(200);
    component.assignProgram('2024-01-01', 'Stüdyo 1', '10:30');
    tick(200);
    component.assignProgram('2024-01-01', 'Stüdyo 1', '11:00');
    expect(studioPlanService.savePlan).not.toHaveBeenCalled();

    tick(400);
    expect(studioPlanService.savePlan).toHaveBeenCalledTimes(1);

    tick(100);
  }));

  it('clearSelection sonrası debounce ile savePlan çağrılmalı', fakeAsync(() => {
    component.clearSelection();
    expect(studioPlanService.savePlan).not.toHaveBeenCalled();

    tick(400);
    expect(studioPlanService.savePlan).toHaveBeenCalledTimes(1);

    tick(100);
  }));

  it('savePlan hata verirse saveError signal set edilmeli', fakeAsync(() => {
    const sub = new Subject<StudioPlan>();
    studioPlanService.savePlan.and.returnValue(sub.asObservable());

    component.assignProgram('2024-01-01', 'Stüdyo 1', '10:00');
    tick(400);
    expect(component.saving()).toBeTrue();

    sub.error(new Error('fail'));
    tick(1);

    expect(component.saveError()).toBe('Plan kaydedilemedi');
    expect(component.saving()).toBeFalse();

    tick(100);
  }));
});
