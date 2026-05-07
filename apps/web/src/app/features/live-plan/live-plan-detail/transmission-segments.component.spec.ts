import { TestBed, ComponentFixture } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { of } from 'rxjs';

import { TransmissionSegmentsComponent } from './transmission-segments.component';
import { ApiService } from '../../../core/services/api.service';
import type { TransmissionSegment } from '../live-plan.types';

const SEG_FIXTURE: TransmissionSegment = {
  id:              7,
  livePlanEntryId: 42,
  feedRole:        'MAIN',
  kind:            'PROGRAM',
  startTime:       '2026-06-01T19:30:00.000Z',
  endTime:         '2026-06-01T20:30:00.000Z',
  description:     'Test segment',
  createdAt:       '2026-06-01T19:00:00.000Z',
  updatedAt:       '2026-06-01T19:00:00.000Z',
  deletedAt:       null,
};

describe('TransmissionSegmentsComponent', () => {
  let fixture: ComponentFixture<TransmissionSegmentsComponent>;
  let component: TransmissionSegmentsComponent;
  let api: jasmine.SpyObj<ApiService>;
  let dialog: jasmine.SpyObj<MatDialog>;
  let confirmResult = true;

  function makeDialogRef(result: unknown): MatDialogRef<unknown> {
    return { afterClosed: () => of(result) } as unknown as MatDialogRef<unknown>;
  }

  beforeEach(() => {
    api = jasmine.createSpyObj('ApiService', ['get', 'post', 'patch', 'delete']);
    api.get.and.returnValue(of([SEG_FIXTURE]));
    api.post.and.returnValue(of({}));
    api.patch.and.returnValue(of({}));
    api.delete.and.returnValue(of({}));

    confirmResult = true;
    dialog = jasmine.createSpyObj('MatDialog', ['open']);
    dialog.open.and.callFake(() => makeDialogRef(confirmResult) as MatDialogRef<unknown, unknown>);

    TestBed.configureTestingModule({
      imports:   [TransmissionSegmentsComponent, NoopAnimationsModule],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: MatDialog, useValue: dialog },
      ],
    });

    fixture   = TestBed.createComponent(TransmissionSegmentsComponent);
    component = fixture.componentInstance;
    component.entryId   = 42;
    component.canWrite  = true;
    component.canDelete = true;
    // MatDialog standalone import üzerinden re-provide olduğu için
    // TestBed.providers override'ı yetmiyor; instance'a doğrudan ata.
    (component as unknown as { dialog: MatDialog }).dialog = dialog;
  });

  afterEach(() => fixture.destroy());

  it('entryId değişince segments endpoint çağrılır', () => {
    component.ngOnChanges({
      entryId: { previousValue: undefined, currentValue: 42, firstChange: true, isFirstChange: () => true },
    });
    expect(api.get).toHaveBeenCalledWith('/live-plan/42/segments', jasmine.any(Object));
    const params = api.get.calls.mostRecent().args[1] as Record<string, unknown>;
    expect(params['feedRole']).toBeUndefined();
    expect(params['kind']).toBeUndefined();
  });

  it('feedRole filter set edilirse query param geçer', () => {
    component.feedRoleFilter = 'BACKUP';
    component.load();
    const params = api.get.calls.mostRecent().args[1] as Record<string, unknown>;
    expect(params['feedRole']).toBe('BACKUP');
  });

  it('softDelete confirm sonrası DELETE endpoint çağrılır', () => {
    confirmResult = true;
    component.softDelete(SEG_FIXTURE);
    expect(dialog.open).toHaveBeenCalledTimes(1);
    expect(api.delete).toHaveBeenCalledWith('/live-plan/42/segments/7');
  });

  it('softDelete iptal edilirse DELETE çağrılmaz', () => {
    confirmResult = false;
    component.softDelete(SEG_FIXTURE);
    expect(dialog.open).toHaveBeenCalledTimes(1);
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('openCreate dialog açar; sonuç ok ise list yenilenir', () => {
    confirmResult = true; // form dialog "true" = save success simulation
    api.get.calls.reset();
    component.openCreate();
    expect(dialog.open).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1); // load() afterClosed'de tetiklendi
  });

  it('formatTime UTC HH:MM döndürür', () => {
    expect(component.formatTime('2026-06-01T19:30:00.000Z')).toBe('19:30');
  });

  it('duration MAIN program 1s 0dk', () => {
    expect(component.duration(SEG_FIXTURE.startTime, SEG_FIXTURE.endTime)).toBe('1s 0dk');
  });
});
