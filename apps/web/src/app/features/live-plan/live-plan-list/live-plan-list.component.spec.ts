import { TestBed, ComponentFixture } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { KeycloakService } from 'keycloak-angular';
import { of } from 'rxjs';

import { LivePlanListComponent } from './live-plan-list.component';
import { ApiService } from '../../../core/services/api.service';
import { GROUP } from '@bcms/shared';
import type { LivePlanEntry } from '../live-plan.types';

const ENTRY_FIXTURE: LivePlanEntry = {
  id:             42,
  title:          'Smoke Entry',
  eventStartTime: '2026-06-01T19:00:00.000Z',
  eventEndTime:   '2026-06-01T21:00:00.000Z',
  matchId:        null,
  optaMatchId:    null,
  status:         'PLANNED',
  operationNotes: null,
  createdBy:      'tester',
  version:        1,
  createdAt:      '2026-06-01T18:00:00.000Z',
  updatedAt:      '2026-06-01T18:00:00.000Z',
  deletedAt:      null,
};

function makeKc(groups: string[]): jasmine.SpyObj<KeycloakService> {
  const kc = jasmine.createSpyObj('KeycloakService', ['getKeycloakInstance']);
  kc.getKeycloakInstance.and.returnValue({ tokenParsed: { groups } } as any);
  return kc;
}

describe('LivePlanListComponent', () => {
  let fixture: ComponentFixture<LivePlanListComponent>;
  let component: LivePlanListComponent;

  function setup(groups: string[]) {
    TestBed.resetTestingModule();
    const apiSpy = jasmine.createSpyObj('ApiService', ['get', 'post', 'patch', 'delete']);
    apiSpy.get.and.returnValue(of({ items: [ENTRY_FIXTURE], total: 1, page: 1, pageSize: 200 }));

    TestBed.configureTestingModule({
      imports:   [LivePlanListComponent, NoopAnimationsModule],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiSpy },
        { provide: KeycloakService, useValue: makeKc(groups) },
      ],
    });
    fixture   = TestBed.createComponent(LivePlanListComponent);
    component = fixture.componentInstance;
    // ngOnInit env.skipAuth=true test ortamında SystemEng'i setler; bunu bypass
    // edip groups'u doğrudan yaz, sonra load()'ı manuel çağır.
    component.userGroups.set(groups);
    component.load();
  }

  afterEach(() => fixture?.destroy());

  it('Booking ile canWrite true (Tekyon/Transmisyon/Booking/YayınPlanlama set)', () => {
    setup([GROUP.Booking]);
    expect(component.canWrite()).toBeTrue();
  });

  it('Admin ile canWrite true (auto-bypass)', () => {
    setup([GROUP.Admin]);
    expect(component.canWrite()).toBeTrue();
  });

  it('Ingest ile canWrite false (livePlan.write set\'inde değil)', () => {
    setup([GROUP.Ingest]);
    expect(component.canWrite()).toBeFalse();
  });

  it('list endpoint pageSize 200 ile çağrılır', () => {
    setup([GROUP.Booking]);
    expect(component.rows().length).toBe(1);
    expect(component.rows()[0].title).toBe('Smoke Entry');
  });

  it('formatRange UTC pencereyi YYYY-MM-DD HH:MM–HH:MM döndürür', () => {
    setup([]);
    expect(component.formatRange('2026-06-01T19:00:00Z', '2026-06-01T21:00:00Z'))
      .toBe('2026-06-01 19:00–21:00');
  });
});
