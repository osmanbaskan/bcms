import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { YayinPlanlamaService } from './yayin-planlama.service';
import { ApiService } from './api.service';

describe('YayinPlanlamaService', () => {
  let service: YayinPlanlamaService;
  let apiSpy: jasmine.SpyObj<ApiService>;

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj('ApiService', [
      'get', 'post', 'patch', 'delete', 'invalidateCache',
    ]);
    TestBed.configureTestingModule({
      providers: [
        YayinPlanlamaService,
        { provide: ApiService, useValue: apiSpy },
      ],
    });
    service = TestBed.inject(YayinPlanlamaService);
  });

  it('getList: GET /schedules/broadcast server-side filter (frontend post-filter YOK)', (done) => {
    apiSpy.get.and.returnValue(of({
      data:  [{ id: 1, eventKey: 'opta:M-1' } as any],
      total: 1, page: 1, pageSize: 50,
    }));
    service.getList({ from: '2026-06-01', status: 'CONFIRMED' }).subscribe((res) => {
      expect(res.data.map((s) => s.id)).toEqual([1]);
      done();
    });
    // from canonical YYYY-MM-DD (scheduleDate filter; legacy start/end_time DEĞİL)
    expect(apiSpy.get).toHaveBeenCalledWith('/schedules/broadcast', {
      from:   '2026-06-01',
      status: 'CONFIRMED',
    });
  });

  it('getList: eventKey query param iletilir', () => {
    apiSpy.get.and.returnValue(of({ data: [], total: 0, page: 1, pageSize: 50 }));
    service.getList({ eventKey: 'opta:M-9' }).subscribe();
    expect(apiSpy.get).toHaveBeenCalledWith('/schedules/broadcast', { eventKey: 'opta:M-9' });
  });

  it('getById: GET /schedules/:id', () => {
    apiSpy.get.and.returnValue(of({ id: 7 } as any));
    service.getById(7).subscribe();
    expect(apiSpy.get).toHaveBeenCalledWith('/schedules/7');
  });

  it('create: POST /schedules/broadcast + cross-domain invalidate /live-plan', (done) => {
    apiSpy.post.and.returnValue(of({ id: 1 } as any));
    const dto = {
      eventKey: 'opta:M-1',
      selectedLivePlanEntryId: 9,
      scheduleDate: '2026-06-01',
      scheduleTime: '20:00',
    };
    service.create(dto).subscribe(() => {
      expect(apiSpy.invalidateCache).toHaveBeenCalledWith('/live-plan');
      done();
    });
    expect(apiSpy.post).toHaveBeenCalledWith('/schedules/broadcast', dto);
  });

  it('update: PATCH /schedules/broadcast/:id + If-Match version + invalidate /live-plan', (done) => {
    apiSpy.patch.and.returnValue(of({ id: 1 } as any));
    const dto = { scheduleTime: '21:00' };
    service.update(1, dto, 5).subscribe(() => {
      expect(apiSpy.invalidateCache).toHaveBeenCalledWith('/live-plan');
      done();
    });
    expect(apiSpy.patch).toHaveBeenCalledWith('/schedules/broadcast/1', dto, 5);
  });

  it('delete: DELETE /schedules/broadcast/:id + invalidate /live-plan (channel slot NULL)', (done) => {
    apiSpy.delete.and.returnValue(of(undefined));
    service.delete(1).subscribe(() => {
      expect(apiSpy.invalidateCache).toHaveBeenCalledWith('/live-plan');
      done();
    });
    expect(apiSpy.delete).toHaveBeenCalledWith('/schedules/broadcast/1');
  });

  it('getLookupOptions: type whitelist üzerinden GET /schedules/lookups/:type', () => {
    apiSpy.get.and.returnValue(of({ items: [{ id: 1, label: 'A' }] } as any));
    service.getLookupOptions('commercial_options').subscribe();
    expect(apiSpy.get).toHaveBeenCalledWith(
      '/schedules/lookups/commercial_options',
      { activeOnly: 'true' },
    );
  });

  it('getLookupOptions: activeOnly=false param atlanır', () => {
    apiSpy.get.and.returnValue(of({ items: [] } as any));
    service.getLookupOptions('logo_options', false).subscribe();
    expect(apiSpy.get).toHaveBeenCalledWith('/schedules/lookups/logo_options', {});
  });

  // ── 2026-05-13: Yayın Planlama → /live-plan endpoint reroute ──────────
  it('getLivePlanList: GET /live-plan + lig/hafta query params', (done) => {
    apiSpy.get.and.returnValue(of({ items: [], total: 0, page: 1, pageSize: 50 }));
    service.getLivePlanList({
      from: '2026-06-01T00:00:00.000Z',
      to:   '2026-06-30T23:59:59.999Z',
      status: 'PLANNED',
      leagueId: 10,
      weekNumber: 3,
      page: 2,
      pageSize: 25,
    }).subscribe(() => done());
    expect(apiSpy.get).toHaveBeenCalledWith('/live-plan', {
      from:       '2026-06-01T00:00:00.000Z',
      to:         '2026-06-30T23:59:59.999Z',
      status:     'PLANNED',
      leagueId:   10,
      weekNumber: 3,
      page:       2,
      pageSize:   25,
    });
  });

  it('getLivePlanList: filter boş → params boş object', () => {
    apiSpy.get.and.returnValue(of({ items: [], total: 0, page: 1, pageSize: 50 }));
    service.getLivePlanList().subscribe();
    expect(apiSpy.get).toHaveBeenCalledWith('/live-plan', {});
  });

  it('getLeagueFilterOptions: GET /live-plan/filters/leagues', () => {
    apiSpy.get.and.returnValue(of([{ id: 1, name: 'Süper Lig' }]));
    service.getLeagueFilterOptions().subscribe();
    expect(apiSpy.get).toHaveBeenCalledWith('/live-plan/filters/leagues');
  });

  it('getWeekFilterOptions: leagueId opsiyonel — param ile çağrılır', () => {
    apiSpy.get.and.returnValue(of([1, 2, 3]));
    service.getWeekFilterOptions(10).subscribe();
    expect(apiSpy.get).toHaveBeenCalledWith('/live-plan/filters/weeks', { leagueId: 10 });
  });

  it('getWeekFilterOptions: leagueId yoksa params boş', () => {
    apiSpy.get.and.returnValue(of([1, 2, 3]));
    service.getWeekFilterOptions().subscribe();
    expect(apiSpy.get).toHaveBeenCalledWith('/live-plan/filters/weeks', {});
  });

  // ── 2026-05-13: Inline kanal düzenleme — LivePlanEntry PATCH path ──────
  it('updateLivePlanChannels: PATCH /live-plan/:id + version + invalidate /live-plan', (done) => {
    apiSpy.patch.and.returnValue(of({ id: 42, version: 7, channel1Id: 1 } as any));
    const dto = { channel1Id: 1, channel2Id: null, channel3Id: 3 };
    service.updateLivePlanChannels(42, dto, 6).subscribe((res) => {
      expect((res as { version: number }).version).toBe(7);
      expect(apiSpy.invalidateCache).toHaveBeenCalledWith('/live-plan');
      done();
    });
    expect(apiSpy.patch).toHaveBeenCalledWith('/live-plan/42', dto, 6);
  });

  it('updateLivePlanEventStart: PATCH /live-plan/:id + {eventStartTime} + version + invalidate', (done) => {
    apiSpy.patch.and.returnValue(of({ id: 99, version: 4, eventStartTime: '2026-07-01T19:00:00.000Z' } as any));
    service.updateLivePlanEventStart(99, '2026-07-01T19:00:00.000Z', 3).subscribe((res) => {
      expect((res as { version: number }).version).toBe(4);
      expect(apiSpy.invalidateCache).toHaveBeenCalledWith('/live-plan');
      done();
    });
    expect(apiSpy.patch).toHaveBeenCalledWith(
      '/live-plan/99',
      { eventStartTime: '2026-07-01T19:00:00.000Z' },
      3,
    );
  });
});
