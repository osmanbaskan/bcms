import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { of } from 'rxjs';
import { IngestListComponent } from './ingest-list.component';
import { ApiService } from '../../../core/services/api.service';

describe('IngestListComponent', () => {
  let component: IngestListComponent;
  let fixture: import('@angular/core/testing').ComponentFixture<IngestListComponent>;
  let apiSpy: jasmine.SpyObj<ApiService>;

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj('ApiService', ['get', 'post', 'patch']);
    apiSpy.get.and.returnValue(of({ data: [], total: 0 }));

    TestBed.configureTestingModule({
      imports: [IngestListComponent],
      providers: [
        { provide: ApiService, useValue: apiSpy },
      ],
    }).overrideComponent(IngestListComponent, {
      set: { template: '' },
    });

    fixture = TestBed.createComponent(IngestListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('oluşturulmalı', () => {
    expect(component).toBeTruthy();
  });

  it('startBurstPoll timer tabanlı subscription oluşturmalı ve take(6) ile sonlanmalı', fakeAsync(() => {
    component.onWorkspaceTabChange(1);

    const sub = (component as any).portBoardPollSub;
    expect(sub).toBeTruthy();
    expect(sub.closed).toBeFalse();

    // 5. tur sonunda hâlâ açık (0, 10, 20, 30, 40 saniye = 5 emit)
    tick(40_000);
    expect(sub.closed).toBeFalse();

    // 6. tur sonunda take(6) complete eder
    tick(10_000);
    expect(sub.closed).toBeTrue();

    fixture.destroy();
  }));
});
