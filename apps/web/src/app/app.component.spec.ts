import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient } from '@angular/common/http';
import { KeycloakService } from 'keycloak-angular';
import { GROUP } from '@bcms/shared';
import { AppComponent } from './app.component';

/**
 * 2026-05-13: AppComponent nav `visibleGroups` filter testleri — yeni
 * "OPTA Lig Görünürlüğü" item'ının Admin/SystemEng için görünür,
 * yetkisiz kullanıcı için gizli olduğunu doğrular.
 *
 * Mevcut `visibleGroups` computed Admin auto-bypass + group membership
 * paterni (app.component.ts:577-589) kullanır.
 */

function makeKc(groups: string[]): jasmine.SpyObj<KeycloakService> {
  const kc = jasmine.createSpyObj('KeycloakService', ['getKeycloakInstance', 'isLoggedIn']);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kc.getKeycloakInstance.and.returnValue({ tokenParsed: { groups } } as any);
  kc.isLoggedIn.and.returnValue(Promise.resolve(true));
  return kc;
}

interface NavItem { label: string; route: string; groups: string[] }
interface NavGroup { label: string; items: NavItem[] }

describe('AppComponent — nav visibility (2026-05-13 yeni "OPTA Lig Görünürlüğü")', () => {
  function setup(groups: string[]): AppComponent {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        provideAnimationsAsync(),
        provideHttpClient(),
        { provide: KeycloakService, useValue: makeKc(groups) },
      ],
    });
    const fixture = TestBed.createComponent(AppComponent);
    const cmp = fixture.componentInstance;
    // Bypass ngOnInit Keycloak race; doğrudan state set.
    cmp.userGroups.set(groups);
    return cmp;
  }

  function findOptaItem(cmp: AppComponent): NavItem | undefined {
    const groups = cmp.visibleGroups() as NavGroup[];
    for (const g of groups) {
      for (const it of g.items) {
        if (it.route === '/admin/opta-competitions') return it;
      }
    }
    return undefined;
  }

  it('Admin (auto-bypass): "OPTA Lig Görünürlüğü" nav item görünür', () => {
    const cmp = setup([GROUP.Admin]);
    const item = findOptaItem(cmp);
    expect(item).toBeDefined();
    expect(item?.label).toBe('OPTA Lig Görünürlüğü');
  });

  it('SystemEng: "OPTA Lig Görünürlüğü" nav item görünür', () => {
    const cmp = setup([GROUP.SystemEng]);
    const item = findOptaItem(cmp);
    expect(item).toBeDefined();
  });

  it('Booking (yetkisiz): "OPTA Lig Görünürlüğü" nav item gizli', () => {
    const cmp = setup([GROUP.Booking]);
    const item = findOptaItem(cmp);
    expect(item).toBeUndefined();
  });

  it('Boş groups: "OPTA Lig Görünürlüğü" nav item gizli', () => {
    const cmp = setup([]);
    const item = findOptaItem(cmp);
    expect(item).toBeUndefined();
  });
});
