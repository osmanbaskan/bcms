import { TestBed, ComponentFixture } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';

import { ManualLeaguesComponent } from './manual-leagues.component';
import {
  ScheduleService,
  type ManualLeagueAdminRow,
} from '../../../core/services/schedule.service';

const ROWS_FIXTURE: ManualLeagueAdminRow[] = [
  { id: 60, code: 'custom-tbl', name: 'Türkiye Basketbol Ligi', country: 'Türkiye',
    sportGroup: 'basketball', visible: true, manualSelectable: true, teamCount: 16 },
  { id: 38, code: 'opta-8', name: 'English Premier League', country: '',
    sportGroup: 'football', visible: true, manualSelectable: false, teamCount: 20 },
  { id: 99, code: 'custom-empty', name: 'Yeni Lig', country: '',
    sportGroup: 'football', visible: false, manualSelectable: false, teamCount: 0 },
];

describe('ManualLeaguesComponent', () => {
  let fixture:   ComponentFixture<ManualLeaguesComponent>;
  let component: ManualLeaguesComponent;
  let svc:       jasmine.SpyObj<ScheduleService>;

  beforeEach(() => {
    svc = jasmine.createSpyObj('ScheduleService', [
      'getManualLeagueAdminRows',
      'updateManualLeagueSelectable',
    ]);
    svc.getManualLeagueAdminRows.and.returnValue(of(ROWS_FIXTURE));
    svc.updateManualLeagueSelectable.and.callFake((id: number, mSel: boolean) =>
      of({ ...ROWS_FIXTURE.find((r) => r.id === id)!, manualSelectable: mSel }),
    );

    TestBed.configureTestingModule({
      imports:   [ManualLeaguesComponent, NoopAnimationsModule],
      providers: [{ provide: ScheduleService, useValue: svc }],
    });

    fixture   = TestBed.createComponent(ManualLeaguesComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => fixture.destroy());

  it('ngOnInit: getManualLeagueAdminRows çağrılır + 3 satır render', () => {
    fixture.detectChanges();
    expect(svc.getManualLeagueAdminRows).toHaveBeenCalledTimes(1);
    const proto = component as unknown as { rows: () => unknown[] };
    expect(proto.rows().length).toBe(3);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('Türkiye Basketbol Ligi');
    expect(host.textContent).toContain('English Premier League');
  });

  it('TBL satırı default açık (manualSelectable=true)', () => {
    fixture.detectChanges();
    const proto = component as unknown as { rows: () => Array<{ id: number; manualSelectable: boolean; draftManualSelectable: boolean }> };
    const tbl = proto.rows().find((r) => r.id === 60)!;
    expect(tbl.manualSelectable).toBeTrue();
    expect(tbl.draftManualSelectable).toBeTrue();
  });

  it('teamCount=0 satır info ikonu gösterir (warn-icon)', () => {
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const warnIcons = host.querySelectorAll('.warn-icon');
    expect(warnIcons.length).toBe(1); // sadece "Yeni Lig" (teamCount=0)
  });

  it('Toggle değişimi dirty state üretir + isDirty doğru', () => {
    fixture.detectChanges();
    const proto = component as unknown as {
      rows: () => Array<{ id: number; manualSelectable: boolean; draftManualSelectable: boolean }>;
      isDirty: (r: unknown) => boolean;
    };
    const epl = proto.rows().find((r) => r.id === 38)!;
    expect(proto.isDirty(epl)).toBeFalse();
    epl.draftManualSelectable = true;
    expect(proto.isDirty(epl)).toBeTrue();
  });

  it('save() updateManualLeagueSelectable çağırır + satır yenilenir + snack', () => {
    fixture.detectChanges();
    const proto = component as unknown as {
      rows: () => Array<{ id: number; manualSelectable: boolean; draftManualSelectable: boolean; saving: boolean }>;
      save: (r: unknown) => void;
    };
    const epl = proto.rows().find((r) => r.id === 38)!;
    epl.draftManualSelectable = true;
    proto.save(epl);

    expect(svc.updateManualLeagueSelectable).toHaveBeenCalledWith(38, true);
    const refreshed = proto.rows().find((r) => r.id === 38)!;
    expect(refreshed.manualSelectable).toBeTrue();
    expect(refreshed.draftManualSelectable).toBeTrue();
  });

  it('save() error → saving false, snack mesajı', () => {
    svc.updateManualLeagueSelectable.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 500, error: { message: 'sunucu hatası' } })),
    );
    fixture.detectChanges();
    const proto = component as unknown as {
      rows: () => Array<{ id: number; manualSelectable: boolean; draftManualSelectable: boolean; saving: boolean }>;
      save: (r: unknown) => void;
    };
    const epl = proto.rows().find((r) => r.id === 38)!;
    epl.draftManualSelectable = true;
    proto.save(epl);
    expect(epl.saving).toBeFalse();
  });

  it('isDirty: aynı değer set edilince false (idempotent toggle)', () => {
    fixture.detectChanges();
    const proto = component as unknown as {
      rows: () => Array<{ id: number; manualSelectable: boolean; draftManualSelectable: boolean }>;
      isDirty: (r: unknown) => boolean;
    };
    const tbl = proto.rows().find((r) => r.id === 60)!;
    expect(proto.isDirty(tbl)).toBeFalse();
    tbl.draftManualSelectable = false;
    expect(proto.isDirty(tbl)).toBeTrue();
    tbl.draftManualSelectable = true;
    expect(proto.isDirty(tbl)).toBeFalse();
  });

  it('reload() error → state-error mesajı', () => {
    svc.getManualLeagueAdminRows.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 500, error: { message: 'kapalı' } })),
    );
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('kapalı');
  });
});
