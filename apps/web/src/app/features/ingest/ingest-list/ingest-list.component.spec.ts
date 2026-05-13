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

  // ── 2026-05-13: live-plan entry port save UI yansıma fix testleri ────────
  //
  // Kök neden (analiz raporu): `planningRows.liveEntryRows` mapping'i
  // `c.planItem` snapshot'ından okuduğundan, save sonrası `ingestPlanItems`
  // signal güncellense bile UI eski portu gösteriyordu. Port Görünümü ise yeni
  // `liveplan:<id>` sourceKey'i hiç tanımıyordu. Aşağıdaki 5 test fix'i
  // garantiler.

  it('planningRows liveEntryRows: ingestPlanItems signal liveplan:<id> port değerini c.planItem snapshot üstünde tercih eder', () => {
    component.channels.set([]);
    component.liveEntryCandidates.set([
      {
        livePlanEntryId: 42, eventKey: 'manual:x', title: 'Test', status: 'PLANNED',
        eventStartTime: '2026-06-01T17:00:00.000Z', eventEndTime: '2026-06-01T19:00:00.000Z',
        channel1Id: null, channel2Id: null, channel3Id: null, leagueName: null,
        planItem: {
          sourceKey: 'liveplan:42', recordingPort: 'STALE-PORT', backupRecordingPort: null,
          status: 'WAITING', plannedStartMinute: null, plannedEndMinute: null,
          note: null, jobId: null,
        },
        ingestJob: null, scheduleId: null, hasBroadcastSchedule: false,
      } as any,
    ]);
    component.livePlanCandidates.set([]);
    // Signal save'i simüle eder: snapshot eski 'STALE-PORT' ama signal yeni 'Metus1'.
    component.ingestPlanItems.set([
      {
        id: 1, sourceType: 'live-plan', sourceKey: 'liveplan:42', dayDate: component.livePlanDate,
        recordingPort: 'Metus1', backupRecordingPort: 'Metus2',
        plannedStartMinute: 1020, plannedEndMinute: 1140,
        status: 'WAITING', jobId: null, note: 'kaydedildi',
        createdAt: '', updatedAt: '',
      } as any,
    ]);
    const row = component.planningRows().find((r) => r.sourceKey === 'liveplan:42')!;
    expect(row).toBeTruthy();
    expect(row.recordingPort).toBe('Metus1');
    expect(row.backupRecordingPort).toBe('Metus2');
    expect(row.planNote).toBe('kaydedildi');
    expect(row.sortMinute).toBe(1020);
    expect(row.endMinute).toBe(1140);
  });

  it('planningRows liveEntryRows: signal eşli kayıt yoksa c.planItem snapshot fallback çalışır', () => {
    component.channels.set([]);
    component.liveEntryCandidates.set([
      {
        livePlanEntryId: 7, eventKey: null, title: 'Snapshot-only', status: 'PLANNED',
        eventStartTime: '2026-06-01T17:00:00.000Z', eventEndTime: '2026-06-01T19:00:00.000Z',
        channel1Id: null, channel2Id: null, channel3Id: null, leagueName: null,
        planItem: {
          sourceKey: 'liveplan:7', recordingPort: 'SNAP', backupRecordingPort: null,
          status: 'WAITING', plannedStartMinute: 900, plannedEndMinute: 960,
          note: 'snap-note', jobId: null,
        },
        ingestJob: null, scheduleId: null, hasBroadcastSchedule: false,
      } as any,
    ]);
    component.livePlanCandidates.set([]);
    component.ingestPlanItems.set([]); // signal'de hiç eşli yok
    const row = component.planningRows().find((r) => r.sourceKey === 'liveplan:7')!;
    expect(row.recordingPort).toBe('SNAP');
    expect(row.planNote).toBe('snap-note');
    expect(row.sortMinute).toBe(900);
  });

  it('portBoardAllRows: portBoardLiveEntryCandidates üzerinden liveplan:<id> satırı doğru port ve sourceKey ile üretilir', () => {
    component.channels.set([]);
    component.portBoardLivePlan.set([]);
    component.portBoardStudioPlan.set([]);
    component.portBoardLiveEntryCandidates.set([
      {
        livePlanEntryId: 11, eventKey: 'manual:y', title: 'PB-row', status: 'PLANNED',
        eventStartTime: '2026-06-01T18:00:00.000Z', eventEndTime: '2026-06-01T20:00:00.000Z',
        channel1Id: null, channel2Id: null, channel3Id: null, leagueName: null,
        planItem: null, ingestJob: null, scheduleId: null, hasBroadcastSchedule: false,
      } as any,
    ]);
    component.portBoardIngestItems.set([
      {
        id: 2, sourceType: 'live-plan', sourceKey: 'liveplan:11',
        dayDate: component.portBoardDate(),
        recordingPort: 'Metus3', backupRecordingPort: null,
        plannedStartMinute: 1080, plannedEndMinute: 1200,
        status: 'WAITING', jobId: null, note: null,
        createdAt: '', updatedAt: '',
      } as any,
    ]);
    const rows = component.portBoardAllRows();
    const row = rows.find((r) => r.sourceKey === 'liveplan:11')!;
    expect(row).toBeTruthy();
    expect(row.recordingPort).toBe('Metus3');
    expect(row.sortMinute).toBe(1080);
    expect(row.endMinute).toBe(1200);
  });

  it('loadPortBoardData: /ingest/live-plan-candidates?date=... çağrılır + portBoardLiveEntryCandidates set edilir', () => {
    apiSpy.get.calls.reset();
    (apiSpy.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path === '/ingest/live-plan-candidates') {
        return of([
          {
            livePlanEntryId: 99, eventKey: null, title: 'PB', status: 'PLANNED',
            eventStartTime: '2026-06-01T17:00:00.000Z', eventEndTime: '2026-06-01T19:00:00.000Z',
            channel1Id: null, channel2Id: null, channel3Id: null, leagueName: null,
            planItem: null, ingestJob: null, scheduleId: null, hasBroadcastSchedule: false,
          },
        ]);
      }
      if (path === '/schedules/ingest-candidates') return of({ data: [], total: 0 });
      if (path === '/ingest/plan')                 return of([]);
      if (path && path.startsWith('/studio-plans/')) return of({ slots: [] });
      return of({ data: [], total: 0 });
    });
    component.loadPortBoardData('2026-06-01');
    const calledPaths = apiSpy.get.calls.allArgs().map((args) => args[0]);
    expect(calledPaths).toContain('/ingest/live-plan-candidates');
    const liveCall = apiSpy.get.calls.allArgs().find((args) => args[0] === '/ingest/live-plan-candidates')!;
    expect((liveCall[1] as { date?: string })?.date).toBe('2026-06-01');
    expect(component.portBoardLiveEntryCandidates().length).toBe(1);
    expect(component.portBoardLiveEntryCandidates()[0].livePlanEntryId).toBe(99);
  });

  it('portBoardAllRows duplicate guard: liveplan entry scheduleId set ise eski live:<scheduleId> satırı dışlanır', () => {
    component.channels.set([]);
    component.portBoardStudioPlan.set([]);
    component.portBoardIngestItems.set([]);
    component.portBoardLiveEntryCandidates.set([
      {
        livePlanEntryId: 21, eventKey: 'manual:z', title: 'Dup-pb', status: 'PLANNED',
        eventStartTime: '2026-06-01T17:00:00.000Z', eventEndTime: '2026-06-01T19:00:00.000Z',
        channel1Id: null, channel2Id: null, channel3Id: null, leagueName: null,
        planItem: null, ingestJob: null,
        scheduleId: 305, hasBroadcastSchedule: true,
      } as any,
    ]);
    component.portBoardLivePlan.set([
      { id: 305, title: 'Same-Schedule', startTime: '2026-06-01T17:00:00.000Z',
        endTime: '2026-06-01T19:00:00.000Z', channel: null } as any,
      { id: 999, title: 'Other-Schedule', startTime: '2026-06-01T20:00:00.000Z',
        endTime: '2026-06-01T22:00:00.000Z', channel: null } as any,
    ]);
    const rows = component.portBoardAllRows();
    // 305 dışlanmalı, 21 ve 999 kalmalı (toplam 2).
    const livePlanRows = rows.filter((r) => r.source === 'live-plan');
    expect(livePlanRows.length).toBe(2);
    expect(livePlanRows.some((r) => r.sourceKey === 'liveplan:21')).toBeTrue();
    expect(livePlanRows.some((r) => r.sourceKey === 'live:999')).toBeTrue();
    expect(livePlanRows.some((r) => r.sourceKey === 'live:305')).toBeFalse();
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
