import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { of } from 'rxjs';
import { YayinPlanlamaFormComponent } from './yayin-planlama-form.component';
import { YayinPlanlamaService } from '../../core/services/yayin-planlama.service';
import { ApiService } from '../../core/services/api.service';

describe('YayinPlanlamaFormComponent', () => {
  let serviceSpy: jasmine.SpyObj<YayinPlanlamaService>;
  let apiSpy: jasmine.SpyObj<ApiService>;

  function setup(routeId?: string) {
    serviceSpy = jasmine.createSpyObj<YayinPlanlamaService>('YayinPlanlamaService', [
      'getList', 'getById', 'create', 'update', 'delete', 'getLookupOptions',
    ]);
    serviceSpy.getLookupOptions.and.returnValue(of([]));
    apiSpy = jasmine.createSpyObj<ApiService>('ApiService', ['get', 'invalidateCache']);
    apiSpy.get.and.returnValue(of([] as never));

    return TestBed.configureTestingModule({
      imports: [YayinPlanlamaFormComponent],
      providers: [
        provideRouter([]),
        provideAnimationsAsync(),
        { provide: YayinPlanlamaService, useValue: serviceSpy },
        { provide: ApiService, useValue: apiSpy },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => routeId ?? null } } } },
      ],
    }).compileComponents();
  }

  it('create mode: scheduleId null → form pristine', async () => {
    await setup();
    const fixture = TestBed.createComponent(YayinPlanlamaFormComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as { isEdit(): boolean };
    expect(cmp.isEdit()).toBe(false);
  });

  it('create: 3 lookup endpoint çağrılır (whitelist üzerinden, magic string yok)', async () => {
    await setup();
    const fixture = TestBed.createComponent(YayinPlanlamaFormComponent);
    fixture.detectChanges();
    expect(serviceSpy.getLookupOptions).toHaveBeenCalledTimes(3);
    expect(serviceSpy.getLookupOptions).toHaveBeenCalledWith('commercial_options');
    expect(serviceSpy.getLookupOptions).toHaveBeenCalledWith('logo_options');
    expect(serviceSpy.getLookupOptions).toHaveBeenCalledWith('format_options');
  });

  it('edit mode: getById çağrılır', async () => {
    await setup('42');
    serviceSpy.getById.and.returnValue(of({
      id: 42, title: 'X', version: 3, scheduleDate: '2026-06-01T00:00:00Z',
      scheduleTime: '1970-01-01T19:00:00Z', startTime: '2026-06-01T19:00:00Z',
      endTime: '2026-06-01T21:00:00Z', createdAt: '', updatedAt: '',
      eventKey: 'opta:M-42', selectedLivePlanEntryId: 7,
    } as any));
    const fixture = TestBed.createComponent(YayinPlanlamaFormComponent);
    fixture.detectChanges();
    expect(serviceSpy.getById).toHaveBeenCalledWith(42);
  });

  it('channelDuplicateError: aynı kanal 2x → true', async () => {
    await setup();
    const fixture = TestBed.createComponent(YayinPlanlamaFormComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as {
      channels: { channel1Id: number | null; channel2Id: number | null; channel3Id: number | null };
      channelDuplicateError(): boolean;
    };
    cmp.channels.channel1Id = 5;
    cmp.channels.channel2Id = 5;
    expect(cmp.channelDuplicateError()).toBe(true);

    cmp.channels.channel2Id = 6;
    expect(cmp.channelDuplicateError()).toBe(false);
  });

  it('canSubmit: zorunlu alanlar (entry + date + time) eksikken false', async () => {
    await setup();
    const fixture = TestBed.createComponent(YayinPlanlamaFormComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as { canSubmit(): boolean };
    expect(cmp.canSubmit()).toBe(false);
  });
});
