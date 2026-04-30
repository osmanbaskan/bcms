import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { Subject } from 'rxjs';
import { ReportIssueDialogComponent } from './schedule-list.component';
import { ApiService } from '../../../core/services/api.service';

describe('ReportIssueDialogComponent', () => {
  let component: ReportIssueDialogComponent;
  let fixture: import('@angular/core/testing').ComponentFixture<ReportIssueDialogComponent>;
  let apiSpy: jasmine.SpyObj<ApiService>;
  let dialogRefSpy: { close: jasmine.Spy };

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj('ApiService', ['post']);
    dialogRefSpy = { close: jasmine.createSpy('close') };

    TestBed.configureTestingModule({
      imports: [ReportIssueDialogComponent],
      providers: [
        { provide: ApiService, useValue: apiSpy },
        { provide: MAT_DIALOG_DATA, useValue: {
          schedule: {
            id: 1,
            title: 'Test Program',
            startTime: '2024-01-01T10:00:00Z',
            endTime: '2024-01-01T12:00:00Z',
            channel: { name: 'Kanal 1' },
          },
        }},
        { provide: MatDialogRef, useValue: dialogRefSpy },
      ],
    }).overrideComponent(ReportIssueDialogComponent, {
      set: { template: '' },
    });

    fixture = TestBed.createComponent(ReportIssueDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('oluşturulmalı', () => {
    expect(component).toBeTruthy();
  });

  it('save başarılıysa dialog kapanmalı', fakeAsync(() => {
    apiSpy.post.and.returnValue(new Subject().asObservable());
    component.description = 'Bir sorun var';
    component.save();
    tick(1);
    expect(apiSpy.post).toHaveBeenCalled();
  }));

  it('save hata verirse errorMsg set edilmeli', fakeAsync(() => {
    const sub = new Subject<void>();
    apiSpy.post.and.returnValue(sub.asObservable());

    component.description = 'Bir sorun var';
    component.save();
    tick(1);
    expect(component.saving()).toBeTrue();

    sub.error({ error: { message: 'Sunucu hatası' } });
    tick(1);

    expect(component.saving()).toBeFalse();
    expect(component.errorMsg()).toBe('Sunucu hatası');
    expect(dialogRefSpy.close).not.toHaveBeenCalled();
  }));
});
