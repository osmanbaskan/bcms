import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { KeycloakService } from 'keycloak-angular';
import type { LivePlanEntry, LivePlanListResponse } from '@bcms/shared';
import { YayinPlanlamaListComponent } from './yayin-planlama-list.component';
import { YayinPlanlamaService } from '../../core/services/yayin-planlama.service';
import { ApiService } from '../../core/services/api.service';
import { environment } from '../../../environments/environment';

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
      'updateLivePlanChannels',
    ]);
    serviceSpy.getLivePlanList.and.returnValue(of(makeList()));
    serviceSpy.getLeagueFilterOptions.and.returnValue(of([
      { id: 10, name: 'Süper Lig' },
      { id: 20, name: 'TFF 1. Lig' },
    ]));
    serviceSpy.getWeekFilterOptions.and.returnValue(of([1, 2, 3]));
    serviceSpy.updateLivePlanChannels.and.returnValue(of(makeEntry({ version: 2, channel1Id: 1 })));
    (serviceSpy as unknown as { updateLivePlanEventStart: jasmine.Spy }).updateLivePlanEventStart =
      jasmine.createSpy('updateLivePlanEventStart').and.returnValue(
        of(makeEntry({ version: 2, eventStartTime: '2026-06-02T19:00:00.000Z' })),
      );

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

  describe('Kolon sırası ve tarih formatı', () => {
    it('cols sırası: date, time, match, league, week, channels (status kaldırıldı 2026-05-13)', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as { cols: string[] };
      expect(cmp.cols).toEqual(['date', 'time', 'match', 'league', 'week', 'channels']);
      expect(cmp.cols).not.toContain('status');
      expect(cmp.cols[0]).toBe('date');
      expect(cmp.cols[1]).toBe('time');
      expect(cmp.cols[2]).toBe('match');
    });

    it('formatDate: UTC ISO → "DD.MM.YYYY" (Türkiye)', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        formatDate(iso: string | null | undefined): string;
      };
      // 2026-06-01T19:00:00Z → Türkiye 2026-06-01 22:00 → "01.06.2026"
      expect(cmp.formatDate('2026-06-01T19:00:00.000Z')).toBe('01.06.2026');
      // Akşam late UTC Türkiye'de ertesi güne taşar: 2026-12-31T23:30Z → +03:00 → 2027-01-01 02:30
      expect(cmp.formatDate('2026-12-31T23:30:00.000Z')).toBe('01.01.2027');
      expect(cmp.formatDate(null)).toBe('—');
      expect(cmp.formatDate(undefined)).toBe('—');
    });

    it('formatTime: UTC ISO → "HH:mm" (Türkiye)', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        formatTime(iso: string | null | undefined): string;
      };
      // 19:00Z + 03:00 → 22:00
      expect(cmp.formatTime('2026-06-01T19:00:00.000Z')).toBe('22:00');
      expect(cmp.formatTime(null)).toBe('—');
    });
  });

  describe('Kanallar kolonu (id → name stack)', () => {
    it('channelNamesStack helper: kanal adları "\\n" ile alt alta join', () => {
      // 2026-05-13: Inline edit aktifken trigger DOM ile değil helper ile
      // doğrula (mat-select option textleri overlay'da render olur). Read-only
      // path zaten yetkisiz describe block'unda HTML üzerinden assert ediliyor.
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
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

  // ── 2026-05-13: Inline kanal düzenleme (LivePlanEntry PATCH üzerinden) ─
  describe('Inline kanal düzenleme', () => {
    it('yetkili kullanıcıda Kanallar hücresinde 3 mat-select render edilir', () => {
      serviceSpy.getLivePlanList.and.returnValue(of(makeList([
        makeEntry({ id: 5, channel1Id: 1, channel2Id: null, channel3Id: null }),
      ])));
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      const selects = host.querySelectorAll('.td-channels .ch-select');
      expect(selects.length).toBe(3);
      // Read-only stack render edilmez (yetkili path)
      expect(host.querySelector('.td-channels .ch-readonly')).toBeNull();
    });

    it('onChannelChange: slot=1 yeni id → updateLivePlanChannels(id, dto, version) çağrılır', () => {
      serviceSpy.getLivePlanList.and.returnValue(of(makeList([
        makeEntry({ id: 7, version: 4, channel1Id: null, channel2Id: 2, channel3Id: null }),
      ])));
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        rows(): LivePlanEntry[];
        onChannelChange(row: LivePlanEntry, slot: 1 | 2 | 3, newId: number | null): void;
      };
      const row = cmp.rows()[0];
      cmp.onChannelChange(row, 1, 1);
      expect(serviceSpy.updateLivePlanChannels).toHaveBeenCalledWith(
        7,
        { channel1Id: 1, channel2Id: 2, channel3Id: null },
        4,
      );
    });

    it('onChannelChange: aynı değer → updateLivePlanChannels ÇAĞRILMAZ', () => {
      serviceSpy.getLivePlanList.and.returnValue(of(makeList([
        makeEntry({ id: 8, channel1Id: 1 }),
      ])));
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        rows(): LivePlanEntry[];
        onChannelChange(row: LivePlanEntry, slot: 1 | 2 | 3, newId: number | null): void;
      };
      serviceSpy.updateLivePlanChannels.calls.reset();
      cmp.onChannelChange(cmp.rows()[0], 1, 1);
      expect(serviceSpy.updateLivePlanChannels).not.toHaveBeenCalled();
    });

    it('success: row updated entry ile değiştirilir (yeni version)', () => {
      serviceSpy.getLivePlanList.and.returnValue(of(makeList([
        makeEntry({ id: 9, version: 3, channel1Id: null }),
      ])));
      serviceSpy.updateLivePlanChannels.and.returnValue(
        of(makeEntry({ id: 9, version: 4, channel1Id: 2 })),
      );
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        rows(): LivePlanEntry[];
        onChannelChange(row: LivePlanEntry, slot: 1 | 2 | 3, newId: number | null): void;
        savingRowId(): number | null;
      };
      cmp.onChannelChange(cmp.rows()[0], 1, 2);
      const updated = cmp.rows()[0];
      expect(updated.version).toBe(4);
      expect(updated.channel1Id).toBe(2);
      expect(cmp.savingRowId()).toBeNull();
    });

    it('hata: eski row geri yüklenir (optimistic rollback)', () => {
      serviceSpy.getLivePlanList.and.returnValue(of(makeList([
        makeEntry({ id: 10, version: 5, channel1Id: 1, channel2Id: 2 }),
      ])));
      serviceSpy.updateLivePlanChannels.and.returnValue(throwError(() =>
        new HttpErrorResponse({ status: 400, error: { message: 'val' } }),
      ));
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        rows(): LivePlanEntry[];
        onChannelChange(row: LivePlanEntry, slot: 1 | 2 | 3, newId: number | null): void;
      };
      cmp.onChannelChange(cmp.rows()[0], 1, 9);
      const after = cmp.rows()[0];
      // Eski değerler geri yüklenmeli
      expect(after.channel1Id).toBe(1);
      expect(after.channel2Id).toBe(2);
      expect(after.version).toBe(5);
    });

    it('412 conflict: reload() çağrılır + getLivePlanList tekrar', () => {
      serviceSpy.getLivePlanList.and.returnValue(of(makeList([
        makeEntry({ id: 11, version: 6, channel1Id: null }),
      ])));
      serviceSpy.updateLivePlanChannels.and.returnValue(throwError(() =>
        new HttpErrorResponse({ status: 412, error: { message: 'version mismatch' } }),
      ));
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      serviceSpy.getLivePlanList.calls.reset();
      const cmp = fixture.componentInstance as unknown as {
        rows(): LivePlanEntry[];
        onChannelChange(row: LivePlanEntry, slot: 1 | 2 | 3, newId: number | null): void;
      };
      cmp.onChannelChange(cmp.rows()[0], 1, 1);
      // reload sonrası tekrar liste fetch'i
      expect(serviceSpy.getLivePlanList).toHaveBeenCalled();
    });
  });

  // ── 2026-05-13: Durum kolon/filter kaldırma + inline tarih edit ───────
  describe('Durum filter/kolon kaldırıldı', () => {
    it('filter bar\'da "Durum" mat-form-field render edilmez', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const html = fixture.nativeElement as HTMLElement;
      const labels = Array.from(html.querySelectorAll('mat-label'))
        .map((l) => l.textContent?.trim() ?? '');
      expect(labels).not.toContain('Durum');
    });

    it('"Durum" th header render edilmez', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const headers = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('th'),
      ).map((th) => th.textContent?.trim() ?? '');
      expect(headers).not.toContain('Durum');
    });

    it('getLivePlanList status paramı GÖNDERMEZ', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const args = serviceSpy.getLivePlanList.calls.mostRecent().args[0]!;
      expect((args as Record<string, unknown>)['status']).toBeUndefined();
    });
  });

  describe('Inline tarih düzenleme', () => {
    it('yetkili kullanıcıda Tarih hücresinde <input type="date"> render edilir', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const inputs = (fixture.nativeElement as HTMLElement)
        .querySelectorAll('.td-date input[type="date"]');
      expect(inputs.length).toBe(1);
    });

    it('dateInputValue: UTC ISO → Türkiye "YYYY-MM-DD"', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        dateInputValue(r: LivePlanEntry): string;
      };
      // 2026-06-01T19:00:00Z → Türkiye 2026-06-01 22:00 → "2026-06-01"
      expect(cmp.dateInputValue(makeEntry({ eventStartTime: '2026-06-01T19:00:00.000Z' })))
        .toBe('2026-06-01');
      // 23:30Z → ertesi gün Türkiye
      expect(cmp.dateInputValue(makeEntry({ eventStartTime: '2026-12-31T23:30:00.000Z' })))
        .toBe('2027-01-01');
    });

    it('onDateChange: yeni tarih → updateLivePlanEventStart çağrılır + mevcut Türkiye saati korunur', () => {
      // row.eventStartTime = 2026-06-01T19:00:00Z → Türkiye 22:00
      serviceSpy.getLivePlanList.and.returnValue(of(makeList([
        makeEntry({ id: 50, version: 3, eventStartTime: '2026-06-01T19:00:00.000Z' }),
      ])));
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        rows(): LivePlanEntry[];
        onDateChange(r: LivePlanEntry, d: string): void;
      };
      cmp.onDateChange(cmp.rows()[0], '2026-06-15'); // 15 Haziran 22:00 Türkiye
      const spy = (serviceSpy as unknown as {
        updateLivePlanEventStart: jasmine.Spy;
      }).updateLivePlanEventStart;
      expect(spy).toHaveBeenCalled();
      const [id, iso, version] = spy.calls.mostRecent().args;
      expect(id).toBe(50);
      expect(version).toBe(3);
      // 2026-06-15 22:00 Türkiye = 19:00 UTC
      expect(iso).toBe('2026-06-15T19:00:00.000Z');
    });

    it('onDateChange: aynı tarih → updateLivePlanEventStart ÇAĞRILMAZ', () => {
      serviceSpy.getLivePlanList.and.returnValue(of(makeList([
        makeEntry({ id: 51, eventStartTime: '2026-06-01T19:00:00.000Z' }),
      ])));
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        rows(): LivePlanEntry[];
        onDateChange(r: LivePlanEntry, d: string): void;
      };
      const spy = (serviceSpy as unknown as {
        updateLivePlanEventStart: jasmine.Spy;
      }).updateLivePlanEventStart;
      spy.calls.reset();
      cmp.onDateChange(cmp.rows()[0], '2026-06-01'); // aynı gün
      expect(spy).not.toHaveBeenCalled();
    });

    it('onDateChange success: row updated entry ile değiştirilir (yeni version)', () => {
      serviceSpy.getLivePlanList.and.returnValue(of(makeList([
        makeEntry({ id: 52, version: 5, eventStartTime: '2026-06-01T19:00:00.000Z' }),
      ])));
      const spy = (serviceSpy as unknown as {
        updateLivePlanEventStart: jasmine.Spy;
      }).updateLivePlanEventStart;
      spy.and.returnValue(of(makeEntry({
        id: 52, version: 6, eventStartTime: '2026-06-15T19:00:00.000Z',
      })));
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        rows(): LivePlanEntry[];
        onDateChange(r: LivePlanEntry, d: string): void;
      };
      cmp.onDateChange(cmp.rows()[0], '2026-06-15');
      const updated = cmp.rows()[0];
      expect(updated.version).toBe(6);
      expect(updated.eventStartTime).toBe('2026-06-15T19:00:00.000Z');
    });

    it('onDateChange error: optimistic rollback', () => {
      serviceSpy.getLivePlanList.and.returnValue(of(makeList([
        makeEntry({ id: 53, version: 7, eventStartTime: '2026-06-01T19:00:00.000Z' }),
      ])));
      const spy = (serviceSpy as unknown as {
        updateLivePlanEventStart: jasmine.Spy;
      }).updateLivePlanEventStart;
      spy.and.returnValue(throwError(() =>
        new HttpErrorResponse({ status: 400, error: { message: 'invalid' } }),
      ));
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const cmp = fixture.componentInstance as unknown as {
        rows(): LivePlanEntry[];
        onDateChange(r: LivePlanEntry, d: string): void;
      };
      cmp.onDateChange(cmp.rows()[0], '2026-06-15');
      const after = cmp.rows()[0];
      expect(after.eventStartTime).toBe('2026-06-01T19:00:00.000Z');
      expect(after.version).toBe(7);
    });

    it('onDateChange 412 conflict: reload tetiklenir', () => {
      serviceSpy.getLivePlanList.and.returnValue(of(makeList([
        makeEntry({ id: 54, version: 8 }),
      ])));
      const spy = (serviceSpy as unknown as {
        updateLivePlanEventStart: jasmine.Spy;
      }).updateLivePlanEventStart;
      spy.and.returnValue(throwError(() =>
        new HttpErrorResponse({ status: 412, error: { message: 'version mismatch' } }),
      ));
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      serviceSpy.getLivePlanList.calls.reset();
      const cmp = fixture.componentInstance as unknown as {
        rows(): LivePlanEntry[];
        onDateChange(r: LivePlanEntry, d: string): void;
      };
      cmp.onDateChange(cmp.rows()[0], '2026-06-15');
      expect(serviceSpy.getLivePlanList).toHaveBeenCalled();
    });

    it('kanal hücresinde ch-edit yan yana layout container var (row flex)', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const chEdit = (fixture.nativeElement as HTMLElement).querySelector('.td-channels .ch-edit');
      expect(chEdit).not.toBeNull();
      // 3 mat-select aynı flex container içinde
      const selects = chEdit!.querySelectorAll('.ch-select');
      expect(selects.length).toBe(3);
    });
  });

  // ── Yetkisiz kullanıcı (canEditLivePlan=false) read-only path ──────────
  describe('Yetkisiz kullanıcı — read-only kanal hücresi', () => {
    let originalSkipAuth: boolean;
    beforeAll(() => {
      originalSkipAuth = (environment as { skipAuth: boolean }).skipAuth;
      (environment as { skipAuth: boolean }).skipAuth = false;
    });
    afterAll(() => {
      (environment as { skipAuth: boolean }).skipAuth = originalSkipAuth;
    });

    let svcSpy:  jasmine.SpyObj<YayinPlanlamaService>;
    let apiSpy2: jasmine.SpyObj<ApiService>;

    beforeEach(async () => {
      svcSpy = jasmine.createSpyObj<YayinPlanlamaService>('YayinPlanlamaService', [
        'getLivePlanList', 'getLeagueFilterOptions', 'getWeekFilterOptions',
        'updateLivePlanChannels', 'updateLivePlanEventStart',
      ]);
      svcSpy.getLivePlanList.and.returnValue(of(makeList([
        makeEntry({ id: 99, channel1Id: 1, channel2Id: 2 }),
      ])));
      svcSpy.getLeagueFilterOptions.and.returnValue(of([]));
      svcSpy.getWeekFilterOptions.and.returnValue(of([]));

      apiSpy2 = jasmine.createSpyObj<ApiService>('ApiService', ['get']);
      (apiSpy2.get as unknown as jasmine.Spy).and.callFake((path: string) => {
        if (path === '/channels/catalog') {
          return of([{ id: 1, name: 'beIN 1' }, { id: 2, name: 'beIN 2' }]);
        }
        return of([]);
      });

      // Empty groups; not Admin; skipAuth off → canEditLivePlan false
      const keycloakStub = {
        getKeycloakInstance: () => ({ tokenParsed: { groups: [] } }),
      };

      await TestBed.configureTestingModule({
        imports: [YayinPlanlamaListComponent],
        providers: [
          provideRouter([]),
          provideAnimationsAsync(),
          { provide: YayinPlanlamaService, useValue: svcSpy },
          { provide: ApiService,           useValue: apiSpy2 },
          { provide: KeycloakService,      useValue: keycloakStub },
        ],
      }).compileComponents();
    });

    it('mat-select render edilmez; read-only ad listesi görünür', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelectorAll('.td-channels .ch-select').length).toBe(0);
      const readonly = host.querySelector('.td-channels .ch-readonly');
      expect(readonly).not.toBeNull();
      expect(readonly!.textContent).toContain('beIN 1');
      expect(readonly!.textContent).toContain('beIN 2');
    });

    it('date input render edilmez; tarih read-only "DD.MM.YYYY" görünür', () => {
      const fixture = TestBed.createComponent(YayinPlanlamaListComponent);
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelectorAll('.td-date input[type="date"]').length).toBe(0);
      // Read-only span — eventStartTime: 2026-06-01T19:00:00Z → "01.06.2026"
      expect(host.textContent).toContain('01.06.2026');
    });
  });
});
