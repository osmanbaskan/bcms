import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { of } from 'rxjs';
import { IngestListComponent } from './ingest-list.component';
import { ApiService } from '../../../core/services/api.service';

describe('IngestListComponent', () => {
  let component: IngestListComponent;
  let fixture: import('@angular/core/testing').ComponentFixture<IngestListComponent>;
  let apiSpy: jasmine.SpyObj<ApiService>;

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj('ApiService', ['get', 'post', 'patch']);
    apiSpy.get.and.returnValue(of({ data: [], total: 0 }));

    TestBed.configureTestingModule({
      imports: [IngestListComponent],
      providers: [
        { provide: ApiService, useValue: apiSpy },
      ],
    }).overrideComponent(IngestListComponent, {
      set: { template: '' },
    });

    fixture = TestBed.createComponent(IngestListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('oluşturulmalı', () => {
    expect(component).toBeTruthy();
  });

  it('loadLivePlanCandidates: /ingest/live-plan-candidates ve /schedules/ingest-candidates ikisini de çağırır', () => {
    apiSpy.get.calls.reset();
    (apiSpy.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path === '/ingest/live-plan-candidates') return of([]);
      if (path === '/schedules/ingest-candidates') return of({ data: [], total: 0 });
      if (path === '/ingest/plan')                 return of([]);
      return of({ data: [], total: 0 });
    });
    component.loadLivePlanCandidates();
    const calledPaths = apiSpy.get.calls.allArgs().map((args) => args[0]);
    expect(calledPaths).toContain('/ingest/live-plan-candidates');
    expect(calledPaths).toContain('/schedules/ingest-candidates');
    // date query param yeni endpoint için Türkiye günü.
    const liveCall = apiSpy.get.calls.allArgs().find((args) => args[0] === '/ingest/live-plan-candidates')!;
    expect((liveCall[1] as { date?: string })?.date).toBe(component.livePlanDate);
  });

  it('planningRows: live-plan-entry candidate kanal boşsa "—" gösterir, eventKey null olsa bile satır görünür', () => {
    component.channels.set([{ id: 1, name: 'beINSports1', type: 'HD', active: true } as any]);
    component.liveEntryCandidates.set([
      {
        livePlanEntryId: 5, eventKey: null, title: 'NoKey', status: 'PLANNED',
        eventStartTime: '2026-06-01T17:00:00.000Z', eventEndTime: '2026-06-01T19:00:00.000Z',
        channel1Id: null, channel2Id: null, channel3Id: null, leagueName: null,
        planItem: null, ingestJob: null, scheduleId: null, hasBroadcastSchedule: false,
      } as any,
      {
        livePlanEntryId: 7, eventKey: 'manual:abc', title: 'WithCh1', status: 'PLANNED',
        eventStartTime: '2026-06-01T18:00:00.000Z', eventEndTime: '2026-06-01T20:00:00.000Z',
        channel1Id: 1, channel2Id: null, channel3Id: null, leagueName: 'Lig',
        planItem: null, ingestJob: null, scheduleId: null, hasBroadcastSchedule: false,
      } as any,
    ]);
    component.livePlanCandidates.set([]);
    const rows = component.planningRows();
    expect(rows.length).toBe(2);
    const noKey = rows.find((r) => r.sourceKey === 'liveplan:5')!;
    expect(noKey.location).toBe('—');
    const withCh = rows.find((r) => r.sourceKey === 'liveplan:7')!;
    expect(withCh.location).toBe('beINSports1');
  });

  it('duplicate guard: aynı schedule.id hem live-entry candidate.scheduleId hem livePlanCandidates listesinde varsa schedule-kaynaklı filtreyle dışlanır', () => {
    component.channels.set([]);
    component.liveEntryCandidates.set([
      {
        livePlanEntryId: 9, eventKey: 'manual:xyz', title: 'Dup',
        status: 'PLANNED',
        eventStartTime: '2026-06-01T17:00:00.000Z', eventEndTime: '2026-06-01T19:00:00.000Z',
        channel1Id: null, channel2Id: null, channel3Id: null, leagueName: null,
        planItem: null, ingestJob: null,
        scheduleId: 172, hasBroadcastSchedule: true,
      } as any,
    ]);
    component.livePlanCandidates.set([
      { id: 172, title: 'Dup-Schedule', startTime: '2026-06-01T17:00:00.000Z',
        endTime: '2026-06-01T19:00:00.000Z' } as any,
    ]);
    const rows = component.planningRows();
    // Sadece live-entry tarafından gelen satır kalır; schedule kaynaklı duplicate dışlanır.
    expect(rows.filter((r) => r.source === 'live-plan').length).toBe(1);
    expect(rows[0].sourceKey).toBe('liveplan:9');
  });

  it('startBurstPoll timer tabanlı subscription oluşturmalı ve take(6) ile sonlanmalı', fakeAsync(() => {
    component.onWorkspaceTabChange(1);

    const sub = (component as any).portBoardPollSub;
    expect(sub).toBeTruthy();
    expect(sub.closed).toBeFalse();

    // 5. tur sonunda hâlâ açık (0, 10, 20, 30, 40 saniye = 5 emit)
    tick(40_000);
    expect(sub.closed).toBeFalse();

    // 6. tur sonunda take(6) complete eder
    tick(10_000);
    expect(sub.closed).toBeTrue();

    fixture.destroy();
  }));
});
