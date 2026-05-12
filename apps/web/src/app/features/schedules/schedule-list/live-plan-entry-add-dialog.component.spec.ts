import { TestBed, ComponentFixture } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { MatDialogRef } from '@angular/material/dialog';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';

import { LivePlanEntryAddDialogComponent } from './live-plan-entry-add-dialog.component';
import {
  ScheduleService,
  type BroadcastType,
  type FixtureCompetition,
  type OptaFixtureRow,
} from '../../../core/services/schedule.service';

const BT_FIXTURE: BroadcastType[] = [
  { id: 1, code: 'MATCH', description: 'Maç' },
];

const COMP_FIXTURE: FixtureCompetition[] = [
  { id: '115', name: 'Süper Lig',           season: '2025-2026' },
  { id: 'tbl', name: 'Türkiye Basketbol Ligi', season: '2025-2026' },
];

const FIXTURES_FIXTURE: OptaFixtureRow[] = [
  {
    matchId: 'opta-9',
    competitionId: '115', competitionName: 'Süper Lig', season: '2025-2026',
    homeTeamName: 'Galatasaray', awayTeamName: 'Fenerbahçe',
    matchDate: '2026-06-01T17:00:00.000Z',
    weekNumber: 28,
  },
];

describe('LivePlanEntryAddDialogComponent', () => {
  let fixture: ComponentFixture<LivePlanEntryAddDialogComponent>;
  let component: LivePlanEntryAddDialogComponent;
  let svc: jasmine.SpyObj<ScheduleService>;
  let dialogRef: jasmine.SpyObj<MatDialogRef<LivePlanEntryAddDialogComponent>>;

  beforeEach(() => {
    svc = jasmine.createSpyObj('ScheduleService', [
      'getBroadcastTypes',
      'getFixtureCompetitions',
      'getOptaFixtures',
      'createLivePlanFromOpta',
      'createLivePlanEntry',
    ]);
    svc.getBroadcastTypes.and.returnValue(of(BT_FIXTURE));
    svc.getFixtureCompetitions.and.returnValue(of(COMP_FIXTURE));
    svc.getOptaFixtures.and.returnValue(of(FIXTURES_FIXTURE));
    (svc.createLivePlanFromOpta as unknown as jasmine.Spy).and.returnValue(of({ id: 42 }));
    (svc.createLivePlanEntry as unknown as jasmine.Spy).and.returnValue(of({ id: 43 }));

    dialogRef = jasmine.createSpyObj('MatDialogRef', ['close']);

    TestBed.configureTestingModule({
      imports:   [LivePlanEntryAddDialogComponent, NoopAnimationsModule],
      providers: [
        { provide: ScheduleService, useValue: svc },
        { provide: MatDialogRef,    useValue: dialogRef },
      ],
    });

    fixture   = TestBed.createComponent(LivePlanEntryAddDialogComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => fixture.destroy());

  it('ngOnInit: /broadcast-types ve /opta/fixture-competitions paralel fetch eder', () => {
    fixture.detectChanges();
    expect(svc.getBroadcastTypes).toHaveBeenCalledTimes(1);
    expect(svc.getFixtureCompetitions).toHaveBeenCalledTimes(1);
    expect(component.broadcastTypes()).toEqual(BT_FIXTURE);
    expect(component.competitions()).toEqual(COMP_FIXTURE);
  });

  it('competition seçilince /opta/fixtures çağrılır (competitionId+season+from)', () => {
    fixture.detectChanges();
    component.onCompetitionChange('115:2025-2026');
    expect(svc.getOptaFixtures).toHaveBeenCalledTimes(1);
    const [compId, season, fromIso] = svc.getOptaFixtures.calls.mostRecent().args;
    expect(compId).toBe('115');
    expect(season).toBe('2025-2026');
    expect(typeof fromIso).toBe('string');
    expect(component.fixtures()).toEqual(FIXTURES_FIXTURE);
  });

  it('canSave: fixture seçilmediyse false, seçilince true (sekme 0)', () => {
    fixture.detectChanges();
    component.activeTab = 0;
    expect(component.canSave()).toBeFalse();
    component.onCompetitionChange('115:2025-2026');
    expect(component.canSave()).toBeFalse();
    component.selectFixture('opta-9');
    expect(component.canSave()).toBeTrue();
  });

  it('save (sekme 0): POST /live-plan/from-opta { optaMatchId } ve dialog kapanır', () => {
    fixture.detectChanges();
    component.activeTab = 0;
    component.onCompetitionChange('115:2025-2026');
    component.selectFixture('opta-9');
    component.save();
    expect(svc.createLivePlanFromOpta).toHaveBeenCalledWith({ optaMatchId: 'opta-9' });
    expect(dialogRef.close).toHaveBeenCalled();
  });

  it('save 409: dialog açık kalır, error mesajı set edilir', () => {
    svc.createLivePlanFromOpta.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 409, error: { message: 'duplicate' } })),
    );
    fixture.detectChanges();
    component.activeTab = 0;
    component.onCompetitionChange('115:2025-2026');
    component.selectFixture('opta-9');
    component.save();
    expect(dialogRef.close).not.toHaveBeenCalled();
    expect(component.errorMsg()).toContain('aktif kayıt var');
  });

  it('save 404: OPTA match bulunamadı mesajı', () => {
    svc.createLivePlanFromOpta.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 404, error: { message: 'not found' } })),
    );
    fixture.detectChanges();
    component.activeTab = 0;
    component.onCompetitionChange('115:2025-2026');
    component.selectFixture('opta-9');
    component.save();
    expect(component.errorMsg()).toBeTruthy();
  });

  it('save (sekme 1 manuel): POST /live-plan ile ISO datetime ve trim edilmiş alanlar', () => {
    fixture.detectChanges();
    component.activeTab = 1;
    component.manual.title     = '  Galatasaray vs FB  ';
    component.manual.startDate = '2026-06-01';
    component.manual.startTime = '20:00';
    component.manual.endDate   = '2026-06-01';
    component.manual.endTime   = '22:00';
    component.manual.team1Name = ' GS ';
    component.manual.team2Name = ' FB ';

    expect(component.canSave()).toBeTrue();
    component.save();

    const body = svc.createLivePlanEntry.calls.mostRecent().args[0] as unknown as Record<string, unknown>;
    expect(body['title']).toBe('Galatasaray vs FB');
    expect(typeof body['eventStartTime']).toBe('string');
    expect(typeof body['eventEndTime']).toBe('string');
    expect(body['team1Name']).toBe('GS');
    expect(body['team2Name']).toBe('FB');
    expect(dialogRef.close).toHaveBeenCalled();
  });

  it('competition null seçilince fixture listesi temizlenir', () => {
    fixture.detectChanges();
    component.onCompetitionChange('115:2025-2026');
    expect(component.fixtures().length).toBeGreaterThan(0);

    component.onCompetitionChange(null);
    expect(component.fixtures()).toEqual([]);
    expect(component.selectedFixtureId()).toBeNull();
  });
});
