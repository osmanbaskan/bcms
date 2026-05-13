import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { of } from 'rxjs';
import { SettingsComponent } from './settings.component';
import { ApiService } from '../../core/services/api.service';

/**
 * 2026-05-13: Settings page render smoke + yeni "OPTA Lig Görünürlüğü"
 * card linkinin /admin/opta-competitions'a gittiği doğrulaması.
 *
 * Permission gating route-level (AuthGuard + data.groups); card her zaman
 * render edilir, yetkisiz tıklamada AuthGuard reddeder.
 */
describe('SettingsComponent', () => {
  beforeEach(async () => {
    const apiSpy = jasmine.createSpyObj('ApiService', ['get', 'post', 'put']);
    apiSpy.get.and.callFake((path: string) => {
      if (path === '/settings/opta-smb') {
        return of({ share: '', mountPoint: '', subdir: '', username: '', domain: '' });
      }
      if (path === '/ingest/recording-ports/admin') {
        return of([]);
      }
      return of({});
    });
    apiSpy.put.and.returnValue(of({}));
    apiSpy.post.and.returnValue(of({}));

    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: [
        provideRouter([]),
        provideAnimationsAsync(),
        { provide: ApiService, useValue: apiSpy },
      ],
    }).compileComponents();
  });

  it('OPTA Lig Görünürlüğü card render edilir + /admin/opta-competitions linki', () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.textContent ?? '';
    expect(text).toContain('OPTA Lig / Turnuva Görünürlüğü');

    const anchors = Array.from(host.querySelectorAll('a[routerLink]'));
    const optaLink = anchors.find((a) => a.getAttribute('routerLink') === '/admin/opta-competitions');
    expect(optaLink).toBeTruthy();
    expect(optaLink!.textContent).toContain('Aç');
  });
});
