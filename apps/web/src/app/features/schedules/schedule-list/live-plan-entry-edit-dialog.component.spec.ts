import { TestBed, ComponentFixture } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';

import { LivePlanEntryEditDialogComponent } from './live-plan-entry-edit-dialog.component';
import { ApiService } from '../../../core/services/api.service';
import type { LivePlanEntry } from '../../live-plan/live-plan.types';
import type { TechnicalDetailsRow } from '../../live-plan/live-plan-detail/technical-details.types';

const ENTRY_FIXTURE: LivePlanEntry = {
  id:              42,
  title:           'Fenerbahçe - Beşiktaş',
  eventStartTime:  '2026-06-01T17:00:00.000Z', // Türkiye 20:00
  eventEndTime:    '2026-06-01T19:00:00.000Z', // Türkiye 22:00
  matchId:         null,
  optaMatchId:     null,
  status:          'PLANNED',
  operationNotes:  null,
  createdBy:       null,
  version:         3,
  createdAt:       '2026-05-01T00:00:00.000Z',
  updatedAt:       '2026-05-01T00:00:00.000Z',
  deletedAt:       null,
  eventKey:        'manual:abc',
  sourceType:      'MANUAL',
  channel1Id:      11,
  channel2Id:      null,
  channel3Id:      null,
  team1Name:       null,
  team2Name:       null,
  leagueName:      'Türkiye Basketbol Ligi',
};

function emptyTechRow(version = 1): TechnicalDetailsRow {
  return {
    id: 7, livePlanEntryId: 42, version,
    createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z', deletedAt: null,
    broadcastLocationId: null, obVanCompanyId: null, generatorCompanyId: null,
    jimmyJibId: null, steadicamId: null, sngCompanyId: null, carrierCompanyId: null,
    ibmId: null, usageLocationId: null, fixedPhone1: null, secondObVanId: null,
    regionId: null, cameraCount: null, fixedPhone2: null,
    plannedStartTime: null, plannedEndTime: null, hdvgResourceId: null,
    int1ResourceId: null, int2ResourceId: null, offTubeId: null, languageId: null,
    secondLanguageId: null,
    demodId: null, tieId: null, virtualResourceId: null,
    ird1Id: null, ird2Id: null, ird3Id: null, fiber1Id: null, fiber2Id: null,
    feedTypeId: null, satelliteId: null, txp: null, satChannel: null,
    uplinkFrequency: null, uplinkPolarizationId: null, downlinkFrequency: null,
    downlinkPolarizationId: null, modulationTypeId: null, rollOffId: null,
    videoCodingId: null, audioConfigId: null, preMatchKey: null, matchKey: null,
    postMatchKey: null, isoFeedId: null, keyTypeId: null, symbolRate: null,
    fecRateId: null, bandwidth: null, uplinkFixedPhone: null,
    backupFeedTypeId: null, backupSatelliteId: null, backupTxp: null,
    backupSatChannel: null, backupUplinkFrequency: null, backupUplinkPolarizationId: null,
    backupDownlinkFrequency: null, backupDownlinkPolarizationId: null,
    backupModulationTypeId: null, backupRollOffId: null, backupVideoCodingId: null,
    backupAudioConfigId: null, backupPreMatchKey: null, backupMatchKey: null,
    backupPostMatchKey: null, backupKeyTypeId: null, backupSymbolRate: null,
    backupFecRateId: null, backupBandwidth: null,
    fiberCompanyId: null, fiberAudioFormatId: null, fiberVideoFormatId: null,
    fiberBandwidth: null,
  };
}

describe('LivePlanEntryEditDialogComponent', () => {
  let fixture: ComponentFixture<LivePlanEntryEditDialogComponent>;
  let component: LivePlanEntryEditDialogComponent;
  let api: jasmine.SpyObj<ApiService>;
  let dialogRef: jasmine.SpyObj<MatDialogRef<LivePlanEntryEditDialogComponent>>;

  function configureGetSuccess(entry: LivePlanEntry, tech: TechnicalDetailsRow | null): void {
    (api.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path === `/live-plan/${entry.id}`)                       return of(entry);
      if (path === `/live-plan/${entry.id}/technical-details`)     return of(tech);
      if (path === '/channels/catalog')                            return of([{ id: 11, name: 'beINSports2' }]);
      return of(null);
    });
  }

  beforeEach(() => {
    api = jasmine.createSpyObj('ApiService', ['get', 'patch', 'post']);
    api.patch.and.returnValue(of(ENTRY_FIXTURE));
    api.post.and.returnValue(of(emptyTechRow(1)));

    dialogRef = jasmine.createSpyObj('MatDialogRef', ['close']);

    TestBed.configureTestingModule({
      imports:   [LivePlanEntryEditDialogComponent, NoopAnimationsModule],
      providers: [
        { provide: ApiService,      useValue: api },
        { provide: MatDialogRef,    useValue: dialogRef },
        { provide: MAT_DIALOG_DATA, useValue: { schedule: { id: 42, version: 3 } } },
      ],
    });

    fixture   = TestBed.createComponent(LivePlanEntryEditDialogComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => fixture.destroy());

  it('load: 3 GET (entry + technical-details + channels) çağrılır, form doldurulur', () => {
    configureGetSuccess(ENTRY_FIXTURE, null);
    fixture.detectChanges(); // triggers constructor->load
    expect(api.get).toHaveBeenCalledWith('/live-plan/42');
    expect(api.get).toHaveBeenCalledWith('/live-plan/42/technical-details');
    expect(api.get).toHaveBeenCalledWith('/channels/catalog');
    expect(component.form.title).toBe('Fenerbahçe - Beşiktaş');
    expect(component.form.leagueName).toBe('Türkiye Basketbol Ligi');
    expect(component.form.channel1Id).toBe(11);
    expect(component.form.startTime).toBe('20:00');
    expect(component.form.endTime).toBe('22:00');
  });

  it('dirty entry alanı → tek PATCH /live-plan/:id ile If-Match version', () => {
    configureGetSuccess(ENTRY_FIXTURE, emptyTechRow(1));
    fixture.detectChanges();

    component.form.title = 'Fenerbahçe Beko - Beşiktaş GAİN';
    component.save();

    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith(
      '/live-plan/42',
      { title: 'Fenerbahçe Beko - Beşiktaş GAİN' },
      3,
    );
    expect(dialogRef.close).toHaveBeenCalled();
  });

  it('channel ve technical dirty: iki ayrı PATCH sırayla (entry → tech) atılır', () => {
    configureGetSuccess(ENTRY_FIXTURE, emptyTechRow(1));
    fixture.detectChanges();

    component.form.channel2Id = 22;
    component.onTech('modulationTypeId', 5);

    component.save();

    expect(api.patch).toHaveBeenCalledTimes(2);
    expect(api.patch.calls.argsFor(0)).toEqual([
      '/live-plan/42', { channel2Id: 22 }, 3,
    ]);
    expect(api.patch.calls.argsFor(1)).toEqual([
      '/live-plan/42/technical-details', { modulationTypeId: 5 }, 1,
    ]);
  });

  it('technical detay null ise → POST {} + PATCH sırayla', () => {
    configureGetSuccess(ENTRY_FIXTURE, null);
    fixture.detectChanges();

    component.onTech('languageId', 9);
    component.save();

    expect(api.post).toHaveBeenCalledWith('/live-plan/42/technical-details', {});
    expect(api.patch).toHaveBeenCalledWith(
      '/live-plan/42/technical-details',
      { languageId: 9 },
      1,
    );
  });

  it('E1 412 → form reload, E2 atılmaz', () => {
    configureGetSuccess(ENTRY_FIXTURE, emptyTechRow(1));
    fixture.detectChanges();
    api.get.calls.reset();
    api.patch.and.returnValue(throwError(() => new HttpErrorResponse({ status: 412 })));

    component.form.title = 'değişti';
    component.onTech('languageId', 5);
    component.save();

    // E1 fail → tech step çağrılmamalı
    expect(api.patch).toHaveBeenCalledTimes(1);
    // Reload tetiklenmiş
    expect(api.get).toHaveBeenCalledWith('/live-plan/42');
  });

  it('Lig payload’a girmez (read-only)', () => {
    configureGetSuccess(ENTRY_FIXTURE, emptyTechRow(1));
    fixture.detectChanges();

    component.form.title = 'yeni başlık';
    component.save();

    const body = api.patch.calls.mostRecent().args[1] as Record<string, unknown>;
    expect('leagueName' in body).toBeFalse();
  });
});
