import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApiService } from './api.service';
import { environment } from '../../../environments/environment';

describe('ApiService', () => {
  let service: ApiService;
  let httpMock: HttpTestingController;
  const base = environment.apiUrl;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ApiService],
    });
    service = TestBed.inject(ApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GET isteği doğru URL ve params ile göndermeli', () => {
    service.get('/schedules', { page: 1, active: true }).subscribe();
    const req = httpMock.expectOne(`${base}/schedules?page=1&active=true`);
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('PATCH isteği If-Match header eklemeli', () => {
    service.patch('/schedules/1', { title: 'X' }, 3).subscribe();
    const req = httpMock.expectOne(`${base}/schedules/1`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.headers.get('If-Match')).toBe('3');
    req.flush({});
  });

  it('POST isteği body ile göndermeli', () => {
    const body = { name: 'test' };
    service.post('/channels', body).subscribe();
    const req = httpMock.expectOne(`${base}/channels`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(body);
    req.flush({});
  });
});
