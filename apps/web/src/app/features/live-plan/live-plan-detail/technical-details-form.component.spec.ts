import { TestBed, ComponentFixture } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { of } from 'rxjs';

import { TechnicalDetailsFormComponent } from './technical-details-form.component';
import { ApiService } from '../../../core/services/api.service';
import { ALL_FIELDS, FIELD_GROUPS, type TechnicalDetailsRow } from './technical-details.types';

function makeRow(overrides: Partial<TechnicalDetailsRow> = {}): TechnicalDetailsRow {
  // Tüm 73 alan null başlangıçlı; createdAt/updatedAt sabit fixture.
  const base = {
    id: 1,
    livePlanEntryId: 42,
    version: 3,
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    deletedAt: null,
  } as Partial<TechnicalDetailsRow>;

  // Doldurulmamış alanları null'a set et — gerçek backend response shape.
  const nulls: Partial<TechnicalDetailsRow> = {
    broadcastLocationId: null, obVanCompanyId: null, generatorCompanyId: null,
    jimmyJibId: null, steadicamId: null, sngCompanyId: null, carrierCompanyId: null,
    ibmId: null, usageLocationId: null, fixedPhone1: null, secondObVanId: null,
    regionId: null, cameraCount: null, fixedPhone2: null,
    plannedStartTime: null, plannedEndTime: null, hdvgResourceId: null,
    int1ResourceId: null, int2ResourceId: null, offTubeId: null, languageId: null,
    demodId: null, tieId: null, virtualResourceId: null,
    ird1Id: null, ird2Id: null, ird3Id: null, fiber1Id: null, fiber2Id: null,
    feedTypeId: null, satelliteId: null, txp: null, satChannel: null,
    uplinkFrequency: null, uplinkPolarizationId: null, downlinkFrequency: null,
    downlinkPolarizationId: null, modulationTypeId: null, rollOffId: null,
    videoCodingId: null, audioConfigId: null, preMatchKey: null, matchKey: null,
    postMatchKey: null, isoFeedId: null, keyTypeId: null, symbolRate: null,
    fecRateId: null, bandwidth: null, uplinkFixedPhone: null,
    backupFeedTypeId: null, backupSatelliteId: null, backupTxp: null,
    backupSatChannel: null, backupUplinkFrequency: null,
    backupUplinkPolarizationId: null, backupDownlinkFrequency: null,
    backupDownlinkPolarizationId: null, backupModulationTypeId: null,
    backupRollOffId: null, backupVideoCodingId: null, backupAudioConfigId: null,
    backupPreMatchKey: null, backupMatchKey: null, backupPostMatchKey: null,
    backupKeyTypeId: null, backupSymbolRate: null, backupFecRateId: null,
    backupBandwidth: null,
    fiberCompanyId: null, fiberAudioFormatId: null, fiberVideoFormatId: null,
    fiberBandwidth: null,
  };
  return { ...nulls, ...base, ...overrides } as TechnicalDetailsRow;
}

describe('TechnicalDetailsFormComponent', () => {
  let fixture: ComponentFixture<TechnicalDetailsFormComponent>;
  let component: TechnicalDetailsFormComponent;
  let api: jasmine.SpyObj<ApiService>;
  let dialog: jasmine.SpyObj<MatDialog>;
  let confirmResult = true;

  function makeDialogRef(result: unknown): MatDialogRef<unknown> {
    return { afterClosed: () => of(result) } as unknown as MatDialogRef<unknown>;
  }

  beforeEach(() => {
    api = jasmine.createSpyObj('ApiService', ['get', 'post', 'patch', 'delete']);
    // Lookup endpoint'leri (LookupSelectComponent fetch'i) — boş items.
    (api.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path.startsWith('/live-plan/lookups/')) {
        return of({ items: [], total: 0, page: 1, pageSize: 200 });
      }
      // technical-details GET — default null (Oluştur path).
      return of(null);
    });
    api.post.and.returnValue(of(makeRow()));
    api.patch.and.returnValue(of(makeRow({ version: 4 })));
    api.delete.and.returnValue(of({}));

    confirmResult = true;
    dialog = jasmine.createSpyObj('MatDialog', ['open']);
    dialog.open.and.callFake(() => makeDialogRef(confirmResult) as MatDialogRef<unknown, unknown>);

    TestBed.configureTestingModule({
      imports:   [TechnicalDetailsFormComponent, NoopAnimationsModule],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: MatDialog, useValue: dialog },
      ],
    });

    fixture   = TestBed.createComponent(TechnicalDetailsFormComponent);
    component = fixture.componentInstance;
    component.entryId   = 42;
    component.canWrite  = true;
    component.canDelete = true;
    (component as unknown as { dialog: MatDialog }).dialog = dialog;
  });

  afterEach(() => fixture.destroy());

  it('ngOnInit technical-details GET endpoint çağırır', () => {
    fixture.detectChanges();
    expect(api.get).toHaveBeenCalledWith('/live-plan/42/technical-details');
  });

  it('null response → row null, create() POST endpoint çağırır', () => {
    fixture.detectChanges();
    expect(component.row()).toBeNull();
    component.create();
    expect(api.post).toHaveBeenCalledWith('/live-plan/42/technical-details', {});
    expect(component.row()?.version).toBe(3);
  });

  it('row yüklendikten sonra alan değişince dirty=true ve save() PATCH version ile çağrılır', () => {
    (api.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path.startsWith('/live-plan/lookups/')) {
        return of({ items: [], total: 0, page: 1, pageSize: 200 });
      }
      return of(makeRow());
    });
    fixture.detectChanges();
    expect(component.row()?.version).toBe(3);
    expect(component.dirty()).toBeFalse();

    component.onChangeNumber('cameraCount', 4);
    expect(component.dirty()).toBeTrue();

    component.save();
    expect(api.patch).toHaveBeenCalledWith(
      '/live-plan/42/technical-details',
      { cameraCount: 4 },
      3,
    );
    expect(component.row()?.version).toBe(4);
    expect(component.dirty()).toBeFalse();
  });

  it('string alan boş geldiğinde diff body null gönderir (clear)', () => {
    (api.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path.startsWith('/live-plan/lookups/')) {
        return of({ items: [], total: 0, page: 1, pageSize: 200 });
      }
      return of(makeRow({ txp: 'EUTELSAT-7B' }));
    });
    fixture.detectChanges();

    component.onChangeString('txp', '');
    expect(component.dirty()).toBeTrue();

    component.save();
    expect(api.patch).toHaveBeenCalledWith(
      '/live-plan/42/technical-details',
      { txp: null },
      3,
    );
  });

  it('confirmDelete confirm sonrası DELETE version ile çağrılır', () => {
    (api.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path.startsWith('/live-plan/lookups/')) {
        return of({ items: [], total: 0, page: 1, pageSize: 200 });
      }
      return of(makeRow());
    });
    fixture.detectChanges();

    confirmResult = true;
    component.confirmDelete();
    expect(dialog.open).toHaveBeenCalledTimes(1);
    expect(api.delete).toHaveBeenCalledWith('/live-plan/42/technical-details', 3);
    expect(component.row()).toBeNull();
  });

  it('confirmDelete iptal edilirse DELETE çağrılmaz', () => {
    (api.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path.startsWith('/live-plan/lookups/')) {
        return of({ items: [], total: 0, page: 1, pageSize: 200 });
      }
      return of(makeRow());
    });
    fixture.detectChanges();

    confirmResult = false;
    component.confirmDelete();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('resetToOriginal dirty alanları geri alır', () => {
    (api.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path.startsWith('/live-plan/lookups/')) {
        return of({ items: [], total: 0, page: 1, pageSize: 200 });
      }
      return of(makeRow({ txp: 'orig' }));
    });
    fixture.detectChanges();

    component.onChangeString('txp', 'changed');
    expect(component.dirty()).toBeTrue();

    component.resetToOriginal();
    expect(component.dirty()).toBeFalse();
    expect(component.stringValue('txp')).toBe('orig');
  });

  // ── 2026-05-13: Faz 1+2 (wrapper dialog auto-close) ────────────────────
  it('save() success → saved EventEmitter fire eder', () => {
    (api.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path.startsWith('/live-plan/lookups/')) {
        return of({ items: [], total: 0, page: 1, pageSize: 200 });
      }
      return of(makeRow());
    });
    fixture.detectChanges();

    const savedSpy = jasmine.createSpy('saved');
    component.saved.subscribe(savedSpy);

    component.onChangeNumber('cameraCount', 9);
    component.save();
    expect(savedSpy).toHaveBeenCalledTimes(1);
  });

  it('create() success → saved EventEmitter fire eder', () => {
    fixture.detectChanges();
    const savedSpy = jasmine.createSpy('saved');
    component.saved.subscribe(savedSpy);

    component.create();
    expect(savedSpy).toHaveBeenCalledTimes(1);
  });

  it('confirmDelete confirm success → saved EventEmitter fire eder', () => {
    (api.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path.startsWith('/live-plan/lookups/')) {
        return of({ items: [], total: 0, page: 1, pageSize: 200 });
      }
      return of(makeRow());
    });
    fixture.detectChanges();
    const savedSpy = jasmine.createSpy('saved');
    component.saved.subscribe(savedSpy);

    confirmResult = true;
    component.confirmDelete();
    expect(savedSpy).toHaveBeenCalledTimes(1);
  });

  it('confirmDelete cancel → saved fire ETMEZ', () => {
    (api.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path.startsWith('/live-plan/lookups/')) {
        return of({ items: [], total: 0, page: 1, pageSize: 200 });
      }
      return of(makeRow());
    });
    fixture.detectChanges();
    const savedSpy = jasmine.createSpy('saved');
    component.saved.subscribe(savedSpy);

    confirmResult = false;
    component.confirmDelete();
    expect(savedSpy).not.toHaveBeenCalled();
  });
});

/**
 * 2026-05-13: FIELD_GROUPS / ALL_FIELDS scope sözleşmesi. Düzenle dialog'una
 * taşınan 18 alan Teknik form render scope'undan çıkarıldı. Bu test'ler
 * silinen keylerin geri sızmasını engeller (regression guard).
 */
describe('TechnicalDetailsFormComponent — Düzenle\'ye taşınan 18 alan FIELD_GROUPS dışı', () => {
  const REMOVED_KEYS = [
    'plannedStartTime', 'plannedEndTime',
    'hdvgResourceId', 'int1ResourceId', 'int2ResourceId',
    'offTubeId', 'languageId', 'secondLanguageId',
    'demodId', 'tieId', 'virtualResourceId',
    'ird1Id', 'ird2Id', 'ird3Id', 'fiber1Id', 'fiber2Id',
    'modulationTypeId', 'videoCodingId',
  ] as const;

  it('FIELD_GROUPS hiçbiri 18 kaldırılan keyi içermez', () => {
    const allKeysInGroups = FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.key as string));
    for (const k of REMOVED_KEYS) {
      expect(allKeysInGroups).not.toContain(k);
    }
  });

  it('ALL_FIELDS hiçbiri 18 kaldırılan keyi içermez', () => {
    const allKeys = ALL_FIELDS.map((f) => f.key as string);
    for (const k of REMOVED_KEYS) {
      expect(allKeys).not.toContain(k);
    }
  });

  it('§5.2 "Ortak" ve §5.3 "IRD / Fiber" grupları FIELD_GROUPS\'ta yok', () => {
    const ids = FIELD_GROUPS.map((g) => g.id);
    expect(ids).not.toContain('ortak');
    expect(ids).not.toContain('ird-fiber');
  });

  it('Korunan §5.1/§5.4/§5.5/§5.6 grup id\'leri mevcut', () => {
    const ids = FIELD_GROUPS.map((g) => g.id);
    expect(ids).toContain('yayin-ob');
    expect(ids).toContain('ana-feed');
    expect(ids).toContain('yedek-feed');
    expect(ids).toContain('fiber-format');
  });
});
