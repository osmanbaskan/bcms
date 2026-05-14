import { TestBed, ComponentFixture } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { MatDialogRef } from '@angular/material/dialog';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';

import { LivePlanEntryAddDialogComponent } from './live-plan-entry-add-dialog.component';
import {
  ScheduleService,
  type BroadcastType,
  type FixtureCompetition,
  type OptaFixtureRow,
  type ManualLeague,
  type ManualTeam,
} from '../../../core/services/schedule.service';

const BT_FIXTURE: BroadcastType[] = [
  { id: 1, code: 'MATCH',  description: 'Müsabaka' },
  { id: 2, code: 'STUDIO', description: 'Stüdyo' },
];

const COMP_FIXTURE: FixtureCompetition[] = [
  { id: '115', name: 'Süper Lig',           season: '2025-2026' },
  { id: 'tbl', name: 'Türkiye Basketbol Ligi', season: '2025-2026' },
];

const MANUAL_LEAGUES_FIXTURE: ManualLeague[] = [
  { id: 60, code: 'custom-tbl', name: 'Türkiye Basketbol Ligi', country: 'Türkiye', sportGroup: 'basketball', teamCount: 16 },
];

const TBL_TEAMS_FIXTURE: ManualTeam[] = [
  { id: 1001, leagueId: 60, name: 'Fenerbahçe Beko',         shortName: 'FB Beko'  },
  { id: 1002, leagueId: 60, name: 'Beşiktaş GAİN',           shortName: 'BJK GAİN' },
  { id: 1003, leagueId: 60, name: 'Anadolu Efes',            shortName: 'EFS'      },
  { id: 1004, leagueId: 60, name: 'Galatasaray MCT Technic', shortName: 'GS MCT'   },
];

const FIXTURES_FIXTURE: OptaFixtureRow[] = [
  {
    matchId: 'opta-1',
    competitionId: '115', competitionName: 'Süper Lig', season: '2025-2026',
    homeTeamName: 'Galatasaray', awayTeamName: 'Fenerbahçe',
    matchDate: '2026-06-01T17:00:00.000Z',
    weekNumber: 28,
  },
  {
    matchId: 'opta-2',
    competitionId: '115', competitionName: 'Süper Lig', season: '2025-2026',
    homeTeamName: 'Beşiktaş', awayTeamName: 'Trabzonspor',
    matchDate: '2026-06-02T17:00:00.000Z',
    weekNumber: 28,
  },
  {
    matchId: 'opta-3',
    competitionId: '115', competitionName: 'Süper Lig', season: '2025-2026',
    homeTeamName: 'Adana D.S.', awayTeamName: 'Antalyaspor',
    matchDate: '2026-06-08T17:00:00.000Z',
    weekNumber: 29,
  },
  {
    matchId: 'opta-4',
    competitionId: '115', competitionName: 'Süper Lig', season: '2025-2026',
    homeTeamName: 'Konyaspor', awayTeamName: 'Sivasspor',
    matchDate: '2026-06-15T17:00:00.000Z',
    weekNumber: null,
  },
];

describe('LivePlanEntryAddDialogComponent', () => {
  let fixture: ComponentFixture<LivePlanEntryAddDialogComponent>;
  let component: LivePlanEntryAddDialogComponent;
  let svc: jasmine.SpyObj<ScheduleService>;
  let dialogRef: jasmine.SpyObj<MatDialogRef<LivePlanEntryAddDialogComponent>>;

  beforeEach(() => {
    svc = jasmine.createSpyObj('ScheduleService', [
      'getBroadcastTypes',
      'getFixtureCompetitions',
      'getOptaFixtures',
      'createLivePlanFromOpta',
      'createLivePlanEntry',
      'getManualLeagues',
      'getTeamsByLeague',
    ]);
    svc.getBroadcastTypes.and.returnValue(of(BT_FIXTURE));
    svc.getFixtureCompetitions.and.returnValue(of(COMP_FIXTURE));
    svc.getOptaFixtures.and.returnValue(of(FIXTURES_FIXTURE));
    svc.getManualLeagues.and.returnValue(of(MANUAL_LEAGUES_FIXTURE));
    svc.getTeamsByLeague.and.returnValue(of(TBL_TEAMS_FIXTURE));
    (svc.createLivePlanFromOpta as unknown as jasmine.Spy).and.callFake((dto: { optaMatchId: string }) =>
      of({ id: 100, title: dto.optaMatchId }),
    );
    (svc.createLivePlanEntry as unknown as jasmine.Spy).and.returnValue(of({ id: 999 }));

    dialogRef = jasmine.createSpyObj('MatDialogRef', ['close']);

    TestBed.configureTestingModule({
      imports:   [LivePlanEntryAddDialogComponent, NoopAnimationsModule],
      providers: [
        { provide: ScheduleService, useValue: svc },
        { provide: MatDialogRef,    useValue: dialogRef },
      ],
    });

    fixture   = TestBed.createComponent(LivePlanEntryAddDialogComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => fixture.destroy());

  it('ngOnInit: /broadcast-types ve /opta/fixture-competitions paralel fetch eder', () => {
    fixture.detectChanges();
    expect(svc.getBroadcastTypes).toHaveBeenCalledTimes(1);
    expect(svc.getFixtureCompetitions).toHaveBeenCalledTimes(1);
  });

  it('backend /broadcast-types boş ise fallback Müsabaka dropdown\'da görünür ve isOptaMode true döner', () => {
    svc.getBroadcastTypes.and.returnValue(of([]));
    fixture.detectChanges();
    const display = component.displayBroadcastTypes();
    expect(display.length).toBe(1);
    expect(display[0].code).toBe('MATCH');
    expect(display[0].description).toBe('Müsabaka');

    component.onBroadcastTypeChange(display[0].id);
    expect(component.isOptaMode()).toBeTrue();
  });

  it('backend zaten MATCH dönerse fallback duplicate eklenmez', () => {
    fixture.detectChanges(); // BT_FIXTURE includes MATCH (id:1)
    const display = component.displayBroadcastTypes();
    const matchCount = display.filter((b) => b.code === 'MATCH').length;
    expect(matchCount).toBe(1);
    expect(display.length).toBe(2); // MATCH + STUDIO
  });

  it('Müsabaka seçilmediyse isOptaMode=false; Lig/Hafta/fixture/Kaydet disabled', () => {
    fixture.detectChanges();
    expect(component.isOptaMode()).toBeFalse();
    expect(component.canSave()).toBeFalse();
    // Stüdyo seçilince yine OPTA değil
    component.onBroadcastTypeChange(2);
    expect(component.isOptaMode()).toBeFalse();
    expect(component.canSave()).toBeFalse();
  });

  it('Müsabaka seçilince isOptaMode=true; Lig henüz seçili değilse Kaydet disabled', () => {
    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    expect(component.isOptaMode()).toBeTrue();
    expect(component.canSave()).toBeFalse();
  });

  it('İçerik Türü değişince Lig/Hafta/fikstür/seçim reset edilir', () => {
    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');
    component.toggleFixture('opta-1');
    expect(component.selectedFixtureIds().size).toBe(1);

    component.onBroadcastTypeChange(2); // Stüdyo
    expect(component.selectedCompetitionCode()).toBeNull();
    expect(component.selectedWeek()).toBeNull();
    expect(component.fixtures()).toEqual([]);
    expect(component.selectedFixtureIds().size).toBe(0);
  });

  it('Lig seçilince /opta/fixtures çağrılır (competitionId+season+from)', () => {
    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');
    expect(svc.getOptaFixtures).toHaveBeenCalledTimes(1);
    const [compId, season, fromIso] = svc.getOptaFixtures.calls.mostRecent().args;
    expect(compId).toBe('115');
    expect(season).toBe('2025-2026');
    expect(typeof fromIso).toBe('string');
    expect(component.fixtures().length).toBe(4);
  });

  it('availableWeeks: distinct weekNumber (null hariç), artan sırada', () => {
    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');
    expect(component.availableWeeks()).toEqual([28, 29]);
  });

  it('Hafta filter: Tüm Haftalar (null) tüm fikstürler + null haftalı; spesifik hafta sadece eşleşen + null hariç', () => {
    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');
    expect(component.filteredFixtures().length).toBe(4);

    component.onWeekChange(28);
    expect(component.filteredFixtures().map((f) => f.matchId)).toEqual(['opta-1', 'opta-2']);

    component.onWeekChange(29);
    expect(component.filteredFixtures().map((f) => f.matchId)).toEqual(['opta-3']);

    component.onWeekChange(null);
    expect(component.filteredFixtures().length).toBe(4);
  });

  it('Multi-select: toggleFixture seçer/çıkarır; canSave seçim sayısına göre', () => {
    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');
    expect(component.canSave()).toBeFalse();

    component.toggleFixture('opta-1');
    component.toggleFixture('opta-2');
    expect(component.selectedCount()).toBe(2);
    expect(component.canSave()).toBeTrue();
    expect(component.saveButtonLabel()).toBe('2 Kaydı Ekle');

    component.toggleFixture('opta-1'); // toggle off
    expect(component.selectedCount()).toBe(1);
    expect(component.saveButtonLabel()).toBe('1 Kaydı Ekle');

    component.toggleFixture('opta-2'); // toggle off
    expect(component.selectedCount()).toBe(0);
    expect(component.canSave()).toBeFalse();
    expect(component.saveButtonLabel()).toBe('Kaydet');
  });

  it('save (batch): seçili her optaMatchId için createLivePlanFromOpta çağrılır; tümü başarılıysa dialog kapanır', () => {
    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');
    component.toggleFixture('opta-1');
    component.toggleFixture('opta-3');

    component.save();

    expect(svc.createLivePlanFromOpta).toHaveBeenCalledTimes(2);
    const calls = svc.createLivePlanFromOpta.calls.allArgs().map((a) => (a[0] as { optaMatchId: string }).optaMatchId);
    expect(calls).toEqual(['opta-1', 'opta-3']);
    expect(dialogRef.close).toHaveBeenCalled();
    const closeArg = dialogRef.close.calls.mostRecent().args[0] as { created: unknown[]; duplicates: string[]; errors: unknown[] };
    expect(closeArg.created.length).toBe(2);
    expect(closeArg.duplicates).toEqual([]);
    expect(closeArg.errors).toEqual([]);
  });

  it('save (batch): 409 duplicate partial failure — diğerleri devam eder, dialog kapanır, özet duplicates içerir', () => {
    (svc.createLivePlanFromOpta as unknown as jasmine.Spy).and.callFake((dto: { optaMatchId: string }) => {
      if (dto.optaMatchId === 'opta-2') {
        return throwError(() => new HttpErrorResponse({ status: 409, error: { message: 'duplicate' } }));
      }
      return of({ id: 200, title: dto.optaMatchId });
    });

    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');
    component.toggleFixture('opta-1');
    component.toggleFixture('opta-2');
    component.toggleFixture('opta-3');
    component.save();

    expect(svc.createLivePlanFromOpta).toHaveBeenCalledTimes(3);
    expect(dialogRef.close).toHaveBeenCalledTimes(1);
    const closeArg = dialogRef.close.calls.mostRecent().args[0] as { created: unknown[]; duplicates: string[]; errors: unknown[] };
    expect(closeArg.created.length).toBe(2);
    expect(closeArg.duplicates).toEqual(['opta-2']);
    expect(closeArg.errors).toEqual([]);
  });

  it('save (batch): hiç başarı yoksa dialog açık kalır, errorMsg set edilir', () => {
    (svc.createLivePlanFromOpta as unknown as jasmine.Spy).and.callFake(() =>
      throwError(() => new HttpErrorResponse({ status: 409 })),
    );

    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');
    component.toggleFixture('opta-1');
    component.toggleFixture('opta-2');
    component.save();

    expect(dialogRef.close).not.toHaveBeenCalled();
    expect(component.errorMsg()).toContain('mevcut');
  });

  it('save (batch): karışık 409 + 400 — dialog açık kalır (success=0)', () => {
    (svc.createLivePlanFromOpta as unknown as jasmine.Spy).and.callFake((dto: { optaMatchId: string }) => {
      const status = dto.optaMatchId === 'opta-1' ? 409 : 400;
      return throwError(() => new HttpErrorResponse({ status, error: { message: 'x' } }));
    });

    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');
    component.toggleFixture('opta-1');
    component.toggleFixture('opta-3');
    component.save();

    expect(dialogRef.close).not.toHaveBeenCalled();
    expect(component.errorMsg()).toContain('hata');
  });

  it('save (sekme 1 manuel): POST /live-plan ile ISO datetime ve trim edilmiş alanlar', () => {
    fixture.detectChanges();
    component.activeTab = 1;
    component.manual.title     = '  Galatasaray vs FB  ';
    component.manual.startDate = '2026-06-01';
    component.manual.startTime = '20:00';
    component.manual.endDate   = '2026-06-01';
    component.manual.endTime   = '22:00';
    component.manual.team1Name = ' GS ';
    component.manual.team2Name = ' FB ';

    expect(component.canSave()).toBeTrue();
    component.save();

    const body = svc.createLivePlanEntry.calls.mostRecent().args[0] as unknown as Record<string, unknown>;
    expect(body['title']).toBe('Galatasaray vs FB');
    expect(typeof body['eventStartTime']).toBe('string');
    expect(typeof body['eventEndTime']).toBe('string');
    expect(body['team1Name']).toBe('GS');
    expect(body['team2Name']).toBe('FB');
    expect(dialogRef.close).toHaveBeenCalled();
  });

  // ── Tümünü Seç ──────────────────────────────────────────────────────────
  it('Tümünü Seç: filteredFixtures boş veya disabled koşulda etkisiz', () => {
    fixture.detectChanges();
    // OPTA mode kapalı
    expect(component.selectAllDisabled()).toBeTrue();
    component.toggleAllVisible();
    expect(component.selectedFixtureIds().size).toBe(0);

    // OPTA mode açık ama Lig yok
    component.onBroadcastTypeChange(1);
    expect(component.selectAllDisabled()).toBeTrue();
    component.toggleAllVisible();
    expect(component.selectedFixtureIds().size).toBe(0);
  });

  it('Tümünü Seç: görünen fixture\'ları seçer (hafta filtresi yok → hepsi)', () => {
    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');

    expect(component.selectAllDisabled()).toBeFalse();
    expect(component.allFilteredSelected()).toBeFalse();
    expect(component.someFilteredSelected()).toBeFalse();

    component.toggleAllVisible();
    expect(component.selectedFixtureIds().size).toBe(4); // tüm fixtures
    expect(component.allFilteredSelected()).toBeTrue();
    expect(component.saveButtonLabel()).toBe('4 Kaydı Ekle');
  });

  it('Tümünü Seç: hafta filtresi varken sadece o haftayı seçer (gizli seçimleri etkilemez)', () => {
    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');

    // Önce 29. haftadan bir fixture'ı manuel seç (gizli kalacak referans)
    component.onWeekChange(29);
    component.toggleFixture('opta-3');
    expect(component.selectedFixtureIds().size).toBe(1);

    // 28. haftaya geç ve tümünü seç
    component.onWeekChange(28);
    component.toggleAllVisible();
    // 29'dan kalan + 28'deki 2 (opta-1, opta-2) = 3
    expect(component.selectedFixtureIds().size).toBe(3);
    expect(component.selectedFixtureIds().has('opta-1')).toBeTrue();
    expect(component.selectedFixtureIds().has('opta-2')).toBeTrue();
    expect(component.selectedFixtureIds().has('opta-3')).toBeTrue();
    // null haftalı opta-4 28. haftaya dahil değil
    expect(component.selectedFixtureIds().has('opta-4')).toBeFalse();
    expect(component.allFilteredSelected()).toBeTrue();
  });

  it('Tümünü Seç: hepsi seçiliyken tekrar tıklayınca görünen seçimleri kaldırır (gizli korunur)', () => {
    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');

    // Tüm haftalar — 4 seçim
    component.toggleAllVisible();
    expect(component.selectedFixtureIds().size).toBe(4);

    // 28. haftaya filtrele — 2 fixture görünür, hepsi seçili
    component.onWeekChange(28);
    expect(component.allFilteredSelected()).toBeTrue();

    // Tümünü Seç toggle off → 28'deki 2 kaldırılır, 29 (opta-3) + null (opta-4) korunur
    component.toggleAllVisible();
    expect(component.selectedFixtureIds().size).toBe(2);
    expect(component.selectedFixtureIds().has('opta-1')).toBeFalse();
    expect(component.selectedFixtureIds().has('opta-2')).toBeFalse();
    expect(component.selectedFixtureIds().has('opta-3')).toBeTrue();
    expect(component.selectedFixtureIds().has('opta-4')).toBeTrue();
  });

  it('Tümünü Seç: indeterminate state — bazıları seçili iken some=true, all=false', () => {
    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');
    component.toggleFixture('opta-1');
    expect(component.someFilteredSelected()).toBeTrue();
    expect(component.allFilteredSelected()).toBeFalse();
    // toggleAll → all selected (görünenleri tamamla)
    component.toggleAllVisible();
    expect(component.allFilteredSelected()).toBeTrue();
  });

  it('Lig null seçilince fixture listesi temizlenir + seçim sıfırlanır', () => {
    fixture.detectChanges();
    component.onBroadcastTypeChange(1);
    component.onCompetitionChange('115:2025-2026');
    component.toggleFixture('opta-1');
    expect(component.fixtures().length).toBeGreaterThan(0);

    component.onCompetitionChange(null);
    expect(component.fixtures()).toEqual([]);
    expect(component.selectedFixtureIds().size).toBe(0);
    expect(component.selectedWeek()).toBeNull();
  });

  // ── Manuel Giriş: lig destekli takım seçimi (2026-05-14, TBL) ───────────
  describe('Manuel Giriş — lig destekli takım seçimi', () => {
    it('ngOnInit: getManualLeagues çağrılır + dropdown dolu', () => {
      fixture.detectChanges();
      expect(svc.getManualLeagues).toHaveBeenCalledTimes(1);
      expect(component.manualLeagues().length).toBe(1);
      expect(component.manualLeagues()[0].name).toBe('Türkiye Basketbol Ligi');
    });

    it('Lig seçilince getTeamsByLeague çağrılır + takım listesi dolar', () => {
      fixture.detectChanges();
      component.onManualLeagueChange(60);
      expect(svc.getTeamsByLeague).toHaveBeenCalledWith(60);
      expect(component.manualTeams().length).toBe(4);
      expect(component.manualTeams()[0].name).toBe('Fenerbahçe Beko');
    });

    it('Aynı takım hem home hem away seçilemez', () => {
      fixture.detectChanges();
      component.onManualLeagueChange(60);
      component.onManualHomeChange(1001);
      // away'e home ile aynı id atanırsa state değişmez
      component.onManualAwayChange(1001);
      expect(component.manualAwayTeamId()).toBeNull();
      // farklı bir takıma izin verilir
      component.onManualAwayChange(1002);
      expect(component.manualAwayTeamId()).toBe(1002);
    });

    it('İki takım seçilince başlık otomatik üretilir: "Ev - Deplasman"', () => {
      fixture.detectChanges();
      component.onManualLeagueChange(60);
      component.onManualHomeChange(1001);
      component.onManualAwayChange(1003);
      expect(component.manual.title).toBe('Fenerbahçe Beko - Anadolu Efes');
    });

    it('Operatör Başlık alanını manuel doldurduysa auto-fill üzerine yazmaz', () => {
      fixture.detectChanges();
      component.onManualLeagueChange(60);
      component.onManualTitleInput('Özel Yayın Başlığı');
      component.onManualHomeChange(1001);
      component.onManualAwayChange(1003);
      expect(component.manual.title).toBe('Özel Yayın Başlığı');
    });

    it('canSave (lig modu): home+away ve start/end gerekli; başlık zorunlu değil (auto-fill)', () => {
      fixture.detectChanges();
      component.activeTab = 1;
      component.onManualLeagueChange(60);
      component.manual.startDate = '2026-06-01';
      component.manual.startTime = '20:00';
      component.manual.endDate   = '2026-06-01';
      component.manual.endTime   = '22:00';
      expect(component.canSave()).toBeFalse(); // takım yok

      component.onManualHomeChange(1001);
      expect(component.canSave()).toBeFalse(); // away yok

      component.onManualAwayChange(1003);
      expect(component.canSave()).toBeTrue();
    });

    it('save (lig modu): team1Name/team2Name select isimlerinden alınır + title auto-fill', () => {
      fixture.detectChanges();
      component.activeTab = 1;
      component.onManualLeagueChange(60);
      component.manual.startDate = '2026-06-01';
      component.manual.startTime = '20:00';
      component.manual.endDate   = '2026-06-01';
      component.manual.endTime   = '22:00';
      component.onManualHomeChange(1001);
      component.onManualAwayChange(1003);
      // Text input alanlarına bilgi yazılsa bile lig modu select'i ezer.
      component.manual.team1Name = 'random-text';
      component.manual.team2Name = 'random-text';
      component.save();

      const body = svc.createLivePlanEntry.calls.mostRecent().args[0] as unknown as Record<string, unknown>;
      expect(body['team1Name']).toBe('Fenerbahçe Beko');
      expect(body['team2Name']).toBe('Anadolu Efes');
      expect(body['title']).toBe('Fenerbahçe Beko - Anadolu Efes');
    });

    it('Lig değişimi: home/away seçimleri ve auto-title temizlenir', () => {
      fixture.detectChanges();
      component.onManualLeagueChange(60);
      component.onManualHomeChange(1001);
      component.onManualAwayChange(1003);
      expect(component.manual.title).toContain('Fenerbahçe Beko');

      component.onManualLeagueChange(null);
      expect(component.manualHomeTeamId()).toBeNull();
      expect(component.manualAwayTeamId()).toBeNull();
      expect(component.manualTeams()).toEqual([]);
      expect(component.manual.title).toBe('');
    });

    it('Lig seçilmeden klasik manuel mod: text input team isimleri korunur (geriye uyumlu)', () => {
      fixture.detectChanges();
      component.activeTab = 1;
      component.manual.title     = 'Galatasaray vs FB';
      component.manual.startDate = '2026-06-01';
      component.manual.startTime = '20:00';
      component.manual.endDate   = '2026-06-01';
      component.manual.endTime   = '22:00';
      component.manual.team1Name = ' GS ';
      component.manual.team2Name = ' FB ';
      expect(component.manualLeagueId()).toBeNull();
      expect(component.canSave()).toBeTrue();

      component.save();
      const body = svc.createLivePlanEntry.calls.mostRecent().args[0] as unknown as Record<string, unknown>;
      expect(body['team1Name']).toBe('GS');
      expect(body['team2Name']).toBe('FB');
    });
  });
});
