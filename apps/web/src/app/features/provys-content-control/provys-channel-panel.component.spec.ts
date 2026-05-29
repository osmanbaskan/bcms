import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ProvysChannelPanelComponent } from './provys-channel-panel.component';
import { ProvysService } from './provys.service';
import {
  PROVYS_CATEGORY_STYLES,
  type ProvysItemDto,
  type ProvysItemSsdbInfo,
  type ProvysMaterialStatus,
} from './provys.types';

function makeItem(over: Partial<ProvysItemDto>): ProvysItemDto {
  return {
    id: 1,
    channelSlug: 'beinsports1' as any,
    scheduleDate: '2026-05-22',
    eventId: 'E1',
    sequence: 0,
    startAt: '2026-05-22T18:00:00Z',
    durationMs: 60_000,
    startTimecode: null,
    durationTimecode: null,
    frameRate: null,
    dcCode: null,
    title: 'Item',
    rawKind: null,
    category: 'DIGER',
    versionName: null,
    episodeName: null,
    eventTitle: null,
    contentName: null,
    programName: null,
    adType: null,
    spotType: null,
    titleSource: null,
    seriesName: null,
    episodeNumber: null,
    sourceFile: '/f.bxf',
    userNote: null,
    updatedAt: '2026-05-22T18:00:00Z',
    // C7 (2026-05-27): SSDB merge default — testler ssdb merge davranışını
    // kendi spec'lerinde (provys.ssdb-merge.unit.spec.ts) doğrular; bu
    // component fixture sadece DTO compile compliance için unchecked default.
    ssdb: {
      lookupStatus: null,
      materialStatus: 'unchecked',
      statusLabel: 'Kontrol bekliyor',
      mediaGuid: null,
      matchMethod: null,
      ssdbDurationFrames: null,
      ssdbDurationTimecode: null,
      provysDurationFrames: null,
      frameRate: null,
      lastCheckedAt: null,
      lastError: null,
    },
    ...over,
  };
}

class FakeProvysService {
  private readonly store = signal<ProvysItemDto[]>([]);
  private readonly seen = signal(false);
  // Tüm kategoriler default seçili — panel mevcut testlerinde tam görünür liste.
  private readonly selected = signal<Set<string>>(new Set(['REKLAM', 'KAMU_SPOTU', 'CANLI', 'PROGRAM', 'TANITIM', 'DIGER']));
  /** Test spy — gerçek HTTP yapmadan optimistic store update. */
  updateNoteCalls: Array<{ channel: string; id: number; note: string | null }> = [];
  updateNoteShouldThrow = false;

  itemsFor() { return this.store.asReadonly(); }
  hasReceived() { return this.seen(); }
  filteredItemsFor() {
    return signal(this.store().filter((i) => this.selected().has(i.category))).asReadonly();
  }

  setItems(items: ProvysItemDto[]) {
    this.seen.set(true);
    this.store.set(items);
  }
  setSelectedCategories(set: Set<string>) {
    this.selected.set(set);
  }

  async updateNote(channel: string, id: number, note: string | null): Promise<void> {
    this.updateNoteCalls.push({ channel, id, note });
    if (this.updateNoteShouldThrow) throw new Error('PATCH fail');
    this.store.set(this.store().map((i) => (i.id === id ? { ...i, userNote: note } : i)));
  }
}

describe('ProvysChannelPanelComponent', () => {
  let fixture: ComponentFixture<ProvysChannelPanelComponent>;
  let fake: FakeProvysService;

  beforeEach(async () => {
    fake = new FakeProvysService();
    await TestBed.configureTestingModule({
      imports: [ProvysChannelPanelComponent],
      providers: [{ provide: ProvysService, useValue: fake }],
    }).compileComponents();

    fixture = TestBed.createComponent(ProvysChannelPanelComponent);
    fixture.componentRef.setInput('channel', 'beinsports1');
  });

  it('shows the loading state before any data has been received', () => {
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Yükleniyor');
  });

  it('shows the empty state when the channel returns no items', () => {
    fake.setItems([]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Seçili tarih için BXF akışı yok');
  });

  it('applies the correct row CSS class for each category', () => {
    const items: ProvysItemDto[] = [
      makeItem({ id: 1, category: 'REKLAM' }),
      makeItem({ id: 2, category: 'KAMU_SPOTU', sequence: 1 }),
      makeItem({ id: 3, category: 'CANLI',      sequence: 2 }),
      makeItem({ id: 4, category: 'PROGRAM',    sequence: 3 }),
      makeItem({ id: 5, category: 'TANITIM',    sequence: 4 }),
      makeItem({ id: 6, category: 'DIGER',      sequence: 5 }),
    ];
    fake.setItems(items);
    fixture.detectChanges();

    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('tr.row');
    expect(rows.length).toBe(6);
    expect(rows[0].classList.contains('row--reklam')).toBe(true);
    expect(rows[1].classList.contains('row--kamu')).toBe(true);
    expect(rows[2].classList.contains('row--canli')).toBe(true);
    expect(rows[3].classList.contains('row--program')).toBe(true);
    expect(rows[4].classList.contains('row--tanitim')).toBe(true);
    expect(rows[5].classList.contains('row--diger')).toBe(true);
  });

  it('uses the shared PROVYS_CATEGORY_STYLES map for chip labels', () => {
    fake.setItems([makeItem({ category: 'CANLI' })]);
    fixture.detectChanges();
    const chip = (fixture.nativeElement as HTMLElement).querySelector('.cat-chip');
    expect(chip?.textContent?.trim()).toBe(PROVYS_CATEGORY_STYLES.CANLI.label);
  });

  it('shows SMPTE timecode HH:MM:SS:FF in the start column when present', () => {
    fake.setItems([makeItem({ startTimecode: '23:45:00:04' })]);
    fixture.detectChanges();
    const cell = (fixture.nativeElement as HTMLElement)
      .querySelector('tbody tr.row td.col-time')?.textContent?.trim();
    expect(cell).toBe('23:45:00:04');
  });

  it('falls back to Europe/Istanbul wall-clock when startTimecode is null', () => {
    fake.setItems([makeItem({ startTimecode: null, startAt: '2026-05-22T15:00:00Z' })]);
    fixture.detectChanges();
    const cell = (fixture.nativeElement as HTMLElement)
      .querySelector('tbody tr.row td.col-time')?.textContent;
    // 15:00 UTC = 18:00 Istanbul (UTC+3, no DST)
    expect(cell).toContain('18:00');
  });

  it('shows SMPTE duration HH:MM:SS:FF when present', () => {
    fake.setItems([makeItem({ durationTimecode: '00:15:01:16' })]);
    fixture.detectChanges();
    const cell = (fixture.nativeElement as HTMLElement)
      .querySelector('tbody tr.row td.col-dur')?.textContent?.trim();
    expect(cell).toBe('00:15:01:16');
  });

  it('falls back to ms-based HH:MM:SS when durationTimecode is null; shows — when both null', () => {
    fake.setItems([
      makeItem({ id: 1, durationTimecode: null, durationMs: 30_000,    sequence: 0 }),
      makeItem({ id: 2, durationTimecode: null, durationMs: 5_400_000, sequence: 1 }),
      makeItem({ id: 3, durationTimecode: null, durationMs: null,      sequence: 2 }),
    ]);
    fixture.detectChanges();
    const cells = (fixture.nativeElement as HTMLElement)
      .querySelectorAll('tbody tr.row td.col-dur');
    expect(cells[0].textContent?.trim()).toBe('00:00:30');
    expect(cells[1].textContent?.trim()).toBe('01:30:00');
    expect(cells[2].textContent?.trim()).toBe('—');
  });

  it('renders the DC Kod column; null → "—"', () => {
    fake.setItems([
      makeItem({ id: 1, dcCode: 'DC00041439', sequence: 0 }),
      makeItem({ id: 2, dcCode: null,         sequence: 1 }),
    ]);
    fixture.detectChanges();
    // Header has the new column
    const headers = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('thead th'),
    ).map((th) => th.textContent?.trim());
    expect(headers).toContain('DC Kod');

    const cells = (fixture.nativeElement as HTMLElement)
      .querySelectorAll('tbody tr.row td.col-dc');
    expect(cells[0].textContent?.trim()).toBe('DC00041439');
    expect(cells[1].textContent?.trim()).toBe('—');
    // Null hücre muted class'ı taşımalı
    expect(cells[1].classList.contains('muted')).toBe(true);
  });

  // 2026-05-27 (night): "Not" kolonu kaldırıldı — UI'da userNote input artık
  // yok. Backend `userNote` model alanı ve PATCH /provys/items/:id/note
  // endpoint'i korunur (gelecekte tekrar eklenebilir). Eski Not editör
  // testleri kapsam dışına alındı.
  describe('Kolon sırası — Süre + Not (2026-05-27 revize)', () => {
    it('header sırası: # Başlangıç Kategori DC Kod NEXIO Başlık Süre Not', () => {
      fake.setItems([makeItem({ id: 1, dcCode: 'DC1' })]);
      fixture.detectChanges();
      const headers = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('thead th'),
      ).map((th) => th.textContent?.trim());
      expect(headers).toEqual(['#', 'Başlangıç', 'Kategori', 'DC Kod', 'NEXIO', 'Başlık', 'Süre', 'Not']);
      expect(headers).not.toContain('Materyal');
    });

    it('Süre hücresi sondan bir önceki kolonda render edilir', () => {
      fake.setItems([makeItem({ id: 1, durationTimecode: '00:02:58:14' })]);
      fixture.detectChanges();
      const row = (fixture.nativeElement as HTMLElement).querySelector('tbody tr.row') as HTMLElement;
      const cells = Array.from(row.querySelectorAll('td'));
      const dur = cells[cells.length - 2];
      expect(dur.classList.contains('col-dur')).toBe(true);
      expect(dur.textContent?.trim()).toBe('00:02:58:14');
    });

    it('"Not" input son kolonda DOM\'da render edilir', () => {
      fake.setItems([makeItem({ id: 1 })]);
      fixture.detectChanges();
      const input = (fixture.nativeElement as HTMLElement).querySelector('.col-note .note-input');
      expect(input).not.toBeNull();
      expect((input as HTMLInputElement).tagName).toBe('INPUT');
    });
  });

  // C9 (2026-05-27): Materyal kolonu — SSDB response-time computed status.
  describe('Materyal kolonu — status badge + tooltip', () => {
    function buildSsdb(over: Partial<ProvysItemSsdbInfo>): ProvysItemSsdbInfo {
      return {
        lookupStatus: null,
        materialStatus: 'unchecked',
        statusLabel: 'Kontrol bekliyor',
        mediaGuid: null,
        matchMethod: null,
        ssdbDurationFrames: null,
        ssdbDurationTimecode: null,
        provysDurationFrames: null,
        frameRate: null,
        lastCheckedAt: null,
        lastError: null,
        ...over,
      };
    }

    function setRowsWithSsdb(rows: Array<{ id: number; ssdb: Partial<ProvysItemSsdbInfo>; over?: Partial<ProvysItemDto> }>): void {
      const items = rows.map((r, i) => makeItem({
        id: r.id,
        sequence: i,
        ssdb: buildSsdb(r.ssdb),
        ...(r.over ?? {}),
      }));
      fake.setItems(items);
      fixture.detectChanges();
    }

    function badgeText(idx = 0): string {
      const cell = (fixture.nativeElement as HTMLElement)
        .querySelectorAll('tbody tr.row td.col-mat .mat-badge')[idx] as HTMLElement;
      return cell?.textContent?.trim() ?? '';
    }

    function badgeClasses(idx = 0): string {
      const cell = (fixture.nativeElement as HTMLElement)
        .querySelectorAll('tbody tr.row td.col-mat .mat-badge')[idx] as HTMLElement;
      return cell?.className ?? '';
    }

    function badgeTitle(idx = 0): string {
      const cell = (fixture.nativeElement as HTMLElement)
        .querySelectorAll('tbody tr.row td.col-mat .mat-badge')[idx] as HTMLElement;
      return cell?.getAttribute('title') ?? '';
    }

    it('renders "NEXIO" header column between DC Kod and Başlık', () => {
      setRowsWithSsdb([{ id: 1, ssdb: {} }]);
      const headers = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('thead th'),
      ).map((th) => th.textContent?.trim());
      expect(headers).toContain('NEXIO');
      expect(headers).not.toContain('Materyal');
      const dcIdx = headers.indexOf('DC Kod');
      const nexioIdx = headers.indexOf('NEXIO');
      const titleIdx = headers.indexOf('Başlık');
      expect(nexioIdx).toBe(dcIdx + 1);
      expect(titleIdx).toBe(nexioIdx + 1);
    });

    it('8 status compact label correctly rendered', () => {
      const cases: Array<{ status: ProvysMaterialStatus; expectedLabel: string }> = [
        { status: 'live_not_applicable',     expectedLabel: 'Canlı' },
        { status: 'dc_not_applicable',       expectedLabel: '—' },
        { status: 'unchecked',               expectedLabel: 'Bekliyor' },
        { status: 'missing_material',        expectedLabel: 'Eksik' },
        { status: 'found_match',             expectedLabel: 'Var' },
        { status: 'found_duration_mismatch', expectedLabel: 'Süre uymuyor' },
        { status: 'found_duration_unknown',  expectedLabel: 'Süre yok' },
        { status: 'ssdb_error',              expectedLabel: 'SSDB hata' },
      ];
      setRowsWithSsdb(cases.map((c, i) => ({
        id: i + 1,
        ssdb: { materialStatus: c.status },
      })));
      for (let i = 0; i < cases.length; i++) {
        expect(badgeText(i)).toBe(cases[i].expectedLabel);
      }
    });

    it('live_not_applicable → neutral tone class (no warning/danger)', () => {
      setRowsWithSsdb([{ id: 1, ssdb: { materialStatus: 'live_not_applicable' } }]);
      const classes = badgeClasses(0);
      expect(classes).toContain('mat-badge--neutral');
      expect(classes).not.toContain('mat-badge--warning');
      expect(classes).not.toContain('mat-badge--danger');
    });

    it('found_match → success tone, found_duration_mismatch → danger, missing_material → warning', () => {
      setRowsWithSsdb([
        { id: 1, ssdb: { materialStatus: 'found_match' } },
        { id: 2, ssdb: { materialStatus: 'found_duration_mismatch' } },
        { id: 3, ssdb: { materialStatus: 'missing_material' } },
        { id: 4, ssdb: { materialStatus: 'unchecked' } },
      ]);
      expect(badgeClasses(0)).toContain('mat-badge--success');
      expect(badgeClasses(1)).toContain('mat-badge--danger');
      expect(badgeClasses(2)).toContain('mat-badge--warning');
      expect(badgeClasses(3)).toContain('mat-badge--muted');
    });

    it('found_duration_mismatch tooltip includes Provys/SSDB frames + diff', () => {
      setRowsWithSsdb([{
        id: 1,
        ssdb: {
          materialStatus: 'found_duration_mismatch',
          provysDurationFrames: 4464,
          ssdbDurationFrames: 4465,
          ssdbDurationTimecode: '00:02:58:15',
          matchMethod: 'alias',
          mediaGuid: 'GUID-1',
          frameRate: 25,
          lastCheckedAt: '2026-05-27T08:00:00.000Z',
        },
      }]);
      const tip = badgeTitle(0);
      expect(tip).toContain('Materyal var, duration uymuyor');
      expect(tip).toContain('Provys');
      expect(tip).toContain('SSDB');
      expect(tip).toContain('4464');
      expect(tip).toContain('4465');
      expect(tip).toContain('Fark: 1 frame');
      expect(tip).toContain('alias');
      expect(tip).toContain('GUID-1');
    });

    it('live_not_applicable tooltip: neutral info text', () => {
      setRowsWithSsdb([{ id: 1, ssdb: { materialStatus: 'live_not_applicable' } }]);
      expect(badgeTitle(0)).toBe('Canlı yayın; SSDB MAM materyal kontrolü yapılmaz');
    });

    it('missing_material tooltip: DC + son kontrol', () => {
      setRowsWithSsdb([{
        id: 1,
        over: { dcCode: 'DC00012345' },
        ssdb: {
          materialStatus: 'missing_material',
          lastCheckedAt: '2026-05-27T07:55:00.000Z',
        },
      }]);
      const tip = badgeTitle(0);
      expect(tip).toContain('Materyal eksik');
      expect(tip).toContain('DC: DC00012345');
      expect(tip).toContain('Son kontrol');
    });

    it('ssdb_error tooltip lastError shown (truncated up to 160)', () => {
      const longErr = 'x'.repeat(300);
      setRowsWithSsdb([{
        id: 1,
        ssdb: {
          materialStatus: 'ssdb_error',
          lastError: longErr,
          lastCheckedAt: '2026-05-27T08:00:00.000Z',
        },
      }]);
      const tip = badgeTitle(0);
      expect(tip).toContain('SSDB hata');
      expect(tip).toContain('Hata:');
      // 160 + 3 ('...') civarı — full length asla 300 olmamalı
      const errLine = tip.split('\n').find((l) => l.startsWith('Hata:')) ?? '';
      expect(errLine.length).toBeLessThan(180);
    });

    it('Provys "Süre" hücresi DEĞIŞMEDI (durationTimecode tercihi korunur)', () => {
      // C9 invariant: SSDB duration "Süre" hücresini EZMEZ.
      setRowsWithSsdb([{
        id: 1,
        over: {
          durationTimecode: '00:02:58:14',  // BXF plan
          durationMs: null,
        },
        ssdb: {
          materialStatus: 'found_duration_mismatch',
          ssdbDurationTimecode: '00:02:58:15',  // farklı MAM süresi
          ssdbDurationFrames: 4465,
          provysDurationFrames: 4464,
        },
      }]);
      const durCell = (fixture.nativeElement as HTMLElement)
        .querySelector('tbody tr.row td.col-dur')?.textContent?.trim();
      expect(durCell).toBe('00:02:58:14');  // BXF değeri, MAM değil
    });
  });
});
