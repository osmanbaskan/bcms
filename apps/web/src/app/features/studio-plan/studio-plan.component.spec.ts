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

  // ── 2026-05-14: Fullscreen UX fix — toolbar + auto-pan testleri ──────────
  //
  // Bug #1: toolbar fullscreen target dışındaydı → fullscreen modda araçlar
  //         erişilemezdi. Fix: app-studio-plan-toolbar #studio-plan-export
  //         içine taşındı.
  // Bug #2: mouse-edge auto-pan yoktu → geniş tabloda scroll zordu. Fix:
  //         pointermove + RAF loop, sadece fullscreen + edit + table mode.

  it('toolbar fullscreen target (#studio-plan-export) içinde render edilir', () => {
    const root = fixture.nativeElement as HTMLElement;
    const exportEl = root.querySelector('#studio-plan-export');
    expect(exportEl).withContext('plan-shell exists').toBeTruthy();
    const toolbar = exportEl?.querySelector('app-studio-plan-toolbar');
    expect(toolbar).withContext('toolbar fullscreen target içinde').toBeTruthy();
  });

  describe('auto-pan (mouse-edge)', () => {
    function setPlanShellMock(rect: { left: number; right: number; top: number; bottom: number }) {
      const el = {
        getBoundingClientRect: () => ({
          ...rect,
          width:  rect.right  - rect.left,
          height: rect.bottom - rect.top,
        }),
        scrollLeft:  100,
        scrollTop:   100,
        scrollWidth:  5000,
        clientWidth:  1000,
        scrollHeight: 3000,
        clientHeight: 800,
      } as unknown as HTMLDivElement;
      (component as any).planShellRef = { nativeElement: el };
      return el;
    }

    function fireMove(clientX: number, clientY: number) {
      const ev = new PointerEvent('pointermove', { clientX, clientY });
      component.onPointerMoveForAutoPan(ev);
    }

    beforeEach(() => {
      // Default: fullscreen + table + canEdit, touch=false, reduced-motion=false
      component.fullscreenActive.set(true);
      component.viewMode.set('table');
      (component as any).isCoarsePointer = false;
      (component as any).prefersReducedMotion = false;
      setPlanShellMock({ left: 0, right: 1000, top: 0, bottom: 800 });
    });

    afterEach(() => {
      // RAF leak guard
      (component as any).stopAutoPanLoop();
    });

    it('fullscreen=false iken pointermove auto-pan tetiklenmez', () => {
      component.fullscreenActive.set(false);
      fireMove(995, 400); // sağ kenar
      const state = (component as any).autoPanState as { dx: number; dy: number };
      expect(state.dx).toBe(0);
      expect(state.dy).toBe(0);
    });

    it('fullscreen + table + sağ kenarda pointer → dx > 0', () => {
      fireMove(990, 400); // sağ kenardan 10px içeri → edge_px=80 içinde
      const state = (component as any).autoPanState as { dx: number; dy: number };
      expect(state.dx).toBeGreaterThan(0);
    });

    it('fullscreen + table + sol kenarda pointer → dx < 0', () => {
      fireMove(10, 400);
      const state = (component as any).autoPanState as { dx: number; dy: number };
      expect(state.dx).toBeLessThan(0);
    });

    it('pointer container ortasındaysa dx ve dy sıfır', () => {
      fireMove(500, 400);
      const state = (component as any).autoPanState as { dx: number; dy: number };
      expect(state.dx).toBe(0);
      expect(state.dy).toBe(0);
    });

    it('pointerleave sonrası state sıfırlanır', () => {
      fireMove(995, 400);
      expect((component as any).autoPanState.dx).toBeGreaterThan(0);
      component.onPointerLeaveForAutoPan();
      expect((component as any).autoPanState.dx).toBe(0);
      expect((component as any).autoPanState.dy).toBe(0);
    });

    it('fullscreen exit (onFullscreenChange) → RAF cancel + state sıfır', () => {
      fireMove(995, 400);
      (component as any).autoPanFrame = 9999; // simulate aktif loop
      // fullscreenchange tetiklendiğinde document.fullscreenElement null
      component.onFullscreenChange();
      expect((component as any).autoPanFrame).toBeNull();
      expect((component as any).autoPanState.dx).toBe(0);
    });

    it('list mode\'da pointermove auto-pan tetiklenmez', () => {
      component.viewMode.set('list');
      fireMove(995, 400);
      expect((component as any).autoPanState.dx).toBe(0);
    });

    it('touch/coarse pointer mock → auto-pan no-op', () => {
      (component as any).isCoarsePointer = true;
      fireMove(995, 400);
      expect((component as any).autoPanState.dx).toBe(0);
    });

    it('ngOnDestroy RAF loop\'u iptal eder', () => {
      const cancelSpy = spyOn(window, 'cancelAnimationFrame');
      (component as any).autoPanFrame = 1234;
      component.ngOnDestroy();
      expect(cancelSpy).toHaveBeenCalledWith(1234);
      expect((component as any).autoPanFrame).toBeNull();
    });
  });
});
