import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { of } from 'rxjs';
import type { LivePlanEntry, LivePlanListResponse } from '@bcms/shared';
import { YayinPlanlamaListComponent } from './yayin-planlama-list.component';
import { YayinPlanlamaService } from '../../core/services/yayin-planlama.service';
import { ApiService } from '../../core/services/api.service';

/**
 * 2026-05-13: Yayın Planlama list spec — `getLivePlanList()` data source.
 * EventKey input/param testleri kaldırıldı; Lig/Hafta filter testleri eklendi.
 */

function makeEntry(overrides: Partial<LivePlanEntry> = {}): LivePlanEntry {
  return {
    id:              1,
    title:           'Test Match',
    eventStartTime:  '2026-06-01T19:00:00.000Z',
    eventEndTime:    '2026-06-01T21:00:00.000Z',
    matchId:         null,
    optaMatchId:     null,
    status:          'PLANNED',
    operationNotes:  null,
    createdBy:       'u',
    version:         1,
    createdAt:       '2026-05-01T10:00:00.000Z',
    updatedAt:       '2026-05-01T10:00:00.000Z',
    deletedAt:       null,
    eventKey:        'manual:abc',
    sourceType:      'MANUAL',
    channel1Id:      null,
    channel2Id:      null,
    channel3Id:      null,
    team1Name:       'A',
    team2Name:       'B',
    leagueName:      null,
    leagueId:        null,
    weekNumber:      null,
    season:          null,
    ...overrides,
  };
}

function makeList(items: LivePlanEntry[] = [makeEntry()]): LivePlanListResponse {
  return { items, total: items.length, page: 1, pageSize: 25 };
}

describe('YayinPlanlamaListComponent (2026-05-13 — live-plan data source)', () => {
  let serviceSpy: jasmine.SpyObj<YayinPlanlamaService>;
  let apiSpy:     jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    serviceSpy = jasmine.createSpyObj<YayinPlanlamaService>('YayinPlanlamaService', [
      'getLivePlanList', 'getLeagueFilterOptions', 'getWeekFilterOptions',
    ]);
    serviceSpy.getLivePlanList.and.returnValue(of(makeList()));
    serviceSpy.getLeagueFilterOptions.and.returnValue(of([
      { id: 10, name: 'Süper Lig' },
      { id: 20, name: 'TFF 1. Lig' },
    ]));
    serviceSpy.getWeekFilterOptions.and.returnValue(of([1, 2, 3]));

    apiSpy = jasmine.createSpyObj<ApiService>('ApiService', ['get']);
    // /channels/catalog → 2 channel fixture (generic callFake; explicit cast).
    (apiSpy.get as unknown as jasmine.Spy).and.callFake((path: string) => {
      if (path === '/channels/catalog') {
        return of([
          { id: 1, name: 'beIN Sports 1 HD' },
          { id: 2, name: 'beIN Sports 2 HD' },
        ]);
      }
      return of([]);
    });

    await TestBed.configureTestingModule({
      imports: [YayinPlanlamaListComponent],
      providers: [
        provideRouter([]),
        provideAnimationsAsync(),
        { provide: YayinPlanlamaService, useValue: serviceSpy },
        { provide: ApiService,           useValue: apiSpy },
      ],
    }).compileComponents();
  });

  it('ngOnInit: getLivePlanList default page=1, pageSize=25 ile çağırır', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    expect(serviceSpy.getLivePlanList).toHaveBeenCalled();
    const args = serviceSpy.getLivePlanList.calls.mostRecent().args[0];
    expect(args!.page).toBe(1);
    expect(args!.pageSize).toBe(25);
  });

  it('ngOnInit: getLeagueFilterOptions çağrılır + leagues signal doldurulur', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    expect(serviceSpy.getLeagueFilterOptions).toHaveBeenCalled();
    const cmp = fixture.componentInstance as unknown as {
      leagues(): { id: number; name: string }[];
    };
    expect(cmp.leagues().length).toBe(2);
    expect(cmp.leagues()[0].name).toBe('Süper Lig');
  });

  it('EventKey input render edilmez (template kontrolü)', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).not.toContain('Event Key');
  });

  it('Lig dropdown render edilir + opsiyonlar', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('Lig');
  });

  it('Hafta dropdown render edilir', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('Hafta');
  });

  it('reload: leagueId set → getLivePlanList leagueId param ile çağrılır', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as {
      leagueId: number | null;
      onLeagueChange(): void;
    };
    cmp.leagueId = 10;
    cmp.onLeagueChange();
    const args = serviceSpy.getLivePlanList.calls.mostRecent().args[0];
    expect(args!.leagueId).toBe(10);
  });

  it('reload: weekNumber set → getLivePlanList weekNumber param ile çağrılır', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as {
      leagueId: number | null;
      weekNumber: number | null;
      reload(): void;
    };
    cmp.leagueId = 10;
    cmp.weekNumber = 2;
    cmp.reload();
    const args = serviceSpy.getLivePlanList.calls.mostRecent().args[0];
    expect(args!.weekNumber).toBe(2);
  });

  it('onLeagueChange: weekNumber resetlenir + getWeekFilterOptions yeniden yüklenir', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as {
      leagueId: number | null;
      weekNumber: number | null;
      onLeagueChange(): void;
    };
    cmp.leagueId = 10;
    cmp.weekNumber = 5; // önceden seçilmiş
    cmp.onLeagueChange();
    expect(cmp.weekNumber).toBeNull();
    expect(serviceSpy.getWeekFilterOptions).toHaveBeenCalledWith(10);
  });

  it('reload: leagueId/weekNumber null → param undefined gönderilir', () => {
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance as unknown as {
      leagueId: number | null;
      weekNumber: number | null;
      reload(): void;
    };
    cmp.leagueId = null;
    cmp.weekNumber = null;
    cmp.reload();
    const args = serviceSpy.getLivePlanList.calls.mostRecent().args[0];
    expect(args!.leagueId).toBeUndefined();
    expect(args!.weekNumber).toBeUndefined();
  });

  it('manual entry (leagueName/weekNumber null) "—" gösterilir', () => {
    serviceSpy.getLivePlanList.and.returnValue(of(makeList([
      makeEntry({ leagueName: null, weekNumber: null }),
    ])));
    const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
    fixture.detectChanges();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    // "Lig" + "—" hücreleri görünür
    expect(html).toContain('—');
  });

  // ── 2026-05-13: Karşılaşma sadeleştirme + kanal adı stack ─────────────
  describe('Karşılaşma kolonu (title/team birleşik)', () => {
    it('"Başlık" ve "Takımlar" kolon header\'ları render edilmez; "Karşılaşma" render edilir', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const headers = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('th'),
      ).map((th) => th.textContent?.trim() ?? '');
      expect(headers).not.toContain('Başlık');
      expect(headers).not.toContain('Takım');
      expect(headers).toContain('Karşılaşma');
    });

    it('primaryMatchLabel: team1+team2 varsa "X vs Y"', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        primaryMatchLabel(r: LivePlanEntry): string;
      };
      expect(cmp.primaryMatchLabel(makeEntry({ team1Name: 'Galatasaray', team2Name: 'Fenerbahçe' })))
        .toBe('Galatasaray vs Fenerbahçe');
    });

    it('primaryMatchLabel: takım yoksa title fallback', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        primaryMatchLabel(r: LivePlanEntry): string;
      };
      expect(cmp.primaryMatchLabel(makeEntry({ team1Name: null, team2Name: null, title: 'Stüdyo Programı' })))
        .toBe('Stüdyo Programı');
    });

    it('primaryMatchLabel: hiçbiri yoksa "—"', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        primaryMatchLabel(r: LivePlanEntry): string;
      };
      expect(cmp.primaryMatchLabel(makeEntry({ team1Name: null, team2Name: null, title: '' })))
        .toBe('—');
    });

    it('secondaryTitle: title takım bilgisinden farklıysa görünür', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        secondaryTitle(r: LivePlanEntry): string | null;
      };
      expect(cmp.secondaryTitle(makeEntry({
        team1Name: 'Galatasaray', team2Name: 'Fenerbahçe',
        title: 'Derbi Özel — Süper Lig 30. Hafta',
      }))).toBe('Derbi Özel — Süper Lig 30. Hafta');
    });

    it('secondaryTitle: title takım birleşimiyle aynıysa null (tekrar gizlenir)', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        secondaryTitle(r: LivePlanEntry): string | null;
      };
      expect(cmp.secondaryTitle(makeEntry({
        team1Name: 'Galatasaray', team2Name: 'Fenerbahçe',
        title: 'Galatasaray vs Fenerbahçe',
      }))).toBeNull();
    });

    it('secondaryTitle: takım bilgisi yoksa null (primary zaten title)', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        secondaryTitle(r: LivePlanEntry): string | null;
      };
      expect(cmp.secondaryTitle(makeEntry({
        team1Name: null, team2Name: null, title: 'Manuel Kayıt',
      }))).toBeNull();
    });
  });

  describe('Kanallar kolonu (id → name stack)', () => {
    it('countChannels gibi sayı göstermez; gerçek kanal adlarını alt alta gösterir', () => {
      serviceSpy.getLivePlanList.and.returnValue(of(makeList([
        makeEntry({ channel1Id: 1, channel2Id: 2 }),
      ])));
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(html).toContain('beIN Sports 1 HD');
      expect(html).toContain('beIN Sports 2 HD');
      // Sayı gösterimi YOK (önceki `countChannels` = "2" gibi tek karakter çıkardı)
      // Spec assertion zayıf olabilir; bu yüzden direct helper kontrolü:
      const cmp = fixture.componentInstance as unknown as {
        channelNamesStack(r: LivePlanEntry): string;
      };
      const stack = cmp.channelNamesStack(makeEntry({ channel1Id: 1, channel2Id: 2 }));
      expect(stack).toBe('beIN Sports 1 HD\nbeIN Sports 2 HD');
    });

    it('hiç kanal yoksa "—"', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        channelNamesStack(r: LivePlanEntry): string;
      };
      const stack = cmp.channelNamesStack(makeEntry({ channel1Id: null, channel2Id: null, channel3Id: null }));
      expect(stack).toBe('—');
    });

    it('lookup\'ta olmayan id atılır (defensive: stale row)', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        channelNamesStack(r: LivePlanEntry): string;
      };
      // id=999 catalog'da yok; id=1 var → sadece "beIN Sports 1 HD"
      const stack = cmp.channelNamesStack(makeEntry({ channel1Id: 1, channel2Id: 999 }));
      expect(stack).toBe('beIN Sports 1 HD');
    });

    it('ngOnInit: ApiService.get("/channels/catalog") çağrılır (channel name lookup)', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      expect(apiSpy.get).toHaveBeenCalledWith('/channels/catalog');
    });
  });
});
