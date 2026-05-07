import { TestBed, ComponentFixture } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { KeycloakService } from 'keycloak-angular';
import { of } from 'rxjs';

import { AdminLookupsComponent } from './admin-lookups.component';
import { ApiService } from '../../../core/services/api.service';
import { GROUP } from '@bcms/shared';
import { LOOKUP_DEFINITIONS } from './lookup.types';

function makeKc(groups: string[]): jasmine.SpyObj<KeycloakService> {
  const kc = jasmine.createSpyObj('KeycloakService', ['getKeycloakInstance']);
  kc.getKeycloakInstance.and.returnValue({ tokenParsed: { groups } } as any);
  return kc;
}

describe('AdminLookupsComponent', () => {
  let fixture: ComponentFixture<AdminLookupsComponent>;
  let component: AdminLookupsComponent;

  function setup(groups: string[]) {
    TestBed.resetTestingModule();
    const apiSpy = jasmine.createSpyObj('ApiService', ['get', 'post', 'patch', 'delete']);
    apiSpy.get.and.returnValue(of({ items: [], total: 0, page: 1, pageSize: 500 }));
    TestBed.configureTestingModule({
      imports: [AdminLookupsComponent, NoopAnimationsModule],
      providers: [
        { provide: KeycloakService, useValue: makeKc(groups) },
        { provide: ApiService, useValue: apiSpy },
      ],
    });
    fixture   = TestBed.createComponent(AdminLookupsComponent);
    component = fixture.componentInstance;
    // ngOnInit bypass ediliyor — environment.skipAuth=true test ortamında
    // userGroups'u her zaman SystemEng'e set ederdi. Onun yerine state'i
    // doğrudan yazıp computed'lar test ediliyor.
    component.userGroups.set(groups);
    if (LOOKUP_DEFINITIONS.length > 0) component.selected.set(LOOKUP_DEFINITIONS[0]);
  }

  afterEach(() => fixture?.destroy());

  it('SystemEng ile canWrite ve canDelete true olmalı', () => {
    setup([GROUP.SystemEng]);
    expect(component.canWrite()).toBeTrue();
    expect(component.canDelete()).toBeTrue();
  });

  it('Admin ile bypass — canWrite/canDelete true', () => {
    setup([GROUP.Admin]);
    expect(component.canWrite()).toBeTrue();
    expect(component.canDelete()).toBeTrue();
  });

  it('Tekyon ile sadece read — canWrite/canDelete false', () => {
    setup([GROUP.Tekyon]);
    expect(component.canWrite()).toBeFalse();
    expect(component.canDelete()).toBeFalse();
  });

  it('boş gruplarla bile selected ilk definition olmalı (page-level read all-auth)', () => {
    setup([]);
    expect(component.selected()).toEqual(LOOKUP_DEFINITIONS[0]);
  });

  it('select() ile selected güncellenmeli', () => {
    setup([GROUP.SystemEng]);
    const target = LOOKUP_DEFINITIONS.find((d) => d.type === 'technical_companies')!;
    component.select(target);
    expect(component.selected()).toEqual(target);
  });

  it('grup yapısı 4 kategori içermeli', () => {
    setup([GROUP.SystemEng]);
    expect(component.groups.map((g) => g.key)).toEqual(['transmission', 'technical', 'live-plan', 'fiber']);
    const total = component.groups.reduce((acc, g) => acc + g.items.length, 0);
    expect(total).toBe(LOOKUP_DEFINITIONS.length);
  });
});
