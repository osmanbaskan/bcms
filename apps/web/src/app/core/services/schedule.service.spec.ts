import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ScheduleService } from './schedule.service';
import { ApiService } from './api.service';

describe('ScheduleService', () => {
  let service: ScheduleService;
  let apiSpy: jasmine.SpyObj<ApiService>;

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj('ApiService', ['get', 'post', 'patch', 'delete']);
    TestBed.configureTestingModule({
      providers: [
        ScheduleService,
        { provide: ApiService, useValue: apiSpy },
      ],
    });
    service = TestBed.inject(ScheduleService);
  });

  it('getSchedules filtre ile ApiService.get çağırmalı', () => {
    apiSpy.get.and.returnValue(of({ items: [], total: 0 }));
    service.getSchedules({ page: 2, pageSize: 20 }).subscribe();
    expect(apiSpy.get).toHaveBeenCalledWith('/schedules', { page: 2, pageSize: 20 });
  });

  it('getSchedule id ile çağırmalı', () => {
    apiSpy.get.and.returnValue(of({ id: 1 } as any));
    service.getSchedule(1).subscribe();
    expect(apiSpy.get).toHaveBeenCalledWith('/schedules/1');
  });

  it('createSchedule dto ile post etmeli', () => {
    apiSpy.post.and.returnValue(of({ id: 1 } as any));
    const dto = { channelId: 1, title: 'T', startTime: '', endTime: '' } as any;
    service.createSchedule(dto).subscribe();
    expect(apiSpy.post).toHaveBeenCalledWith('/schedules', dto);
  });

  it('updateSchedule version header ile patch etmeli', () => {
    apiSpy.patch.and.returnValue(of({ id: 1 } as any));
    service.updateSchedule(1, { title: 'T' } as any, 5).subscribe();
    expect(apiSpy.patch).toHaveBeenCalledWith('/schedules/1', { title: 'T' }, 5);
  });
});
