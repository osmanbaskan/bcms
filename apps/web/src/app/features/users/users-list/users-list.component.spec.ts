import { TestBed, ComponentFixture } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';

import {
  NewUserDialogComponent,
  formatUserApiError,
} from './users-list.component';
import { ApiService } from '../../../core/services/api.service';

describe('NewUserDialogComponent', () => {
  let fixture: ComponentFixture<NewUserDialogComponent>;
  let component: NewUserDialogComponent;
  let api:       jasmine.SpyObj<ApiService>;
  let dialogRef: jasmine.SpyObj<MatDialogRef<NewUserDialogComponent>>;

  beforeEach(() => {
    api       = jasmine.createSpyObj('ApiService', ['post']);
    dialogRef = jasmine.createSpyObj('MatDialogRef', ['close']);
    const snack = jasmine.createSpyObj('MatSnackBar', ['open']);

    TestBed.configureTestingModule({
      imports:   [NewUserDialogComponent, NoopAnimationsModule],
      providers: [
        { provide: ApiService,     useValue: api },
        { provide: MatDialogRef,   useValue: dialogRef },
        { provide: MatSnackBar,    useValue: snack },
      ],
    });

    fixture = TestBed.createComponent(NewUserDialogComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => fixture.destroy());

  describe('canSave — backend Zod schema paritesi', () => {
    it('empty form → false', () => {
      expect(component.canSave()).toBeFalse();
    });

    it('grup seçilmedi → false (zod groups.min(1))', () => {
      component.f.username = 'ali.kaya';
      component.f.email    = 'ali@example.com';
      component.f.password = 'pass12';
      expect(component.canSave()).toBeFalse(); // grup yok
    });

    it('şifre 5 karakter → false (min 6 sınırı altı)', () => {
      component.f.username = 'ali.kaya';
      component.f.email    = 'ali@example.com';
      component.f.password = 'abcde'; // 5 karakter
      component.toggleGroup('Ses', true);
      expect(component.canSave()).toBeFalse();
    });

    it('şifre 6 karakter → true (sınır)', () => {
      component.f.username = 'ali.kaya';
      component.f.email    = 'ali@example.com';
      component.f.password = 'abcdef'; // 6 karakter
      component.toggleGroup('Ses', true);
      expect(component.canSave()).toBeTrue();
    });

    it('username Türkçe karakter içeriyor → false (zod regex)', () => {
      component.f.username = 'çağrı';
      component.f.email    = 'cagri@example.com';
      component.f.password = 'pass12';
      component.toggleGroup('Ses', true);
      expect(component.canSave()).toBeFalse();
    });

    it('username 2 karakter → false (min 3)', () => {
      component.f.username = 'ab';
      component.f.email    = 'ab@example.com';
      component.f.password = 'pass12';
      component.toggleGroup('Ses', true);
      expect(component.canSave()).toBeFalse();
    });

    it('email format bozuk → false', () => {
      component.f.username = 'ali.kaya';
      component.f.email    = 'not-an-email';
      component.f.password = 'pass12';
      component.toggleGroup('Ses', true);
      expect(component.canSave()).toBeFalse();
    });

    it('tüm alanlar geçerli + 1 grup → true', () => {
      component.f.username = 'ali.kaya';
      component.f.email    = 'ali@example.com';
      component.f.password = 'pass12';
      component.toggleGroup('Ses', true);
      expect(component.canSave()).toBeTrue();
    });
  });

  describe('save — error mapping', () => {
    it('Zod 400 issues → "groups: ... · password: ..." formatında errorMsg', () => {
      api.post.and.returnValue(throwError(() => new HttpErrorResponse({
        status: 400,
        error: {
          statusCode: 400, error: 'Bad Request', message: 'Validation failed',
          issues: [
            { code: 'too_small', path: ['groups'],   message: 'En az bir grup seçilmeli' },
            { code: 'too_small', path: ['password'], message: 'Şifre en az 6 karakter olmalı' },
          ],
        },
      })));
      component.f.username = 'ali.kaya';
      component.f.email    = 'ali@example.com';
      component.f.password = 'pass12';
      component.toggleGroup('Ses', true);
      component.save();
      expect(component.errorMsg()).toContain('groups: En az bir grup seçilmeli');
      expect(component.errorMsg()).toContain('password: Şifre en az 6 karakter olmalı');
    });

    it('Keycloak duplicate → errorMessage gösterilir', () => {
      api.post.and.returnValue(throwError(() => new HttpErrorResponse({
        status: 409,
        error: { statusCode: 409, message: 'Kullanıcı oluşturulamadı: {"errorMessage":"User exists with same username"}' },
      })));
      component.f.username = 'duplicate';
      component.f.email    = 'dup@example.com';
      component.f.password = 'pass12';
      component.toggleGroup('Ses', true);
      component.save();
      expect(component.errorMsg()).toContain('User exists');
    });

    it('success → dialogRef.close(true)', () => {
      api.post.and.returnValue(of({ id: 'abc', username: 'ali.kaya' }));
      component.f.username = 'ali.kaya';
      component.f.email    = 'ali@example.com';
      component.f.password = 'pass12';
      component.toggleGroup('Ses', true);
      component.save();
      expect(dialogRef.close).toHaveBeenCalledWith(true);
    });
  });
});

describe('formatUserApiError', () => {
  it('issues array → "path: message" satırları "·" ile birleşir', () => {
    const out = formatUserApiError({
      error: {
        message: 'Validation failed',
        issues: [
          { path: ['groups'],   message: 'En az bir grup seçilmeli' },
          { path: ['password'], message: 'Şifre en az 6 karakter olmalı' },
        ],
      },
    });
    expect(out).toBe('groups: En az bir grup seçilmeli · password: Şifre en az 6 karakter olmalı');
  });

  it('issues yok, message var → message dönülür', () => {
    expect(formatUserApiError({ error: { message: 'Bir hata oldu' } })).toBe('Bir hata oldu');
  });

  it('Keycloak errorMessage stream → onu dönülür', () => {
    expect(formatUserApiError({ error: { errorMessage: 'User exists with same email' } }))
      .toBe('User exists with same email');
  });

  it('string body → trim ile dönülür', () => {
    expect(formatUserApiError({ error: '  raw body  ' })).toBe('raw body');
  });

  it('bilinmeyen shape → fallback', () => {
    expect(formatUserApiError(undefined)).toBe('Kullanıcı oluşturulamadı');
    expect(formatUserApiError({}, 'X')).toBe('X');
  });
});
