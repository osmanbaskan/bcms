import { TestBed, ComponentFixture } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { of } from 'rxjs';

import { LookupListComponent } from './lookup-list.component';
import { ApiService } from '../../../core/services/api.service';
import type { LookupDefinition, LookupListResponse } from './lookup.types';

const PLAIN_DEF: LookupDefinition = {
  type:        'transmission_satellites',
  label:       'Uydular',
  group:       'transmission',
  polymorphic: false,
};

const POLY_DEF: LookupDefinition = {
  type:         'technical_companies',
  label:        'Teknik Firmalar',
  group:        'technical',
  polymorphic:  true,
  allowedTypes: ['OB_VAN', 'GENERATOR'] as const,
};

const EMPTY_RESPONSE: LookupListResponse = {
  items: [], total: 0, page: 1, pageSize: 500,
};

describe('LookupListComponent', () => {
  let component: LookupListComponent;
  let fixture: ComponentFixture<LookupListComponent>;
  let api: jasmine.SpyObj<ApiService>;
  let dialog: jasmine.SpyObj<MatDialog>;
  let confirmResult = true;

  function makeDialogRef(result: unknown): MatDialogRef<unknown> {
    return { afterClosed: () => of(result) } as unknown as MatDialogRef<unknown>;
  }

  beforeEach(() => {
    api = jasmine.createSpyObj('ApiService', ['get', 'post', 'patch', 'delete']);
    api.get.and.returnValue(of(EMPTY_RESPONSE));
    api.post.and.returnValue(of({}));
    api.patch.and.returnValue(of({}));
    api.delete.and.returnValue(of({}));

    confirmResult = true;
    dialog = jasmine.createSpyObj('MatDialog', ['open']);
    dialog.open.and.callFake(() => makeDialogRef(confirmResult) as MatDialogRef<unknown, unknown>);

    TestBed.configureTestingModule({
      imports:   [LookupListComponent, NoopAnimationsModule],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: MatDialog,  useValue: dialog },
      ],
    });

    fixture   = TestBed.createComponent(LookupListComponent);
    component = fixture.componentInstance;
    // MatDialog standalone import üzerinden de provide edildiği için
    // TestBed.providers override'ı çalışmıyor; spy'ı doğrudan instance'a ata.
    (component as unknown as { dialog: MatDialog }).dialog = dialog;
  });

  afterEach(() => fixture.destroy());

  it('definition değişince registry endpoint ile yüklemeli', () => {
    component.definition = PLAIN_DEF;
    component.ngOnChanges({
      definition: { previousValue: undefined, currentValue: PLAIN_DEF, firstChange: true, isFirstChange: () => true },
    });

    expect(api.get).toHaveBeenCalledWith(
      '/live-plan/lookups/transmission_satellites',
      jasmine.objectContaining({
        activeOnly:     false,
        includeDeleted: false,
        pageSize:       500,
      }),
    );
    const params = api.get.calls.mostRecent().args[1] as Record<string, unknown>;
    expect(params['type']).toBeUndefined();
  });

  it('polymorphic + typeFilter set olduğunda type query param geçmeli', () => {
    component.definition  = POLY_DEF;
    component.canWrite    = true;
    component.typeFilter  = 'OB_VAN';
    component.load();

    const params = api.get.calls.mostRecent().args[1] as Record<string, unknown>;
    expect(params['type']).toBe('OB_VAN');
  });

  it('canWrite false iken includeDeleted true olsa bile false gönderilmeli (page-level guard)', () => {
    component.definition     = PLAIN_DEF;
    component.canWrite       = false;
    component.includeDeleted = true;
    component.load();

    const params = api.get.calls.mostRecent().args[1] as Record<string, unknown>;
    expect(params['includeDeleted']).toBeFalse();
  });

  it('softDelete confirm dialog açıp onay sonrası DELETE endpoint çağırmalı', () => {
    confirmResult = true;
    component.definition = PLAIN_DEF;
    component.softDelete({
      id: 7, label: 'X', active: true, sortOrder: 0,
      createdAt: '', updatedAt: '', deletedAt: null,
    });

    expect(dialog.open).toHaveBeenCalledTimes(1);
    expect(api.delete).toHaveBeenCalledWith('/live-plan/lookups/transmission_satellites/7');
  });

  it('softDelete iptal edilirse DELETE çağrılmamalı', () => {
    confirmResult = false;
    component.definition = PLAIN_DEF;
    component.softDelete({
      id: 7, label: 'X', active: true, sortOrder: 0,
      createdAt: '', updatedAt: '', deletedAt: null,
    });

    expect(dialog.open).toHaveBeenCalledTimes(1);
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('restore confirm sonrası PATCH ile deletedAt:null body göndermeli', () => {
    confirmResult = true;
    component.definition = PLAIN_DEF;
    component.restore({
      id: 9, label: 'Y', active: false, sortOrder: 0,
      createdAt: '', updatedAt: '', deletedAt: '2026-05-01T00:00:00Z',
    });

    expect(dialog.open).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith(
      '/live-plan/lookups/transmission_satellites/9',
      { deletedAt: null },
    );
  });

  it('restore iptal edilirse PATCH çağrılmamalı', () => {
    confirmResult = false;
    component.definition = PLAIN_DEF;
    component.restore({
      id: 9, label: 'Y', active: false, sortOrder: 0,
      createdAt: '', updatedAt: '', deletedAt: '2026-05-01T00:00:00Z',
    });

    expect(dialog.open).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('cols polymorphic için type kolonu içermeli', () => {
    component.definition = POLY_DEF;
    expect(component.cols()).toContain('type');

    component.definition = PLAIN_DEF;
    expect(component.cols()).not.toContain('type');
  });
});
