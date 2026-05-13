import { TestBed } from '@angular/core/testing';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { OptaCompetitionsComponent } from './opta-competitions.component';
import {
  OptaAdminService,
  type OptaCompetitionAdminItem,
} from '../../../core/services/opta-admin.service';

function makeItem(overrides: Partial<OptaCompetitionAdminItem> = {}): OptaCompetitionAdminItem {
  return {
    id: 1, code: 'opta-115', name: 'Süper Lig', country: 'TR',
    visible: true, sortOrder: 1, sportGroup: 'football',
    ...overrides,
  };
}

describe('OptaCompetitionsComponent (admin/opta-competitions)', () => {
  let svcSpy: jasmine.SpyObj<OptaAdminService>;

  beforeEach(async () => {
    svcSpy = jasmine.createSpyObj('OptaAdminService', [
      'getCompetitionAdminList', 'updateCompetitionAdmin',
    ]);
    svcSpy.getCompetitionAdminList.and.returnValue(of([
      makeItem({ id: 1, code: 'opta-115', name: 'Süper Lig', visible: true, sortOrder: 1 }),
      makeItem({ id: 2, code: 'opta-hidden', name: 'Hidden', visible: false, sortOrder: 99 }),
    ]));
    svcSpy.updateCompetitionAdmin.and.returnValue(of(makeItem({ id: 1, visible: false, sortOrder: 5 })));

    await TestBed.configureTestingModule({
      imports: [OptaCompetitionsComponent],
      providers: [
        provideAnimationsAsync(),
        { provide: OptaAdminService, useValue: svcSpy },
      ],
    }).compileComponents();
  });

  it('ngOnInit: getCompetitionAdminList çağrılır + rows doldurulur', () => {
    const fixture = TestBed.createComponent(OptaCompetitionsComponent);
    fixture.detectChanges();
    expect(svcSpy.getCompetitionAdminList).toHaveBeenCalled();
    const cmp = fixture.componentInstance as unknown as {
      rows(): Array<{ id: number; visible: boolean; draftVisible: boolean }>;
    };
    expect(cmp.rows().length).toBe(2);
    expect(cmp.rows()[0].draftVisible).toBe(true);
  });

  it('tablo render: visible/hidden satırlar görünür (Görünür kolon mat-slide-toggle)', () => {
    const fixture = TestBed.createComponent(OptaCompetitionsComponent);
    fixture.detectChanges();
    const html = fixture.nativeElement as HTMLElement;
    const toggles = html.querySelectorAll('mat-slide-toggle');
    expect(toggles.length).toBe(2);
    const text = html.textContent ?? '';
    expect(text).toContain('Süper Lig');
    expect(text).toContain('Hidden');
  });

  it('save: draftVisible değiştirilince service.updateCompetitionAdmin çağrılır', () => {
    const fixture = TestBed.createComponent(OptaCompetitionsComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as {
      rows(): Array<{ id: number; visible: boolean; sortOrder: number; draftVisible: boolean; draftSortOrder: number; saving: boolean }>;
      save(r: typeof cmp.rows extends () => Array<infer R> ? R : never): void;
      isDirty(r: { visible: boolean; sortOrder: number; draftVisible: boolean; draftSortOrder: number }): boolean;
    };
    const row = cmp.rows()[0];
    row.draftVisible = false;
    expect(cmp.isDirty(row)).toBeTrue();
    cmp.save(row);
    expect(svcSpy.updateCompetitionAdmin).toHaveBeenCalledWith(1, { visible: false });
  });

  it('save: sortOrder değişimi → service.updateCompetitionAdmin', () => {
    const fixture = TestBed.createComponent(OptaCompetitionsComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as {
      rows(): Array<{ id: number; draftSortOrder: number; sortOrder: number; visible: boolean; draftVisible: boolean }>;
      save(r: { id: number; draftSortOrder: number; sortOrder: number; visible: boolean; draftVisible: boolean }): void;
    };
    const row = cmp.rows()[0];
    row.draftSortOrder = 42;
    cmp.save(row);
    expect(svcSpy.updateCompetitionAdmin).toHaveBeenCalledWith(1, { sortOrder: 42 });
  });

  it('save: dirty değil → service çağrılmaz (no-op)', () => {
    const fixture = TestBed.createComponent(OptaCompetitionsComponent);
    fixture.detectChanges();
    svcSpy.updateCompetitionAdmin.calls.reset();
    const cmp = fixture.componentInstance as unknown as {
      rows(): Array<unknown>;
      save(r: unknown): void;
    };
    cmp.save(cmp.rows()[0]);
    expect(svcSpy.updateCompetitionAdmin).not.toHaveBeenCalled();
  });

  it('save error: hata sonrası saving false döner (rollback davranışı)', () => {
    svcSpy.updateCompetitionAdmin.and.returnValue(throwError(() =>
      new HttpErrorResponse({ status: 500, error: { message: 'oops' } }),
    ));
    const fixture = TestBed.createComponent(OptaCompetitionsComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as {
      rows(): Array<{ saving: boolean; draftVisible: boolean }>;
      save(r: { saving: boolean; draftVisible: boolean }): void;
    };
    const row = cmp.rows()[0];
    row.draftVisible = false;
    cmp.save(row);
    expect(row.saving).toBeFalse();
  });
});
