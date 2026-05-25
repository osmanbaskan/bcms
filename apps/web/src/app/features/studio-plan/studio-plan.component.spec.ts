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

  // ── 2026-05-14: 15 dk slot grid (önce 30 dk); 2026-05-25: default 07:00-03:00 ─
  it('timeSlots 80 adet üretir', () => {
    expect((component as any).timeSlots().length).toBe(80);
  });

  it('ilk slot 07:00, son slot 02:45', () => {
    const ts = (component as any).timeSlots() as string[];
    expect(ts[0]).toBe('07:00');
    expect(ts[ts.length - 1]).toBe('02:45');
  });

  // ── 2026-05-25: hafta bazlı time range ana grid'i belirler ────────────────
  // Acceptance: edit'te 00:00-00:00 kaydedilen hafta açılınca grid 24 saat görünmeli.
  it('weekTimeRange 00:00-00:00 ayarlandığında timeSlots 96 slot reactive üretir', () => {
    const c = component as any;
    c.weekTimeRangeStart.set('00:00');
    c.weekTimeRangeEnd.set('00:00');
    const ts = c.timeSlots() as string[];
    expect(ts.length).toBe(96);
    expect(ts[0]).toBe('00:00');
    expect(ts[95]).toBe('23:45');
  });

  it('weekTimeRange 07:00-03:00 ayarlandığında timeSlots 80 slot üretir', () => {
    const c = component as any;
    c.weekTimeRangeStart.set('07:00');
    c.weekTimeRangeEnd.set('03:00');
    const ts = c.timeSlots() as string[];
    expect(ts.length).toBe(80);
    expect(ts[0]).toBe('07:00');
    expect(ts[79]).toBe('02:45');
  });

  // ── 2026-05-25 (rev3): Excel program metni helper — slotSpan-aware.
  //   - slotSpan=1: wrapText:false, tek satır, shrinkToFit ile font küçülür.
  //   - slotSpan>=2: max 2-3 satır, kelimeler ASLA bölünmez, explicit LF.
  describe('formatProgramForCell — slotSpan-aware', () => {
    const fmt = (n: string, span = 1) => (component as any).formatProgramForCell(n, span);

    it('tek kelime: tek satır, shrinkToFit:true, wrapText:false (her span)', () => {
      [1, 2, 4, 8].forEach((span) => {
        const r = fmt('PREMIER', span);
        expect(r.text).toBe('PREMIER');
        expect(r.lineCount).toBe(1);
        expect(r.wrapText).toBeFalse();
        expect(r.shrinkToFit).toBeTrue();
      });
    });

    it('slotSpan=1 + çok kelime: tek satır, hiçbir kelime bölünmez', () => {
      const r = fmt('PREMIER EXPRESS BK', 1);
      expect(r.text).toBe('PREMIER EXPRESS BK');
      expect(r.text.includes('\n')).toBeFalse();
      expect(r.lineCount).toBe(1);
      expect(r.wrapText).toBeFalse();
      expect(r.shrinkToFit).toBeTrue();
    });

    it('slotSpan=2 + çok kelime: max 2 satır, kelime sınırından', () => {
      const r = fmt('PREMIER EXPRESS BK', 2);
      expect(r.lineCount).toBe(2);
      expect(r.text.split('\n').every((l: string) => !l.includes('\n'))).toBeTrue();
      // Hiçbir satır tek başına bir kelimeyi bölmemeli — her satır kelime|kelime
      r.text.split('\n').forEach((line: string) => {
        line.split(' ').forEach((w: string) => expect(w.length).toBeGreaterThan(0));
      });
    });

    it('slotSpan=4 + 3 kelime: 2 veya 3 satıra balance', () => {
      const r = fmt('TELEMETRİ CANLI YAYIN', 4);
      expect(r.lineCount).toBeGreaterThanOrEqual(2);
      expect(r.lineCount).toBeLessThanOrEqual(3);
      // Hiçbir satırda kelime karakter-ortasından bölünmez — kelimeler bütün
      r.text.split('\n').forEach((line: string) => {
        line.split(' ').forEach((w: string) => {
          expect(['TELEMETRİ', 'CANLI', 'YAYIN']).toContain(w);
        });
      });
    });

    it('balanceLines en uzun satırı minimize eder', () => {
      const r = fmt('PREMIER EXPRESS BK', 4);
      const lines = r.text.split('\n');
      const longest = Math.max(...lines.map((l: string) => l.length));
      // Tek satır olsa 18 char, optimal split en azından bunu azaltmalı
      expect(longest).toBeLessThan(18);
    });

    it('whitespace normalize: trim + multiple-space collapse', () => {
      const r = fmt('  ANA   HABER  ', 1);
      expect(r.text).toBe('ANA HABER');
    });

    it('font fallback: ≤10 char → 8', () => {
      expect(fmt('ANA', 1).fontSize).toBe(8);
      expect(fmt('PREMIER', 1).fontSize).toBe(8);
      expect(fmt('TELEMETRİ', 1).fontSize).toBe(8); // 9 char
    });

    it('font fallback: 11-12 char → 7', () => {
      expect(fmt('İÇİNDEKİLER', 1).fontSize).toBe(7); // 11 char
      expect(fmt('ANA HABER CY', 1).fontSize).toBe(7); // 12 char
    });

    it('font fallback: 13-16 char → 6', () => {
      expect(fmt('GÜN ORTASI CY', 1).fontSize).toBe(6); // 13 char
      expect(fmt('KADRO İÇİNDE BK', 1).fontSize).toBe(6); // 15 char
    });

    it('font fallback: 17-20 char → 5', () => {
      expect(fmt('PREMIER EXPRESS BK', 1).fontSize).toBe(5); // 18 char
    });

    it('font fallback: >20 char → 4 (slotSpan=1)', () => {
      expect(fmt('TELEMETRİ CANLI YAYIN', 1).fontSize).toBe(4); // 21 char
    });

    it('slotSpan büyüdükçe font fallback rahatlar (line break devreye girer)', () => {
      // slotSpan=4 → 2-3 satıra dağıt → en uzun satır kısa → font yüksek
      const r1 = fmt('PREMIER EXPRESS BK', 1);
      const r4 = fmt('PREMIER EXPRESS BK', 4);
      expect(r4.fontSize).toBeGreaterThanOrEqual(r1.fontSize);
      expect(r4.lineCount).toBeGreaterThan(r1.lineCount);
    });
  });

  it('weekTimeRange değişirse template binding [timeSlots] yeniden render eder', () => {
    const c = component as any;
    c.weekTimeRangeStart.set('00:00');
    c.weekTimeRangeEnd.set('00:00');
    fixture.detectChanges();
    const tableEl = fixture.nativeElement.querySelector('app-studio-plan-table');
    expect(tableEl).toBeTruthy();
    // Stub component @Input timeSlots — child binding signal değerini almış mı?
    const childInstance: { timeSlots: string[] } =
      (fixture.debugElement.query((d) => d.componentInstance instanceof StubStudioPlanTableComponent) as any)
        ?.componentInstance ?? null;
    expect(childInstance).withContext('stub table component should render').toBeTruthy();
    expect(childInstance.timeSlots.length).toBe(96);
    expect(childInstance.timeSlots[0]).toBe('00:00');
    expect(childInstance.timeSlots[95]).toBe('23:45');
  });

  it('listEntries tek atama → 15 dk durationMinutes + endTime 15 dk sonrası', () => {
    const comp = component as any;
    const day = comp.days()[0];
    const studio = comp.studios[0];
    const t = comp.timeSlots()[0]; // 07:00
    comp.cells.set({ [comp.cellKey(day.id, studio, t)]: { program: 'P', color: '#000' } });
    const e = comp.listEntries()[0];
    expect(e.startTime).toBe('07:00');
    expect(e.endTime).toBe('07:15');
    expect(e.durationMinutes).toBe(15);
    expect(e.slotCount).toBe(1);
  });

  it('listEntries 4 ardışık aynı program → 1 saat (60 dk)', () => {
    const comp = component as any;
    const day = comp.days()[0];
    const studio = comp.studios[0];
    const assignment = { program: 'X', color: '#111' };
    const cells: Record<string, unknown> = {};
    for (let i = 0; i < 4; i++) cells[comp.cellKey(day.id, studio, comp.timeSlots()[i])] = assignment;
    comp.cells.set(cells);
    const e = comp.listEntries()[0];
    expect(e.slotCount).toBe(4);
    expect(e.durationMinutes).toBe(60);
    expect(e.startTime).toBe('07:00');
    expect(e.endTime).toBe('08:00');
  });

  // ── 2026-05-14: listEntries canonical kaynak — tablo ↔ liste tutarlılığı ──
  //
  // Bug: listEntries computed `if (day.id < today) continue;` filtresi ile
  //      geçmiş günleri dışlıyordu; tabloda gözüken Pazartesi/Salı kayıtları
  //      listede görünmüyordu. Fix: filtre kaldırıldı; tablo + liste aynı
  //      `cells()` signal'inden besleniyor.

  it('listEntries: cells üzerinde herhangi bir günde atama varsa listede görünür', () => {
    const comp = component as unknown as {
      days: () => { id: string }[];
      studios: string[];
      timeSlots: () => string[];
      cells: (next: Record<string, unknown>) => void;
      listEntries: () => unknown[];
      cellKey: (d: string, s: string, t: string) => string;
    };
    const day = comp.days()[0];
    const studio = comp.studios[0];
    const time = comp.timeSlots()[0];
    const key = comp.cellKey(day.id, studio, time);
    (component as any).cells.set({ [key]: { program: 'Test Program', color: '#FF0000' } });
    const entries = comp.listEntries();
    expect(entries.length).toBe(1);
    expect((entries[0] as { program: string }).program).toBe('Test Program');
  });

  it('listEntries: boş cells → liste boş', () => {
    (component as any).cells.set({});
    expect((component as any).listEntries().length).toBe(0);
  });

  it('listEntries: ardışık aynı program/color slot\'lar tek satır olarak merge edilir', () => {
    const comp = component as unknown as {
      days: () => { id: string }[];
      studios: string[];
      timeSlots: () => string[];
      cellKey: (d: string, s: string, t: string) => string;
    };
    const day = comp.days()[0];
    const studio = comp.studios[0];
    const t1 = comp.timeSlots()[0];
    const t2 = comp.timeSlots()[1];
    const k1 = comp.cellKey(day.id, studio, t1);
    const k2 = comp.cellKey(day.id, studio, t2);
    (component as any).cells.set({
      [k1]: { program: 'P', color: '#000' },
      [k2]: { program: 'P', color: '#000' },
    });
    const entries = (component as any).listEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].slotCount).toBe(2);
  });

  it('listEntries: cell silinince ilgili kayıt listeden kalkar', () => {
    const comp = component as unknown as {
      days: () => { id: string }[];
      studios: string[];
      timeSlots: () => string[];
      cellKey: (d: string, s: string, t: string) => string;
    };
    const day = comp.days()[0];
    const studio = comp.studios[0];
    const time = comp.timeSlots()[0];
    const key = comp.cellKey(day.id, studio, time);
    (component as any).cells.set({ [key]: { program: 'X', color: '#111' } });
    expect((component as any).listEntries().length).toBe(1);
    (component as any).cells.set({});
    expect((component as any).listEntries().length).toBe(0);
  });

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
      // 2026-05-14: auto-pan artık planShellScrollRef'i tercih ediyor;
      // planShellRef fallback. Test mock her ikisini de set eder.
      (component as any).planShellRef       = { nativeElement: el };
      (component as any).planShellScrollRef = { nativeElement: el };
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
