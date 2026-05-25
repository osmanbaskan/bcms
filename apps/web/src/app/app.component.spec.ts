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

  describe('ProvysViewer izolasyonu (tek-grup kullanıcı)', () => {
    it('Yalnız Provys nav item görünür', () => {
      const cmp = setup([GROUP.ProvysViewer]);
      const groups = cmp.visibleGroups() as NavGroup[];
      const allItems = groups.flatMap((g) => g.items);
      expect(allItems.length).toBe(1);
      expect(allItems[0].route).toBe('/provys-content-control');
    });

    it('Çoklu grup (ProvysViewer + YayınPlanlama) izolasyon devreye girmez', () => {
      const cmp = setup([GROUP.ProvysViewer, GROUP.YayınPlanlama]);
      const groups = cmp.visibleGroups() as NavGroup[];
      const allItems = groups.flatMap((g) => g.items);
      // Çoklu grup → auth-only itemları (groups: []) görünür; sayım > 1
      expect(allItems.length).toBeGreaterThan(1);
    });

    it('Çoklu kullanıcı (Booking) ProvysViewer-only izolasyonundan etkilenmez', () => {
      const cmp = setup([GROUP.Booking]);
      const groups = cmp.visibleGroups() as NavGroup[];
      const allItems = groups.flatMap((g) => g.items);
      // 2026-05-25: Provys tüm Keycloak gruplarına açıldı; Booking artık
      // Provys'i görür. İzolasyon kuralı değişmedi: Booking tek-grup
      // ProvysViewer izolasyon branch'ine düşmediği için normal nav +
      // Provys erişimi alır.
      expect(allItems.some((it) => it.route === '/provys-content-control')).toBeTrue();
      expect(allItems.length).toBeGreaterThan(1);
    });
  });

  describe('Asrun nav visibility', () => {
    function findAsrun(cmp: AppComponent): NavItem | undefined {
      const groups = cmp.visibleGroups() as NavGroup[];
      for (const g of groups) for (const it of g.items) if (it.route === '/asrun') return it;
      return undefined;
    }

    it('Admin: Asrun görünür', () => {
      expect(findAsrun(setup([GROUP.Admin]))).toBeDefined();
    });
    it('MCR: Asrun görünür', () => {
      expect(findAsrun(setup([GROUP.MCR]))).toBeDefined();
    });
    it('SystemEng: Asrun görünür', () => {
      expect(findAsrun(setup([GROUP.SystemEng]))).toBeDefined();
    });
    it('ProvysViewer: Asrun GÖRÜNMEZ (V1 izolasyon)', () => {
      // ProvysViewer izolasyon branch'i sadece Provys'i içeren item'ları gösterir;
      // Asrun groups listesinde ProvysViewer yok → izolasyon zaten filtreler.
      expect(findAsrun(setup([GROUP.ProvysViewer]))).toBeUndefined();
    });
    it('Booking (yetkisiz): Asrun gizli', () => {
      expect(findAsrun(setup([GROUP.Booking]))).toBeUndefined();
    });
  });

  describe('EKİP nav visibility (2026-05-25: İş Takip + Haftalık Vardiya Admin/SystemEng only)', () => {
    function findRoute(cmp: AppComponent, route: string): NavItem | undefined {
      const groups = cmp.visibleGroups() as NavGroup[];
      for (const g of groups) for (const it of g.items) if (it.route === route) return it;
      return undefined;
    }

    it('Admin: İş Takip + Haftalık Vardiya görünür', () => {
      const cmp = setup([GROUP.Admin]);
      expect(findRoute(cmp, '/bookings')).toBeDefined();
      expect(findRoute(cmp, '/weekly-shift')).toBeDefined();
    });
    it('SystemEng: İş Takip + Haftalık Vardiya görünür', () => {
      const cmp = setup([GROUP.SystemEng]);
      expect(findRoute(cmp, '/bookings')).toBeDefined();
      expect(findRoute(cmp, '/weekly-shift')).toBeDefined();
    });
    it('Booking grubu: İş Takip artık görünmez (geçici kısıtlama)', () => {
      const cmp = setup([GROUP.Booking]);
      expect(findRoute(cmp, '/bookings')).toBeUndefined();
      expect(findRoute(cmp, '/weekly-shift')).toBeUndefined();
    });
    it('Tekyon (normal grup): görünmez', () => {
      const cmp = setup([GROUP.Tekyon]);
      expect(findRoute(cmp, '/bookings')).toBeUndefined();
      expect(findRoute(cmp, '/weekly-shift')).toBeUndefined();
    });
    it('MCR (normal grup): görünmez', () => {
      const cmp = setup([GROUP.MCR]);
      expect(findRoute(cmp, '/bookings')).toBeUndefined();
      expect(findRoute(cmp, '/weekly-shift')).toBeUndefined();
    });
    it('ProvysViewer-only: EKİP grubu zaten görmez', () => {
      const groups = setup([GROUP.ProvysViewer]).visibleGroups() as NavGroup[];
      const ekip = groups.find((g) => g.label === 'EKİP');
      expect(ekip).toBeUndefined();
    });
  });

  describe('Live-Plan Lookup nav visibility (2026-05-25: Admin/SystemEng only)', () => {
    function findLpLookup(cmp: AppComponent): NavItem | undefined {
      const groups = cmp.visibleGroups() as NavGroup[];
      for (const g of groups) for (const it of g.items) if (it.route === '/admin/live-plan-lookups') return it;
      return undefined;
    }

    it('Admin: Live-Plan Lookup görünür', () => {
      expect(findLpLookup(setup([GROUP.Admin]))).toBeDefined();
    });
    it('SystemEng: Live-Plan Lookup görünür', () => {
      expect(findLpLookup(setup([GROUP.SystemEng]))).toBeDefined();
    });
    it('Booking (normal): Live-Plan Lookup gizli', () => {
      expect(findLpLookup(setup([GROUP.Booking]))).toBeUndefined();
    });
    it('Tekyon (normal): Live-Plan Lookup gizli', () => {
      expect(findLpLookup(setup([GROUP.Tekyon]))).toBeUndefined();
    });
    it('YayınPlanlama (normal): Live-Plan Lookup gizli', () => {
      expect(findLpLookup(setup([GROUP.YayınPlanlama]))).toBeUndefined();
    });
    it('ProvysViewer-only: YÖNETİM başlığı tamamen gizli (LP Lookup dahil)', () => {
      const groups = setup([GROUP.ProvysViewer]).visibleGroups() as NavGroup[];
      const yonetim = groups.find((g) => g.label === 'YÖNETİM');
      expect(yonetim).toBeUndefined();
      expect(findLpLookup(setup([GROUP.ProvysViewer]))).toBeUndefined();
    });
  });
});
