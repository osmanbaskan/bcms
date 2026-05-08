import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { of } from 'rxjs';
import { YayinPlanlamaListComponent } from './yayin-planlama-list.component';
import { YayinPlanlamaService } from '../../core/services/yayin-planlama.service';

describe('YayinPlanlamaListComponent', () => {
  let serviceSpy: jasmine.SpyObj<YayinPlanlamaService>;

  beforeEach(async () => {
    serviceSpy = jasmine.createSpyObj<YayinPlanlamaService>('YayinPlanlamaService', [
      'getList', 'delete',
    ]);
    serviceSpy.getList.and.returnValue(of({
      data: [{ id: 1, title: 'Test', eventKey: 'opta:M-1', team1Name: 'A', team2Name: 'B' } as any],
      total: 1, page: 1, pageSize: 25, totalPages: 1,
    }));

    await TestBed.configureTestingModule({
      imports: [YayinPlanlamaListComponent],
      providers: [
        provideRouter([]),
        provideAnimationsAsync(),
        { provide: YayinPlanlamaService, useValue: serviceSpy },
      ],
    }).compileComponents();
  });

  it('ngOnInit: getList default page=1, pageSize=25 ile çağırır', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    expect(serviceSpy.getList).toHaveBeenCalled();
    const args = serviceSpy.getList.calls.mostRecent().args[0];
    expect(args!.page).toBe(1);
    expect(args!.pageSize).toBe(25);
  });

  it('reload: filter değişince getList yeniden çağrılır', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as { eventKey: string; reload(): void };
    cmp.eventKey = 'opta:M-9';
    cmp.reload();
    const args = serviceSpy.getList.calls.mostRecent().args[0];
    expect(args!.eventKey).toBe('opta:M-9');
  });
});
