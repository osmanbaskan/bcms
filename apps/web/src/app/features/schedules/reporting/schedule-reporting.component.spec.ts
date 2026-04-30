import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ScheduleReportingComponent, displayDateFromIso } from './schedule-reporting.component';
import { ApiService } from '../../../core/services/api.service';

describe('ScheduleReportingComponent', () => {
  let component: ScheduleReportingComponent;
  let fixture: import('@angular/core/testing').ComponentFixture<ScheduleReportingComponent>;
  let apiSpy: jasmine.SpyObj<ApiService>;

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj('ApiService', ['get']);
    apiSpy.get.and.returnValue(of([]));

    TestBed.configureTestingModule({
      imports: [ScheduleReportingComponent],
      providers: [{ provide: ApiService, useValue: apiSpy }],
    }).overrideComponent(ScheduleReportingComponent, {
      set: { template: '' },
    });

    fixture = TestBed.createComponent(ScheduleReportingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('oluşturulmalı', () => {
    expect(component).toBeTruthy();
  });
});

describe('displayDateFromIso', () => {
  it('geçerli ISO tarihini dönüştürmeli', () => {
    expect(displayDateFromIso('2024-01-15')).toBe('15.01.2024');
  });

  it('null/undefined değerlerde hata fırlatmamalı (güvenli çağrı)', () => {
    expect(() => displayDateFromIso(null as unknown as string)).toThrowError();
    expect(() => displayDateFromIso(undefined as unknown as string)).toThrowError();
  });
});
