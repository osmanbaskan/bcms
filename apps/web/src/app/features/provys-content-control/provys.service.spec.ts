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

// Minimal signal stub (avoids importing core/signal during test bootstrap noise).
function signalFake<T>(initial: T) {
  let value = initial;
  const fn: any = () => value;
  fn.set = (v: T) => { value = v; };
  fn.update = (m: (v: T) => T) => { value = m(value); };
  fn.asReadonly = () => fn;
  return fn;
}

describe('ProvysService', () => {
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

  it('exposes a separate signal store per channel', () => {
    for (const ch of PROVYS_CHANNELS) {
      const sig = service.itemsFor(ch.slug);
      expect(sig()).toEqual([]);
    }
  });

  it('throws on unknown channel', () => {
    expect(() => service.itemsFor('zzz' as any)).toThrow();
  });

  it('loadInitial issues one GET per channel and stores results', async () => {
    const promise = service.loadInitial();

    for (const ch of PROVYS_CHANNELS) {
      const req = http.expectOne(`${environment.apiUrl}/provys/items?channel=${ch.slug}`);
      const items: ProvysItemDto[] = [{
        id: 1, channelSlug: ch.slug as any, eventId: 'E1', sequence: 0,
        startAt: '2026-05-22T18:00:00Z', durationMs: 30000, title: 'T',
        rawKind: 'COMMERCIAL', category: 'REKLAM',
        sourceFile: '/x.bxf', updatedAt: '2026-05-22T18:00:00Z',
      }];
      req.flush(items);
    }

    await promise;

    for (const ch of PROVYS_CHANNELS) {
      expect(service.itemsFor(ch.slug)().length).toBe(1);
      expect(service.itemsFor(ch.slug)()[0].channelSlug).toBe(ch.slug);
      expect(service.hasReceived(ch.slug)).toBe(true);
    }
  });

  it('SSE update events route to the correct channel only', () => {
    service.ensureStreaming();

    const sample: ProvysItemDto[] = [{
      id: 99, channelSlug: 'beinhaber' as any, eventId: 'X', sequence: 0,
      startAt: '2026-05-22T19:00:00Z', durationMs: null, title: 'Haber',
      rawKind: 'LIVE', category: 'CANLI',
      sourceFile: '/x.bxf', updatedAt: '2026-05-22T19:00:00Z',
    }];

    fakeSse.emit({ type: 'snapshot', channel: 'beinhaber' as any, items: sample });

    expect(service.itemsFor('beinhaber' as any)()).toEqual(sample);
    expect(service.itemsFor('beinsports1' as any)()).toEqual([]);
  });

  it('heartbeat events do not mutate any channel', () => {
    service.ensureStreaming();
    fakeSse.emit({ type: 'heartbeat', ts: Date.now() });
    for (const ch of PROVYS_CHANNELS) {
      expect(service.itemsFor(ch.slug)()).toEqual([]);
    }
  });
});
