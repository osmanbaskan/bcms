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
    service.getList({ from: '2026-06-01T00:00:00Z', status: 'CONFIRMED' }).subscribe((res) => {
      expect(res.data.map((s) => s.id)).toEqual([1]);
      done();
    });
    expect(apiSpy.get).toHaveBeenCalledWith('/schedules/broadcast', {
      from:   '2026-06-01T00:00:00Z',
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
});
