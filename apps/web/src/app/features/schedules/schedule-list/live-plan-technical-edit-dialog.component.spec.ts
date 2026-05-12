import { TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

import {
  LivePlanTechnicalEditDialogComponent,
  type LivePlanTechnicalEditDialogData,
} from './live-plan-technical-edit-dialog.component';

/**
 * 2026-05-13: Faz 1+2. Wrapper dialog davranışı:
 *   - data {entryId, canWrite, canDelete} → child <app-technical-details-form>'a
 *     bind edilir
 *   - form (saved) → dialogRef.close('saved') (auto-close)
 *   - Kapat butonu → dialogRef.close()
 *
 * Child form'un kendi data load / save akışı kendi spec'inde test edilir;
 * burada sadece wrapper kontratı doğrulanır.
 */
describe('LivePlanTechnicalEditDialogComponent (wrapper)', () => {
  let dialogRefSpy: jasmine.SpyObj<MatDialogRef<LivePlanTechnicalEditDialogComponent>>;
  const data: LivePlanTechnicalEditDialogData = {
    entryId:   42,
    canWrite:  true,
    canDelete: false,
  };

  beforeEach(() => {
    dialogRefSpy = jasmine.createSpyObj('MatDialogRef', ['close']);

    TestBed.configureTestingModule({
      imports:   [LivePlanTechnicalEditDialogComponent, NoopAnimationsModule],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef,    useValue: dialogRefSpy },
      ],
    });
  });

  it('data injection ve render — entryId/canWrite/canDelete', () => {
    const fixture   = TestBed.createComponent(LivePlanTechnicalEditDialogComponent);
    const component = fixture.componentInstance;
    expect(component.data).toEqual(data);
    expect(component.data.entryId).toBe(42);
    expect(component.data.canWrite).toBeTrue();
    expect(component.data.canDelete).toBeFalse();
  });

  it('onSaved → dialogRef.close("saved")', () => {
    const fixture   = TestBed.createComponent(LivePlanTechnicalEditDialogComponent);
    fixture.componentInstance.onSaved();
    expect(dialogRefSpy.close).toHaveBeenCalledWith('saved');
  });

  it('onClose → dialogRef.close() (parametre yok)', () => {
    const fixture   = TestBed.createComponent(LivePlanTechnicalEditDialogComponent);
    fixture.componentInstance.onClose();
    expect(dialogRefSpy.close).toHaveBeenCalledWith();
  });
});
