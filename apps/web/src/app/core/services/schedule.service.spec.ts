import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ScheduleService, mapLivePlanEntryToSchedule } from './schedule.service';
import { ApiService } from './api.service';

// SCHED-B5a (Y5-1, ikinci revize 2026-05-08): ScheduleService Canlı Yayın Plan
// UI datasource wrapper'ı — `/api/v1/live-plan` endpoint'ine bağlanır;
// LivePlanEntry → Schedule mapper. Mutation metodları YOK (read-only).

describe('ScheduleService — live-plan datasource wrapper', () => {
  let service: ScheduleService;
  let apiSpy: jasmine.SpyObj<ApiService>;

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj('ApiService', ['get']);
    TestBed.configureTestingModule({
      providers: [
        ScheduleService,
        { provide: ApiService, useValue: apiSpy },
      ],
    });
    service = TestBed.inject(ScheduleService);
  });

  it('getSchedules `/live-plan` endpoint çağırır (legacy `/schedules` ÇAĞIRMAZ)', () => {
    apiSpy.get.and.returnValue(of({ items: [], total: 0, page: 1, pageSize: 50 }));
    service.getSchedules({ from: '2026-05-09T00:00:00Z', to: '2026-05-09T23:59:59Z', page: 2, pageSize: 20 }).subscribe();
    expect(apiSpy.get).toHaveBeenCalledWith('/live-plan', {
      from:     '2026-05-09T00:00:00Z',
      to:       '2026-05-09T23:59:59Z',
      page:     2,
      pageSize: 20,
    });
  });

  it('getSchedules boş filter ile sadece `/live-plan` çağırır', () => {
    apiSpy.get.and.returnValue(of({ items: [], total: 0, page: 1, pageSize: 50 }));
    service.getSchedules().subscribe();
    expect(apiSpy.get).toHaveBeenCalledWith('/live-plan', {});
  });

  it('getSchedules cevabı PaginatedResponse<Schedule> shape\'ine map eder (data + totalPages)', (done) => {
    apiSpy.get.and.returnValue(of({
      items: [{
        id:             10,
        title:          'GS - FB',
        eventStartTime: '2026-05-09T19:00:00Z',
        eventEndTime:   '2026-05-09T21:00:00Z',
        matchId:        null,
        optaMatchId:    null,
        status:         'PLANNED',
        operationNotes: null,
        createdBy:      'user1',
        version:        1,
        createdAt:      '2026-05-09T10:00:00Z',
        updatedAt:      '2026-05-09T10:00:00Z',
        deletedAt:      null,
        eventKey:       'manual:abc',
        sourceType:     'MANUAL',
        channel1Id:     1,
        channel2Id:     null,
        channel3Id:     null,
        team1Name:      'GS',
        team2Name:      'FB',
      }],
      total: 1, page: 1, pageSize: 50,
    }));

    service.getSchedules({ from: '2026-05-09T00:00:00Z', to: '2026-05-09T23:59:59Z' }).subscribe((res) => {
      expect(res.data.length).toBe(1);
      expect(res.total).toBe(1);
      expect(res.page).toBe(1);
      expect(res.pageSize).toBe(50);
      expect(res.totalPages).toBe(1);
      expect(res.data[0].id).toBe(10);
      expect(res.data[0].title).toBe('GS - FB');
      expect(res.data[0].startTime).toBe('2026-05-09T19:00:00Z');
      expect(res.data[0].endTime).toBe('2026-05-09T21:00:00Z');
      expect(res.data[0].channelId).toBe(1);
      expect(res.data[0].channel1Id).toBe(1);
      expect(res.data[0].eventKey).toBe('manual:abc');
      expect(res.data[0].team1Name).toBe('GS');
      expect(res.data[0].team2Name).toBe('FB');
      done();
    });
  });

  it('totalPages pageSize=0 ise 0 döner (defansif)', (done) => {
    apiSpy.get.and.returnValue(of({ items: [], total: 0, page: 1, pageSize: 0 }));
    service.getSchedules().subscribe((res) => {
      expect(res.totalPages).toBe(0);
      done();
    });
  });
});

describe('mapLivePlanEntryToSchedule', () => {
  function entry(overrides: Partial<Parameters<typeof mapLivePlanEntryToSchedule>[0]> = {}): Parameters<typeof mapLivePlanEntryToSchedule>[0] {
    return {
      id:             1,
      title:          'X',
      eventStartTime: '2026-05-09T19:00:00Z',
      eventEndTime:   '2026-05-09T21:00:00Z',
      matchId:        null,
      optaMatchId:    null,
      status:         'PLANNED',
      operationNotes: null,
      createdBy:      null,
      version:        1,
      createdAt:      '2026-05-09T10:00:00Z',
      updatedAt:      '2026-05-09T10:00:00Z',
      deletedAt:      null,
      eventKey:       null,
      sourceType:     'MANUAL',
      channel1Id:     null,
      channel2Id:     null,
      channel3Id:     null,
      team1Name:      null,
      team2Name:      null,
      ...overrides,
    };
  }

  it('PLANNED ve READY → CONFIRMED', () => {
    expect(mapLivePlanEntryToSchedule(entry({ status: 'PLANNED' })).status).toBe('CONFIRMED');
    expect(mapLivePlanEntryToSchedule(entry({ status: 'READY' })).status).toBe('CONFIRMED');
  });

  it('IN_PROGRESS → ON_AIR', () => {
    expect(mapLivePlanEntryToSchedule(entry({ status: 'IN_PROGRESS' })).status).toBe('ON_AIR');
  });

  it('COMPLETED ve CANCELLED birebir', () => {
    expect(mapLivePlanEntryToSchedule(entry({ status: 'COMPLETED' })).status).toBe('COMPLETED');
    expect(mapLivePlanEntryToSchedule(entry({ status: 'CANCELLED' })).status).toBe('CANCELLED');
  });

  it('eventStartTime/EndTime → startTime/endTime', () => {
    const s = mapLivePlanEntryToSchedule(entry({
      eventStartTime: '2026-05-09T19:00:00Z',
      eventEndTime:   '2026-05-09T21:00:00Z',
    }));
    expect(s.startTime).toBe('2026-05-09T19:00:00Z');
    expect(s.endTime).toBe('2026-05-09T21:00:00Z');
  });

  it('channel1Id → channelId scalar fallback (channel objesi null)', () => {
    const s = mapLivePlanEntryToSchedule(entry({ channel1Id: 7 }));
    expect(s.channelId).toBe(7);
    expect(s.channel1Id).toBe(7);
    expect(s.channel).toBeNull();
  });

  it('createdBy null → boş string', () => {
    expect(mapLivePlanEntryToSchedule(entry({ createdBy: null })).createdBy).toBe('');
  });

  it('metadata her zaman boş obje', () => {
    expect(mapLivePlanEntryToSchedule(entry()).metadata).toEqual({});
  });

  it('eventKey + team alanları korunur', () => {
    const s = mapLivePlanEntryToSchedule(entry({
      eventKey:  'opta:123',
      team1Name: 'GS',
      team2Name: 'FB',
    }));
    expect(s.eventKey).toBe('opta:123');
    expect(s.team1Name).toBe('GS');
    expect(s.team2Name).toBe('FB');
  });
});
