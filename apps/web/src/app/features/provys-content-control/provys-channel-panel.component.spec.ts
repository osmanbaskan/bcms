import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ProvysChannelPanelComponent } from './provys-channel-panel.component';
import { ProvysService } from './provys.service';
import { PROVYS_CATEGORY_STYLES, type ProvysItemDto } from './provys.types';

function makeItem(over: Partial<ProvysItemDto>): ProvysItemDto {
  return {
    id: 1,
    channelSlug: 'beinsports1' as any,
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
    sourceFile: '/f.bxf',
    updatedAt: '2026-05-22T18:00:00Z',
    ...over,
  };
}

class FakeProvysService {
  private readonly store = signal<ProvysItemDto[]>([]);
  private readonly seen = signal(false);
  itemsFor() { return this.store.asReadonly(); }
  hasReceived() { return this.seen(); }

  setItems(items: ProvysItemDto[]) {
    this.seen.set(true);
    this.store.set(items);
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
    expect(el.textContent).toContain('akış kaydı yok');
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
});
