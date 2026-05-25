import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ProvysChannelPanelComponent } from './provys-channel-panel.component';
import { ProvysService } from './provys.service';
import { PROVYS_CATEGORY_STYLES, type ProvysItemDto } from './provys.types';

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

  describe('Not (userNote) editable kolonu', () => {
    it('header artık "Tür" değil "Not"', () => {
      fake.setItems([makeItem({ id: 1, dcCode: 'DC00041439' })]);
      fixture.detectChanges();
      const headers = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('thead th'),
      ).map((th) => th.textContent?.trim());
      expect(headers).toContain('Not');
      expect(headers).not.toContain('Tür');
    });

    it('mevcut userNote input value\'sunda görünür', () => {
      fake.setItems([makeItem({ id: 1, userNote: 'kontrol' })]);
      fixture.detectChanges();
      const input = (fixture.nativeElement as HTMLElement)
        .querySelector('tbody tr.row td.col-note input.note-input') as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.value).toBe('kontrol');
    });

    it('input blur servisi PATCH ile çağırır (değer değiştiyse)', async () => {
      fake.setItems([makeItem({ id: 7, userNote: '' })]);
      fixture.detectChanges();
      const input = (fixture.nativeElement as HTMLElement)
        .querySelector('tbody tr.row td.col-note input.note-input') as HTMLInputElement;
      input.value = 'yeni not';
      input.dispatchEvent(new Event('blur'));
      await fixture.whenStable();
      expect(fake.updateNoteCalls.length).toBe(1);
      expect(fake.updateNoteCalls[0]).toEqual(jasmine.objectContaining({ id: 7, note: 'yeni not' }));
    });

    it('input blur değer aynıysa PATCH yapmaz', async () => {
      fake.setItems([makeItem({ id: 9, userNote: 'aynı' })]);
      fixture.detectChanges();
      const input = (fixture.nativeElement as HTMLElement)
        .querySelector('tbody tr.row td.col-note input.note-input') as HTMLInputElement;
      input.value = 'aynı';
      input.dispatchEvent(new Event('blur'));
      await fixture.whenStable();
      expect(fake.updateNoteCalls.length).toBe(0);
    });

    it('PATCH hatası aria-invalid set eder', async () => {
      fake.updateNoteShouldThrow = true;
      fake.setItems([makeItem({ id: 3, userNote: null })]);
      fixture.detectChanges();
      const input = (fixture.nativeElement as HTMLElement)
        .querySelector('tbody tr.row td.col-note input.note-input') as HTMLInputElement;
      input.value = 'deneme';
      input.dispatchEvent(new Event('blur'));
      await fixture.whenStable();
      fixture.detectChanges();
      expect(input.getAttribute('aria-invalid')).toBe('true');
    });
  });
});
