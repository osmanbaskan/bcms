import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { of } from 'rxjs';
import { SettingsComponent } from './settings.component';
import { ApiService } from '../../core/services/api.service';

/**
 * Settings page render smoke. 2026-06-02: sol-menü bölümlü düzene geçildi —
 * Bağlantılar (varsayılan) / Kayıt Portları / Lig-İçerik. OPTA & Manuel Lig
 * kartları artık 'leagues' bölümünde; testler bölümü değiştirir.
 *
 * Permission gating route-level (AuthGuard + data.groups); kart her zaman
 * render edilir, yetkisiz tıklamada AuthGuard reddeder.
 */
describe('SettingsComponent', () => {
  beforeEach(async () => {
    const apiSpy = jasmine.createSpyObj('ApiService', ['get', 'post', 'put']);
    apiSpy.get.and.callFake((path: string) => {
      if (path === '/settings/opta-smb') {
        return of({ share: '', mountPoint: '', subdir: '', username: '', domain: '' });
      }
      if (path === '/ingest/recording-ports/admin') {
        return of([]);
      }
      if (path === '/avid/settings') {
        return of({
          interplayUrl: '', avidUser: '', avidPassword: '', workspace: '',
          clouduxUrl: '', clouduxRealm: '', clouduxToken: '', updatedBy: null, updatedAt: null,
        });
      }
      if (path === '/watchers') {
        return of({
          reachable: true,
          watchers: [
            { key: 'provys', label: 'BXF / Provys Watcher', service: 'provys-watcher',
              watchFolder: '/app/tmp/provys', usePolling: false, pollIntervalMs: 30000,
              debounceMs: 1500, concurrency: 3, status: 'alive', ageMs: 1200,
              lastTickAt: '2026-06-02T15:00:00.000Z', folderExists: true, watching: true },
            { key: 'asrun', label: 'ASRUN Watcher', service: 'asrun-watcher',
              watchFolder: '/app/tmp/asrun', usePolling: true, pollIntervalMs: 30000,
              debounceMs: 1500, concurrency: 3, status: 'dead', ageMs: 600000,
              lastTickAt: null, folderExists: false, watching: false },
          ],
        });
      }
      return of({});
    });
    apiSpy.put.and.returnValue(of({}));
    apiSpy.post.and.returnValue(of({}));

    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: [
        provideRouter([]),
        provideAnimationsAsync(),
        { provide: ApiService, useValue: apiSpy },
      ],
    }).compileComponents();
  });

  it('sol menüde 5 bölüm linki render edilir', () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const navIds = Array.from(host.querySelectorAll('.settings-nav [data-section]'))
      .map((b) => b.getAttribute('data-section'));
    expect(navIds).toEqual(['connections', 'haber', 'ports', 'leagues', 'notifications']);
  });

  it('Bağlantılar (varsayılan) — Avid kartı IPWS + Cloud UX alanlarıyla render edilir', () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.textContent ?? '';
    expect(text).toContain('OPTA SMB Bağlantısı');
    expect(text).toContain('Avid Bağlantı Ayarları');
    expect(text).toContain('Interplay PAM URL');
    expect(text).toContain('Cloud UX URL');
  });

  it('Bağlantılar — BXF/Provys + ASRUN izleyici kartları durum rozetiyle render edilir', () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.textContent ?? '';
    expect(text).toContain('BXF / Provys Watcher');
    expect(text).toContain('ASRUN Watcher');
    // izlenen klasör artık editable input (2 adet); değer ngModel taslağında
    // (DOM value async flush'lanır, model'i kontrol ediyoruz)
    expect(host.querySelectorAll('.folder-field input').length).toBe(2);
    expect(fixture.componentInstance.watcherFolderDraft['provys']).toBe('/app/tmp/provys');
    expect(fixture.componentInstance.watcherFolderDraft['asrun']).toBe('/app/tmp/asrun');
    // durum rozetleri: provys alive → "Çalışıyor", asrun dead → "Yanıt yok"
    const badges = Array.from(host.querySelectorAll('.wstatus')).map((b) => b.getAttribute('data-st'));
    expect(badges).toContain('alive');
    expect(badges).toContain('dead');
    // asrun folderExists=false → "bulunamadı" uyarısı
    expect(text).toContain('bulunamadı');
  });

  it('Kayıt Portları bölümü — port chip ızgarası render edilir', () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    fixture.componentInstance.section.set('ports');
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect((host.textContent ?? '')).toContain('Kayıt Portları');
    // boş port listesi → bileşen en az 1 port garanti eder (loadPorts fallback)
    expect(host.querySelectorAll('.port-chip').length).toBeGreaterThan(0);
  });

  it('Lig / İçerik bölümü — OPTA Lig kartı + /admin/opta-competitions linki', () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    fixture.componentInstance.section.set('leagues');
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect((host.textContent ?? '')).toContain('OPTA Lig / Turnuva Görünürlüğü');

    const anchors = Array.from(host.querySelectorAll('a[routerLink]'));
    const optaLink = anchors.find((a) => a.getAttribute('routerLink') === '/admin/opta-competitions');
    expect(optaLink).toBeTruthy();
    expect(optaLink!.textContent).toContain('Aç');
  });

  it('Lig / İçerik bölümü — Manuel Lig kartı + /admin/manual-leagues linki', () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    fixture.componentInstance.section.set('leagues');
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.textContent ?? '';
    expect(text).toContain('Manuel Lig Yönetimi');
    expect(text).toContain('Manuel girişte seçilebilir ligleri yönetin');

    const anchors = Array.from(host.querySelectorAll('a[routerLink]'));
    const manualLink = anchors.find((a) => a.getAttribute('routerLink') === '/admin/manual-leagues');
    expect(manualLink).toBeTruthy();
    expect(manualLink!.textContent).toContain('Aç');
  });
});
