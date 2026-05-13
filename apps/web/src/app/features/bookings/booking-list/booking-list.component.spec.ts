import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { HttpErrorResponse } from '@angular/common/http';
import { MatDialog, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { KeycloakService } from 'keycloak-angular';
import { BookingListComponent, BookingTaskDialogComponent } from './booking-list.component';
import { ApiService } from '../../../core/services/api.service';

/**
 * 2026-05-14: İş Takip — toolbar + yorum + status history fix testleri.
 *
 * Kapsam:
 *   1. Sekme adı "İş Takip" (h1)
 *   2. Title search debounce + qTitle param
 *   3. Whitespace search göndermez
 *   4. clearSearch reset
 *   5. selectedStatus dropdown → status param
 *   6. "Tümü" status → param yok
 *   7. title + status birlikte
 *   8. Dialog edit mode: comments + status history fetch
 *   9. Dialog yeni mode: fetch yok
 *  10. Comment submit POST + optimistic + rollback
 */

function makeKeycloakStub(): Partial<KeycloakService> {
  return {
    getKeycloakInstance: () => ({
      tokenParsed: { preferred_username: 'tester', sub: 'tester-sub', groups: [] },
    }) as any,
  };
}

describe('BookingListComponent — İş Takip toolbar', () => {
  let apiSpy: jasmine.SpyObj<ApiService>;

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj('ApiService', ['get', 'post', 'patch', 'delete']);
    apiSpy.get.and.returnValue(of({ data: [], total: 0, page: 1, pageSize: 50, totalPages: 0, groups: [], canAssignGroups: [] }));

    TestBed.configureTestingModule({
      imports: [BookingListComponent],
      providers: [
        provideAnimationsAsync(),
        { provide: ApiService,      useValue: apiSpy },
        { provide: KeycloakService, useValue: makeKeycloakStub() },
        { provide: MatDialog,       useValue: { open: () => ({ afterClosed: () => of(undefined) }) } },
      ],
    });
  });

  function render() {
    const f = TestBed.createComponent(BookingListComponent);
    f.detectChanges();
    return { fixture: f, component: f.componentInstance, el: f.nativeElement as HTMLElement };
  }

  it('oluşturulur ve sekme başlığı "İş Takip" olur', () => {
    const { el } = render();
    const h1 = el.querySelector('h1');
    expect(h1?.textContent?.trim()).toBe('İş Takip');
  });

  it('searchTitle değişimi 300ms debounce sonrası qTitle param ile load çağırır', fakeAsync(() => {
    const { component } = render();
    apiSpy.get.calls.reset();
    component.searchTitle = 'yayın';
    component.onSearchInput();
    tick(299);
    expect(apiSpy.get.calls.count()).toBe(0); // debounce penceresi içinde
    tick(2);
    const lastArgs = apiSpy.get.calls.mostRecent().args;
    expect(lastArgs[0]).toBe('/bookings');
    expect((lastArgs[1] as Record<string, string>)['qTitle']).toBe('yayın');
  }));

  it('whitespace-only searchTitle → qTitle param backend\'e gönderilmez', fakeAsync(() => {
    const { component } = render();
    apiSpy.get.calls.reset();
    component.searchTitle = '   ';
    component.onSearchInput();
    tick(310);
    const args = apiSpy.get.calls.mostRecent().args;
    const params = args[1] as Record<string, string> | undefined;
    expect(params?.['qTitle']).toBeUndefined();
  }));

  it('clearSearch() → searchTitle temizler + load çağrılır', () => {
    const { component } = render();
    component.searchTitle = 'foo';
    apiSpy.get.calls.reset();
    component.clearSearch();
    expect(component.searchTitle).toBe('');
    expect(apiSpy.get).toHaveBeenCalled();
  });

  it('selectedStatus → status param gönderir', () => {
    const { component } = render();
    apiSpy.get.calls.reset();
    component.selectedStatus = 'APPROVED';
    component.onStatusChange();
    const params = apiSpy.get.calls.mostRecent().args[1] as Record<string, string>;
    expect(params['status']).toBe('APPROVED');
  });

  it('"Tümü" status ("") → status param backend\'e gönderilmez', () => {
    const { component } = render();
    apiSpy.get.calls.reset();
    component.selectedStatus = '';
    component.onStatusChange();
    const args = apiSpy.get.calls.mostRecent().args;
    const params = args[1] as Record<string, string> | undefined;
    expect(params?.['status']).toBeUndefined();
  });

  it('searchTitle + selectedStatus birlikte → her iki param gönderilir', () => {
    const { component } = render();
    component.searchTitle = 'plan';
    component.selectedStatus = 'PENDING';
    apiSpy.get.calls.reset();
    component.load();
    const params = apiSpy.get.calls.mostRecent().args[1] as Record<string, string>;
    expect(params['qTitle']).toBe('plan');
    expect(params['status']).toBe('PENDING');
  });
});

describe('BookingTaskDialogComponent — Yorum + Durum Geçmişi', () => {
  let apiSpy: jasmine.SpyObj<ApiService>;
  let dialogRefSpy: jasmine.SpyObj<MatDialogRef<BookingTaskDialogComponent>>;

  function makeBooking(overrides: Partial<any> = {}) {
    return {
      id: 7, scheduleId: null, requestedBy: 'rep', taskTitle: 'X',
      userGroup: 'Booking', status: 'PENDING', version: 1, createdAt: '', updatedAt: '',
      ...overrides,
    };
  }

  function build(data: any) {
    apiSpy = jasmine.createSpyObj('ApiService', ['get', 'post', 'patch']);
    dialogRefSpy = jasmine.createSpyObj('MatDialogRef', ['close']);
    (apiSpy.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path === '/bookings/assignees')   return of([] as unknown[]);
      if (path.endsWith('/comments'))       return of([] as unknown[]);
      if (path.endsWith('/status-history')) return of([] as unknown[]);
      return of([] as unknown[]);
    });

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [BookingTaskDialogComponent],
      providers: [
        provideAnimationsAsync(),
        { provide: ApiService,      useValue: apiSpy },
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef,    useValue: dialogRefSpy },
      ],
    });
    const fix = TestBed.createComponent(BookingTaskDialogComponent);
    fix.detectChanges();
    return fix;
  }

  it('edit mode (data.booking var): ngOnInit comments + status-history fetch eder', () => {
    const fix = build({ booking: makeBooking(), groups: ['Booking'], canAssignGroups: [] });
    const paths = apiSpy.get.calls.allArgs().map((a) => a[0]);
    expect(paths).toContain('/bookings/7/comments');
    expect(paths).toContain('/bookings/7/status-history');
    fix.destroy();
  });

  it('yeni mode (data.booking yok): comments/status-history fetch edilmez', () => {
    const fix = build({ booking: undefined, groups: ['Booking'], canAssignGroups: [] });
    const paths = apiSpy.get.calls.allArgs().map((a) => a[0]);
    expect(paths).not.toContain('/bookings/undefined/comments');
    expect(paths.some((p) => p.endsWith('/comments'))).toBeFalse();
    expect(paths.some((p) => p.endsWith('/status-history'))).toBeFalse();
    fix.destroy();
  });

  it('submitComment POST + optimistic append + sunucu response ile replace', () => {
    const fix = build({ booking: makeBooking(), groups: ['Booking'], canAssignGroups: [] });
    const cmp = fix.componentInstance as any;
    apiSpy.post.and.returnValue(of({
      id: 99, bookingId: 7, authorUserId: 'tester', authorName: 'Tester',
      body: 'merhaba', createdAt: '2026-05-14T10:00:00Z', updatedAt: '2026-05-14T10:00:00Z',
    }));
    cmp.commentBody = 'merhaba';
    cmp.submitComment();
    expect(apiSpy.post).toHaveBeenCalledWith('/bookings/7/comments', { body: 'merhaba' });
    // POST tamamlandıktan sonra liste 1 gerçek kayıt içermeli (negatif id silinir)
    expect(cmp.comments().length).toBe(1);
    expect(cmp.comments()[0].id).toBe(99);
    expect(cmp.commentBody).toBe('');
    fix.destroy();
  });

  it('submitComment hata → rollback (signal eski hale döner, body geri yüklenir)', () => {
    const fix = build({ booking: makeBooking(), groups: ['Booking'], canAssignGroups: [] });
    const cmp = fix.componentInstance as any;
    apiSpy.post.and.returnValue(throwError(() => new HttpErrorResponse({ status: 500, error: { message: 'fail' } })));
    cmp.commentBody = 'denedim';
    cmp.submitComment();
    expect(cmp.comments().length).toBe(0); // optimistic eklenip rollback edildi
    expect(cmp.commentBody).toBe('denedim');
    fix.destroy();
  });

  it('canSubmitComment whitespace body için false', () => {
    const fix = build({ booking: makeBooking(), groups: ['Booking'], canAssignGroups: [] });
    const cmp = fix.componentInstance as any;
    cmp.commentBody = '   ';
    expect(cmp.canSubmitComment()).toBeFalse();
    fix.destroy();
  });

  it('statusLabel mevcut status değerlerini Türkçe etikete çevirir', () => {
    const fix = build({ booking: makeBooking(), groups: ['Booking'], canAssignGroups: [] });
    const cmp = fix.componentInstance as any;
    expect(cmp.statusLabel('PENDING')).toBe('Açık');
    expect(cmp.statusLabel('APPROVED')).toBe('Tamamlandı');
    expect(cmp.statusLabel('REJECTED')).toBe('Reddedildi');
    expect(cmp.statusLabel('CANCELLED')).toBe('İptal');
    expect(cmp.statusLabel('UNKNOWN')).toBe('UNKNOWN'); // fallback
    fix.destroy();
  });
});
