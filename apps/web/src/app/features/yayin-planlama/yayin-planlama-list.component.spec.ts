import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { of } from 'rxjs';
import type { LivePlanEntry, LivePlanListResponse } from '@bcms/shared';
import { YayinPlanlamaListComponent } from './yayin-planlama-list.component';
import { YayinPlanlamaService } from '../../core/services/yayin-planlama.service';

/**
 * 2026-05-13: Yayın Planlama list spec — `getLivePlanList()` data source.
 * EventKey input/param testleri kaldırıldı; Lig/Hafta filter testleri eklendi.
 */

function makeEntry(overrides: Partial<LivePlanEntry> = {}): LivePlanEntry {
  return {
    id:              1,
    title:           'Test Match',
    eventStartTime:  '2026-06-01T19:00:00.000Z',
    eventEndTime:    '2026-06-01T21:00:00.000Z',
    matchId:         null,
    optaMatchId:     null,
    status:          'PLANNED',
    operationNotes:  null,
    createdBy:       'u',
    version:         1,
    createdAt:       '2026-05-01T10:00:00.000Z',
    updatedAt:       '2026-05-01T10:00:00.000Z',
    deletedAt:       null,
    eventKey:        'manual:abc',
    sourceType:      'MANUAL',
    channel1Id:      null,
    channel2Id:      null,
    channel3Id:      null,
    team1Name:       'A',
    team2Name:       'B',
    leagueName:      null,
    leagueId:        null,
    weekNumber:      null,
    season:          null,
    ...overrides,
  };
}

function makeList(items: LivePlanEntry[] = [makeEntry()]): LivePlanListResponse {
  return { items, total: items.length, page: 1, pageSize: 25 };
}

describe('YayinPlanlamaListComponent (2026-05-13 — live-plan data source)', () => {
  let serviceSpy: jasmine.SpyObj<YayinPlanlamaService>;

  beforeEach(async () => {
    serviceSpy = jasmine.createSpyObj<YayinPlanlamaService>('YayinPlanlamaService', [
      'getLivePlanList', 'getLeagueFilterOptions', 'getWeekFilterOptions',
    ]);
    serviceSpy.getLivePlanList.and.returnValue(of(makeList()));
    serviceSpy.getLeagueFilterOptions.and.returnValue(of([
      { id: 10, name: 'Süper Lig' },
      { id: 20, name: 'TFF 1. Lig' },
    ]));
    serviceSpy.getWeekFilterOptions.and.returnValue(of([1, 2, 3]));

    await TestBed.configureTestingModule({
      imports: [YayinPlanlamaListComponent],
      providers: [
        provideRouter([]),
        provideAnimationsAsync(),
        { provide: YayinPlanlamaService, useValue: serviceSpy },
      ],
    }).compileComponents();
  });

  it('ngOnInit: getLivePlanList default page=1, pageSize=25 ile çağırır', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    expect(serviceSpy.getLivePlanList).toHaveBeenCalled();
    const args = serviceSpy.getLivePlanList.calls.mostRecent().args[0];
    expect(args!.page).toBe(1);
    expect(args!.pageSize).toBe(25);
  });

  it('ngOnInit: getLeagueFilterOptions çağrılır + leagues signal doldurulur', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    expect(serviceSpy.getLeagueFilterOptions).toHaveBeenCalled();
    const cmp = fixture.componentInstance as unknown as {
      leagues(): { id: number; name: string }[];
    };
    expect(cmp.leagues().length).toBe(2);
    expect(cmp.leagues()[0].name).toBe('Süper Lig');
  });

  it('EventKey input render edilmez (template kontrolü)', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).not.toContain('Event Key');
  });

  it('Lig dropdown render edilir + opsiyonlar', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('Lig');
  });

  it('Hafta dropdown render edilir', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('Hafta');
  });

  it('reload: leagueId set → getLivePlanList leagueId param ile çağrılır', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as {
      leagueId: number | null;
      onLeagueChange(): void;
    };
    cmp.leagueId = 10;
    cmp.onLeagueChange();
    const args = serviceSpy.getLivePlanList.calls.mostRecent().args[0];
    expect(args!.leagueId).toBe(10);
  });

  it('reload: weekNumber set → getLivePlanList weekNumber param ile çağrılır', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as {
      leagueId: number | null;
      weekNumber: number | null;
      reload(): void;
    };
    cmp.leagueId = 10;
    cmp.weekNumber = 2;
    cmp.reload();
    const args = serviceSpy.getLivePlanList.calls.mostRecent().args[0];
    expect(args!.weekNumber).toBe(2);
  });

  it('onLeagueChange: weekNumber resetlenir + getWeekFilterOptions yeniden yüklenir', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as {
      leagueId: number | null;
      weekNumber: number | null;
      onLeagueChange(): void;
    };
    cmp.leagueId = 10;
    cmp.weekNumber = 5; // önceden seçilmiş
    cmp.onLeagueChange();
    expect(cmp.weekNumber).toBeNull();
    expect(serviceSpy.getWeekFilterOptions).toHaveBeenCalledWith(10);
  });

  it('reload: leagueId/weekNumber null → param undefined gönderilir', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as {
      leagueId: number | null;
      weekNumber: number | null;
      reload(): void;
    };
    cmp.leagueId = null;
    cmp.weekNumber = null;
    cmp.reload();
    const args = serviceSpy.getLivePlanList.calls.mostRecent().args[0];
    expect(args!.leagueId).toBeUndefined();
    expect(args!.weekNumber).toBeUndefined();
  });

  it('manual entry (leagueName/weekNumber null) "—" gösterilir', () => {
    serviceSpy.getLivePlanList.and.returnValue(of(makeList([
      makeEntry({ leagueName: null, weekNumber: null }),
    ])));
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    // "Lig" + "—" hücreleri görünür
    expect(html).toContain('—');
  });
});
