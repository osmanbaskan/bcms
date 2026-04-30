import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { KeycloakService } from 'keycloak-angular';
import { AuthGuard } from './auth.guard';

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let keycloakSpy: jasmine.SpyObj<KeycloakService>;
  let routerSpy: jasmine.SpyObj<Router>;

  beforeEach(() => {
    keycloakSpy = jasmine.createSpyObj('KeycloakService', ['login', 'getKeycloakInstance']);
    keycloakSpy.getKeycloakInstance.and.returnValue({
      tokenParsed: { groups: ['Tekyon'] },
    } as any);
    routerSpy = jasmine.createSpyObj('Router', ['parseUrl']);
    routerSpy.parseUrl.and.returnValue(new UrlTree());

    TestBed.configureTestingModule({
      providers: [
        AuthGuard,
        { provide: KeycloakService, useValue: keycloakSpy },
        { provide: Router, useValue: routerSpy },
      ],
    });
    guard = TestBed.inject(AuthGuard);
  });

  it('Admin grubu varsa erişime izin vermeli', async () => {
    keycloakSpy.getKeycloakInstance.and.returnValue({
      tokenParsed: { groups: ['Admin'] },
    } as any);
    (guard as any).authenticated = true;
    const result = await guard.isAccessAllowed({ data: { groups: ['Booking'] } } as any);
    expect(result).toBeTrue();
  });

  it('Gerekli gruplar yoksa schedules sayfasına yönlendirmeli', async () => {
    keycloakSpy.getKeycloakInstance.and.returnValue({
      tokenParsed: { groups: ['Tekyon'] },
    } as any);
    (guard as any).authenticated = true;
    await guard.isAccessAllowed({ data: { groups: ['Admin'] } } as any);
    expect(routerSpy.parseUrl).toHaveBeenCalledWith('/schedules');
  });

  it('Auth değilse login çağırmalı ve false dönmeli', async () => {
    keycloakSpy.login.and.resolveTo();
    (guard as any).authenticated = false;
    const result = await guard.isAccessAllowed({ data: {} } as any);
    expect(keycloakSpy.login).toHaveBeenCalled();
    expect(result).toBeFalse();
  });

  it('Login hata verirse login-error yönlendirmeli', async () => {
    keycloakSpy.login.and.rejectWith(new Error('Keycloak down'));
    (guard as any).authenticated = false;
    await guard.isAccessAllowed({ data: {} } as any);
    expect(routerSpy.parseUrl).toHaveBeenCalledWith('/login-error');
  });
});
