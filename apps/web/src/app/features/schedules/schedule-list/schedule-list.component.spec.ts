import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { MatDialog, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarRef, TextOnlySnackBar } from '@angular/material/snack-bar';
import { KeycloakService } from 'keycloak-angular';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { environment } from '../../../../environments/environment';
import {
  ScheduleListComponent,
  ReportIssueDialogComponent,
} from './schedule-list.component';
import { LivePlanEntryAddDialogComponent } from './live-plan-entry-add-dialog.component';
import { LivePlanEntryEditDialogComponent } from './live-plan-entry-edit-dialog.component';
import { ScheduleService } from '../../../core/services/schedule.service';
import { ApiService } from '../../../core/services/api.service';
import type { Schedule } from '@bcms/shared';

// Mutation restore (2026-05-10): Canlı Yayın Plan UI mutation aksiyonları
// (Yeni / Düzenle / Teknik / Çoğalt / Sil) eski konumlarına canonical
// command path ile geri konuldu. Spec, butonların permission'a göre görünür
// olduğunu, dialog'ların doğru component'le açıldığını ve service çağrılarının
// canonical /api/v1/live-plan* path'ine bağlı olduğunu doğrular.

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id:           42,
    matchId:      null,
    startTime:    '2026-05-09T19:00:00Z',
    endTime:      '2026-05-09T21:00:00Z',
    title:        'GS - FB',
    status:       'CONFIRMED',
    createdBy:    'u1',
    version:      3,
    metadata:     {},
    createdAt:    '2026-05-09T10:00:00Z',
    updatedAt:    '2026-05-09T10:00:00Z',
    optaMatchId:  null,
    eventKey:     'manual:abc',
    team1Name:    'GS',
    team2Name:    'FB',
    channel1Id:   null,
    channel2Id:   null,
    channel3Id:   null,
    channel:      null,
    ...overrides,
  };
}

interface KeycloakStub {
  getKeycloakInstance: () => { tokenParsed: { groups: string[] } | undefined };
}

function makeKeycloakStub(groups: string[]): KeycloakStub {
  return {
    getKeycloakInstance: () => ({ tokenParsed: { groups } }),
  };
}

interface SetupOpts {
  groups?: string[];
  schedules?: Schedule[];
}

function setup(opts: SetupOpts = {}) {
  const groups = opts.groups ?? ['Admin'];
  const schedules = opts.schedules ?? [makeSchedule()];

  const scheduleSvcSpy = jasmine.createSpyObj<ScheduleService>('ScheduleService', [
    'getSchedules',
    'createLivePlanEntry',
    'createLivePlanFromOpta',
    'updateLivePlanEntry',
    'duplicateLivePlanEntry',
    'deleteLivePlanEntry',
  ]);
  scheduleSvcSpy.getSchedules.and.returnValue(of({
    data: schedules, total: schedules.length, page: 1, pageSize: 100, totalPages: 1,
  }));
  scheduleSvcSpy.duplicateLivePlanEntry.and.returnValue(of(makeSchedule({ id: 99 })));
  scheduleSvcSpy.deleteLivePlanEntry.and.returnValue(of(undefined));

  const apiSpy = jasmine.createSpyObj<ApiService>('ApiService', [
    'get', 'post', 'patch', 'delete',
  ]);
  apiSpy.get.and.returnValue(of([]));

  const dialogRefSpy = jasmine.createSpyObj<MatDialogRef<unknown>>('MatDialogRef', ['close', 'afterClosed']);
  dialogRefSpy.afterClosed.and.returnValue(of(undefined));

  const snackRefSpy = jasmine.createSpyObj<MatSnackBarRef<TextOnlySnackBar>>('MatSnackBarRef', ['onAction']);
  const onActionSubject = new Subject<void>();
  snackRefSpy.onAction.and.returnValue(onActionSubject.asObservable());

  TestBed.configureTestingModule({
    imports:   [ScheduleListComponent, NoopAnimationsModule],
    providers: [
      provideRouter([]),
      { provide: ScheduleService, useValue: scheduleSvcSpy },
      { provide: ApiService,      useValue: apiSpy },
      { provide: KeycloakService, useValue: makeKeycloakStub(groups) },
    ],
  });

  const fixture = TestBed.createComponent(ScheduleListComponent);
  const router = TestBed.inject(Router);
  spyOn(router, 'navigate').and.resolveTo(true);

  // MatDialog ve MatSnackBar standalone component'in kendi imports
  // hiyerarşisinden inject edilir; provider override (`useValue`) ya da
  // root TestBed.inject(MatDialog) bu instance'ı yakalamaz. Spy'ı
  // component'in fiili inject ettiği instance'a uygulamak gerekir.
  // ngOnInit dialog/snack kullanmadığı için spy detectChanges ÖNCESİ
  // veya SONRASI eklenebilir; sıra önemli değil.
  const componentDialog = (fixture.componentInstance as unknown as { dialog: MatDialog }).dialog;
  const componentSnack  = (fixture.componentInstance as unknown as { snack: MatSnackBar }).snack;
  const dialogSpy = spyOn(componentDialog, 'open').and.returnValue(dialogRefSpy as MatDialogRef<unknown>);
  const snackSpy  = spyOn(componentSnack, 'open').and.returnValue(snackRefSpy as MatSnackBarRef<TextOnlySnackBar>);

  // ngOnInit'te `setInterval` (clockTimer) pending kalır → `whenStable()`
  // resolve olmaz. detectChanges() observable'ları (of([])) senkron çözer;
  // template render yeterli. ngOnDestroy (afterEach destroy) clearInterval
  // ile timer'ı temizler.
  fixture.detectChanges();

  return {
    fixture,
    component: fixture.componentInstance,
    scheduleSvcSpy,
    apiSpy,
    dialogSpy,
    snackSpy,
    snackRefSpy,
    onActionSubject,
    router,
    schedules,
  };
}

describe('ScheduleListComponent — mutation restore (2026-05-10)', () => {
  // environment.skipAuth = true (development backdoor) Karma ortamında
  // localhost'ta `isSkipAuthAllowed()` true döner; component ngOnInit
  // SystemEng grubunu set eder ve test'in sağladığı groups bypass'lanır.
  // Bu test'lerde keycloak-driven path'i izlemek için skipAuth'u kapatıyoruz.
  let originalSkipAuth: boolean;
  beforeAll(() => {
    originalSkipAuth = (environment as { skipAuth: boolean }).skipAuth;
    (environment as { skipAuth: boolean }).skipAuth = false;
  });
  afterAll(() => {
    (environment as { skipAuth: boolean }).skipAuth = originalSkipAuth;
  });

  describe('permission açık (Admin auto-bypass)', () => {
    let ctx: ReturnType<typeof setup>;

    beforeEach(() => {
      ctx = setup({ groups: ['Admin'] });
    });

    afterEach(() => ctx.fixture.destroy());

    it('canAdd/canEdit/canTechnicalEdit/canDuplicate/canDelete/canReportIssue computed true', () => {
      expect(ctx.component.canAdd()).toBeTrue();
      expect(ctx.component.canEdit()).toBeTrue();
      expect(ctx.component.canTechnicalEdit()).toBeTrue();
      expect(ctx.component.canDuplicate()).toBeTrue();
      expect(ctx.component.canDelete()).toBeTrue();
      expect(ctx.component.canReportIssue()).toBeTrue();
    });

    it('"Yeni Ekle" butonu üst bar\'da görünür', () => {
      const html = ctx.fixture.nativeElement as HTMLElement;
      const buttons = Array.from(html.querySelectorAll('.top-actions button')).map((b) => b.textContent?.trim() ?? '');
      expect(buttons.some((t) => /Yeni Ekle/.test(t))).toBeTrue();
    });

    it('row aksiyonları (Düzenle / Teknik / Çoğalt / Sorun Bildir / Sil) görünür', () => {
      const html = ctx.fixture.nativeElement as HTMLElement;
      const tooltips = Array.from(html.querySelectorAll('.td-actions button[matTooltip]'))
        .map((b) => b.getAttribute('matTooltip') ?? '');

      expect(tooltips).toContain('Düzenle');
      expect(tooltips).toContain('Teknik Detayları Düzenle');
      expect(tooltips).toContain('Materyali çoğalt');
      expect(tooltips).toContain('Sorun Bildir');
      expect(tooltips).toContain('Sil');
    });
  });

  describe('permission kapalı (boş groups; Admin değil)', () => {
    let ctx: ReturnType<typeof setup>;

    beforeEach(() => {
      // PERMISSIONS.livePlan.write = ['Tekyon','Transmisyon','Booking','YayınPlanlama']
      // PERMISSIONS.livePlan.delete aynı set. PERMISSIONS.incidents.reportIssue
      // ayrı set. Boş groups → hiçbir grup eşleşmez (Admin auto-bypass yok).
      ctx = setup({ groups: [] });
    });

    afterEach(() => ctx.fixture.destroy());

    it('canAdd/canEdit/canTechnicalEdit/canDuplicate/canDelete computed false', () => {
      expect(ctx.component.canAdd()).toBeFalse();
      expect(ctx.component.canEdit()).toBeFalse();
      expect(ctx.component.canTechnicalEdit()).toBeFalse();
      expect(ctx.component.canDuplicate()).toBeFalse();
      expect(ctx.component.canDelete()).toBeFalse();
    });

    it('mutation butonları (Yeni / Düzenle / Teknik / Çoğalt / Sil) görünmez', () => {
      const html = ctx.fixture.nativeElement as HTMLElement;
      const allButtonText = Array.from(html.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '');
      expect(allButtonText.some((t) => /Yeni Ekle/.test(t))).toBeFalse();

      const tooltips = Array.from(html.querySelectorAll('.td-actions button[matTooltip]'))
        .map((b) => b.getAttribute('matTooltip') ?? '');
      expect(tooltips).not.toContain('Düzenle');
      expect(tooltips).not.toContain('Teknik Detayları Düzenle');
      expect(tooltips).not.toContain('Materyali çoğalt');
      expect(tooltips).not.toContain('Sil');
    });
  });

  describe('action method dispatch (canonical command path)', () => {
    let ctx: ReturnType<typeof setup>;

    beforeEach(() => {
      ctx = setup({ groups: ['Admin'] });
    });

    afterEach(() => ctx.fixture.destroy());

    it('openAddDialog → MatDialog.open(LivePlanEntryAddDialogComponent)', () => {
      ctx.component.openAddDialog();
      expect(ctx.dialogSpy).toHaveBeenCalled();
      const [component] = ctx.dialogSpy.calls.mostRecent().args;
      expect(component).toBe(LivePlanEntryAddDialogComponent);
    });

    it('openEditDialog → MatDialog.open(LivePlanEntryEditDialogComponent) + schedule data', () => {
      const s = makeSchedule({ id: 7, version: 4 });
      ctx.component.openEditDialog(s);
      expect(ctx.dialogSpy).toHaveBeenCalled();
      const [component, config] = ctx.dialogSpy.calls.mostRecent().args;
      expect(component).toBe(LivePlanEntryEditDialogComponent);
      expect((config as { data: { schedule: Schedule } }).data.schedule).toEqual(s);
    });

    it('openTechnicalDialog → router.navigate(["/live-plan", id])', () => {
      const s = makeSchedule({ id: 11 });
      ctx.component.openTechnicalDialog(s);
      expect(ctx.router.navigate).toHaveBeenCalledWith(['/live-plan', 11]);
    });

    it('duplicateSchedule snack action → scheduleSvc.duplicateLivePlanEntry(s.id) (legacy /schedules YOK)', fakeAsync(() => {
      const s = makeSchedule({ id: 21 });
      ctx.component.duplicateSchedule(s);
      // Snack açıldı ve kullanıcı Çoğalt aksiyonunu tetikledi
      ctx.onActionSubject.next();
      tick();

      expect(ctx.scheduleSvcSpy.duplicateLivePlanEntry).toHaveBeenCalledWith(21);
      // Legacy path negative kanıt: ApiService doğrudan /schedules POST/DELETE
      // çağrısı YAPILMADI (mutation hep ScheduleService canonical metodları
      // üzerinden gidiyor).
      expect(ctx.apiSpy.post).not.toHaveBeenCalledWith('/schedules', jasmine.anything());
      expect(ctx.apiSpy.delete).not.toHaveBeenCalledWith(jasmine.stringMatching(/^\/schedules\//), jasmine.anything());
    }));

    it('deleteSchedule snack action → scheduleSvc.deleteLivePlanEntry(s.id, s.version) (legacy /schedules YOK)', fakeAsync(() => {
      const s = makeSchedule({ id: 33, version: 7 });
      ctx.component.deleteSchedule(s);
      ctx.onActionSubject.next();
      tick();

      expect(ctx.scheduleSvcSpy.deleteLivePlanEntry).toHaveBeenCalledWith(33, 7);
      expect(ctx.apiSpy.delete).not.toHaveBeenCalledWith(jasmine.stringMatching(/^\/schedules\//), jasmine.anything());
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ReportIssueDialog — mevcut spec'in korunan halı.
// ─────────────────────────────────────────────────────────────────────────────
describe('ReportIssueDialogComponent', () => {
  let component: ReportIssueDialogComponent;
  let fixture: import('@angular/core/testing').ComponentFixture<ReportIssueDialogComponent>;
  let apiSpy: jasmine.SpyObj<ApiService>;
  let dialogRefSpy: { close: jasmine.Spy };

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj('ApiService', ['post']);
    dialogRefSpy = { close: jasmine.createSpy('close') };

    TestBed.configureTestingModule({
      imports: [ReportIssueDialogComponent],
      providers: [
        { provide: ApiService, useValue: apiSpy },
        { provide: MAT_DIALOG_DATA, useValue: {
          schedule: {
            id: 1,
            title: 'Test Program',
            startTime: '2024-01-01T10:00:00Z',
            endTime: '2024-01-01T12:00:00Z',
            channel: { name: 'Kanal 1' },
          },
        }},
        { provide: MatDialogRef, useValue: dialogRefSpy },
      ],
    }).overrideComponent(ReportIssueDialogComponent, {
      set: { template: '' },
    });

    fixture = TestBed.createComponent(ReportIssueDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('oluşturulmalı', () => {
    expect(component).toBeTruthy();
  });

  it('save başarılıysa dialog kapanmalı', fakeAsync(() => {
    apiSpy.post.and.returnValue(new Subject().asObservable());
    component.description = 'Bir sorun var';
    component.save();
    tick(1);
    expect(apiSpy.post).toHaveBeenCalled();
  }));

  it('save hata verirse errorMsg set edilmeli', fakeAsync(() => {
    const sub = new Subject<void>();
    apiSpy.post.and.returnValue(sub.asObservable());

    component.description = 'Bir sorun var';
    component.save();
    tick(1);
    expect(component.saving()).toBeTrue();

    sub.error({ error: { message: 'Sunucu hatası' } });
    tick(1);

    expect(component.saving()).toBeFalse();
    expect(component.errorMsg()).toBe('Sunucu hatası');
    expect(dialogRefSpy.close).not.toHaveBeenCalled();
  }));
});
