import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ProvysService } from './provys.service';
import { ProvysSseClient } from './provys-sse.client';
import { environment } from '../../../environments/environment';
import { PROVYS_CHANNELS, type ProvysItemDto, type ProvysStreamEvent } from './provys.types';

class FakeSseClient {
  private handler: ((ev: ProvysStreamEvent) => void) | null = null;
  readonly connected = (() => {
    const sig = signalFake(false);
    return sig.asReadonly();
  })();
  readonly lastError = (() => signalFake<string | null>(null).asReadonly())();

  connect(onEvent: (ev: ProvysStreamEvent) => void): () => void {
    this.handler = onEvent;
    return () => { this.handler = null; };
  }

  emit(event: ProvysStreamEvent) {
    this.handler?.(event);
  }
}

function signalFake<T>(initial: T) {
  let value = initial;
  const fn: any = () => value;
  fn.set = (v: T) => { value = v; };
  fn.update = (m: (v: T) => T) => { value = m(value); };
  fn.asReadonly = () => fn;
  return fn;
}

function makeItem(slug: string, scheduleDate: string, eventId = 'E1'): ProvysItemDto {
  return {
    id: 1, channelSlug: slug as any, scheduleDate,
    eventId, sequence: 0,
    startAt: `${scheduleDate}T18:00:00Z`, durationMs: 30000,
    startTimecode: null, durationTimecode: null, frameRate: null, dcCode: null,
    title: 'T', rawKind: null, category: 'PROGRAM',
    sourceFile: '/x.bxf', updatedAt: `${scheduleDate}T18:00:00Z`,
  };
}

describe('ProvysService (per-day snapshot)', () => {
  let service: ProvysService;
  let http: HttpTestingController;
  let fakeSse: FakeSseClient;

  beforeEach(() => {
    fakeSse = new FakeSseClient();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ProvysService,
        { provide: ProvysSseClient, useValue: fakeSse },
      ],
    });
    service = TestBed.inject(ProvysService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('exposes a separate signal store per channel; throws on unknown channel', () => {
    for (const ch of PROVYS_CHANNELS) {
      expect(service.itemsFor(ch.slug)()).toEqual([]);
    }
    expect(() => service.itemsFor('zzz' as any)).toThrow();
  });

  it('defaults activeDate to today (Istanbul) and loadInitial sends channel + date GETs', async () => {
    const today = service.activeDate();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const promise = service.loadInitial();
    for (const ch of PROVYS_CHANNELS) {
      const req = http.expectOne(`${environment.apiUrl}/provys/items?channel=${ch.slug}&date=${today}`);
      req.flush([makeItem(ch.slug, today)]);
    }
    await promise;

    for (const ch of PROVYS_CHANNELS) {
      expect(service.itemsFor(ch.slug)().length).toBe(1);
      expect(service.hasReceived(ch.slug)).toBe(true);
    }
  });

  it('setActiveDate updates activeDate, resets stores, and re-fetches per-channel', async () => {
    // 1. initial today
    const today = service.activeDate();
    const initial = service.loadInitial();
    for (const ch of PROVYS_CHANNELS) {
      http.expectOne(`${environment.apiUrl}/provys/items?channel=${ch.slug}&date=${today}`)
        .flush([makeItem(ch.slug, today)]);
    }
    await initial;
    expect(service.itemsFor('beinsports1' as any)().length).toBe(1);

    // 2. switch date
    const newDate = '2026-02-17';
    const next = service.setActiveDate(newDate);
    for (const ch of PROVYS_CHANNELS) {
      http.expectOne(`${environment.apiUrl}/provys/items?channel=${ch.slug}&date=${newDate}`)
        .flush([makeItem(ch.slug, newDate, 'NEW')]);
    }
    await next;

    expect(service.activeDate()).toBe(newDate);
    for (const ch of PROVYS_CHANNELS) {
      expect(service.itemsFor(ch.slug)()[0].eventId).toBe('NEW');
    }
  });

  it('SSE update for ACTIVE date is applied; OTHER days are ignored', () => {
    service.ensureStreaming();
    const active = service.activeDate();
    const sample = [makeItem('beinhaber', active, 'X')];

    // Active day → applied
    fakeSse.emit({ type: 'update', channel: 'beinhaber' as any, scheduleDate: active, items: sample });
    expect(service.itemsFor('beinhaber' as any)().length).toBe(1);

    // Different day → IGNORED (UI o günü göstermiyor)
    fakeSse.emit({
      type: 'update', channel: 'beinhaber' as any,
      scheduleDate: '2099-01-01', items: [makeItem('beinhaber', '2099-01-01', 'Y')],
    });
    expect(service.itemsFor('beinhaber' as any)().length).toBe(1);
    expect(service.itemsFor('beinhaber' as any)()[0].eventId).toBe('X');
  });

  it('loadAvailableDates calls /provys/dates and stores per-channel list', async () => {
    const promise = service.loadAvailableDates('beinsports1' as any);
    http.expectOne(`${environment.apiUrl}/provys/dates?channel=beinsports1`)
      .flush(['2026-02-18', '2026-02-17']);
    await promise;
    expect(service.availableDatesFor('beinsports1' as any)()).toEqual(['2026-02-18', '2026-02-17']);
  });

  it('heartbeat events do not mutate any channel', () => {
    service.ensureStreaming();
    fakeSse.emit({ type: 'heartbeat', ts: Date.now() });
    for (const ch of PROVYS_CHANNELS) {
      expect(service.itemsFor(ch.slug)()).toEqual([]);
    }
  });

  it('exportExcel issues GET /provys/export/excel with channel + date + includeProgramHeaders=false default', async () => {
    const promise = service.exportExcel('beinhaber' as any, '2026-05-22');
    const req = http.expectOne((r) => r.url === `${environment.apiUrl}/provys/export/excel`);
    expect(req.request.responseType).toBe('blob');
    expect(req.request.params.get('channel')).toBe('beinhaber');
    expect(req.request.params.get('date')).toBe('2026-05-22');
    expect(req.request.params.get('includeProgramHeaders')).toBe('false');
    // Tüm kategoriler default → categories param yok
    expect(req.request.params.get('categories')).toBeNull();
    req.flush(new Blob(['excel-bytes']));
    await promise;
  });

  it('exportPdf issues GET /provys/export/pdf with channel + date + includeProgramHeaders=false', async () => {
    const promise = service.exportPdf('beinsports1' as any, '2026-02-17');
    const req = http.expectOne((r) => r.url === `${environment.apiUrl}/provys/export/pdf`);
    expect(req.request.responseType).toBe('blob');
    expect(req.request.params.get('channel')).toBe('beinsports1');
    expect(req.request.params.get('date')).toBe('2026-02-17');
    expect(req.request.params.get('includeProgramHeaders')).toBe('false');
    req.flush(new Blob(['pdf-bytes']));
    await promise;
  });

  it('exportExcel attaches categories param when not all are selected (with headers off)', async () => {
    service.setSelectedCategories(new Set(['CANLI', 'PROGRAM']));
    const promise = service.exportExcel('beinhaber' as any, '2026-05-22');
    const req = http.expectOne((r) => r.url === `${environment.apiUrl}/provys/export/excel`);
    // PROVYS_CATEGORIES sırasıyla: REKLAM, KAMU_SPOTU, CANLI, PROGRAM, TANITIM, DIGER
    expect(req.request.params.get('categories')).toBe('CANLI,PROGRAM');
    expect(req.request.params.get('includeProgramHeaders')).toBe('false');
    req.flush(new Blob(['excel-bytes']));
    await promise;
  });

  it('exportExcel sends includeProgramHeaders=true when toggle is on', async () => {
    service.setShowProgramHeaders(true);
    const promise = service.exportExcel('beinhaber' as any, '2026-05-22');
    const req = http.expectOne((r) => r.url === `${environment.apiUrl}/provys/export/excel`);
    expect(req.request.params.get('includeProgramHeaders')).toBe('true');
    req.flush(new Blob(['excel-bytes']));
    await promise;
  });

  it('selectedCategories defaults to all categories; toggleCategory flips membership', () => {
    expect(service.selectedCategories().size).toBe(6);
    service.toggleCategory('REKLAM');
    expect(service.selectedCategories().has('REKLAM')).toBe(false);
    expect(service.selectedCategories().size).toBe(5);
    service.toggleCategory('REKLAM');
    expect(service.selectedCategories().has('REKLAM')).toBe(true);
  });

  it('filteredItemsFor default hides ProgramHeader rows; toggle ON keeps them', async () => {
    const today = service.activeDate();
    const items: ProvysItemDto[] = [
      { ...makeItem('beinhaber', today, 'HDR'), rawKind: 'ProgramHeader', category: 'PROGRAM', dcCode: null },
      { ...makeItem('beinhaber', today, 'CONTENT'), rawKind: 'Program', category: 'PROGRAM', dcCode: 'DC00042141' },
    ];
    const promise = service.loadInitial();
    for (const ch of PROVYS_CHANNELS) {
      const req = http.expectOne(`${environment.apiUrl}/provys/items?channel=${ch.slug}&date=${today}`);
      req.flush(ch.slug === 'beinhaber' ? items : []);
    }
    await promise;

    // Default: showProgramHeaders=false → HDR satırı gizli
    expect(service.filteredItemsFor('beinhaber' as any)().map((i) => i.eventId)).toEqual(['CONTENT']);

    service.setShowProgramHeaders(true);
    expect(service.filteredItemsFor('beinhaber' as any)().map((i) => i.eventId).sort()).toEqual(['CONTENT', 'HDR']);
  });

  it('filteredItemsFor returns the raw list when all categories are selected, filtered otherwise', async () => {
    // Setup: bir kanalda farklı kategoride 3 satır
    const today = service.activeDate();
    const items: ProvysItemDto[] = [
      { ...makeItem('beinhaber', today, 'A'), category: 'PROGRAM' },
      { ...makeItem('beinhaber', today, 'B'), category: 'REKLAM' },
      { ...makeItem('beinhaber', today, 'C'), category: 'CANLI' },
    ];
    const promise = service.loadInitial();
    for (const ch of PROVYS_CHANNELS) {
      const req = http.expectOne(`${environment.apiUrl}/provys/items?channel=${ch.slug}&date=${today}`);
      req.flush(ch.slug === 'beinhaber' ? items : []);
    }
    await promise;

    // 1) Tümü seçili — tüm 3 satır görünür
    expect(service.filteredItemsFor('beinhaber' as any)().length).toBe(3);

    // 2) Sadece PROGRAM seçili — 1 satır
    service.setSelectedCategories(new Set(['PROGRAM']));
    expect(service.filteredItemsFor('beinhaber' as any)().length).toBe(1);

    // 3) Hiçbir kategori seçili değil — 0 satır
    service.setSelectedCategories(new Set());
    expect(service.filteredItemsFor('beinhaber' as any)().length).toBe(0);
  });
});
