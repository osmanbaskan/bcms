import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { OptaAdminService } from './opta-admin.service';
import { ApiService } from './api.service';

describe('OptaAdminService', () => {
  let service: OptaAdminService;
  let apiSpy: jasmine.SpyObj<ApiService>;

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj('ApiService', ['get', 'patch', 'invalidateCache']);
    TestBed.configureTestingModule({
      providers: [
        OptaAdminService,
        { provide: ApiService, useValue: apiSpy },
      ],
    });
    service = TestBed.inject(OptaAdminService);
  });

  it('getCompetitionAdminList: GET /opta/competitions/admin', () => {
    apiSpy.get.and.returnValue(of([
      { id: 1, code: 'opta-115', name: 'Süper Lig', country: 'TR', visible: true, sortOrder: 1 },
    ]));
    service.getCompetitionAdminList().subscribe();
    expect(apiSpy.get).toHaveBeenCalledWith('/opta/competitions/admin');
  });

  it('updateCompetitionAdmin: PATCH /opta/competitions/admin/:id + invalidate /opta', (done) => {
    apiSpy.patch.and.returnValue(of({
      id: 5, code: 'opta-test', name: 'X', country: 'Y', visible: false, sortOrder: 9,
    }));
    service.updateCompetitionAdmin(5, { visible: false, sortOrder: 9 }).subscribe((res) => {
      expect(res.visible).toBe(false);
      expect(apiSpy.invalidateCache).toHaveBeenCalledWith('/opta');
      done();
    });
    expect(apiSpy.patch).toHaveBeenCalledWith(
      '/opta/competitions/admin/5',
      { visible: false, sortOrder: 9 },
    );
  });

  it('updateCompetitionAdmin: tek field gönderilir (partial)', () => {
    apiSpy.patch.and.returnValue(of({} as never));
    service.updateCompetitionAdmin(10, { visible: true }).subscribe();
    expect(apiSpy.patch).toHaveBeenCalledWith(
      '/opta/competitions/admin/10', { visible: true },
    );
  });
});
