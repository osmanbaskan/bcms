import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { KeycloakService } from 'keycloak-angular';
import { getPublicAppOrigin } from '../../core/auth/public-origin';

/**
 * ORTA-FE-2.6.1 fix (2026-05-04): /login-error sayfası.
 * auth.guard hata yolunda buraya yönlendiriyor; kullanıcı oturum açma
 * sürecinde bir sorun yaşadığında ne yapacağını netleştir.
 */
@Component({
  selector: 'app-login-error',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  template: `
    <div class="le-root">
      <div class="le-card">
        <mat-icon class="le-icon material-icons-outlined">error_outline</mat-icon>
        <h1>Oturum açılamadı</h1>
        <p>
          Kimlik doğrulama sunucusuna ulaşılamıyor veya oturumunuz geçersiz.
          Lütfen birkaç saniye sonra tekrar deneyin. Sorun devam ederse
          sistem yöneticinize başvurun.
        </p>
        <div class="le-actions">
          <button class="btn-primary" type="button" (click)="retry()">Yeniden Dene</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .le-root {
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: var(--bp-bg-1);
      color: var(--bp-fg-1);
      padding: 24px;
    }
    .le-card {
      max-width: 480px;
      width: 100%;
      background: var(--bp-bg-2);
      border: 1px solid var(--bp-line-2);
      border-radius: var(--bp-r-lg);
      padding: 32px;
      text-align: center;
      box-shadow: var(--bp-shadow-md);
    }
    .le-icon {
      font-size: 48px !important;
      width: 48px !important;
      height: 48px !important;
      color: var(--bp-status-live);
      margin-bottom: 12px;
    }
    h1 {
      font-size: 20px;
      margin: 0 0 12px;
      color: var(--bp-fg-1);
    }
    p {
      font-size: 13.5px;
      color: var(--bp-fg-2);
      line-height: 1.6;
      margin: 0 0 20px;
    }
    .le-actions { display: flex; justify-content: center; }
    .btn-primary {
      background: var(--bp-purple-500);
      color: #fff;
      border: 0;
      padding: 10px 20px;
      border-radius: var(--bp-r-md);
      font-size: 13px;
      font-weight: var(--bp-fw-medium);
      cursor: pointer;
      transition: background var(--bp-dur-fast);
    }
    .btn-primary:hover { background: var(--bp-purple-600); }
  `],
})
export class LoginErrorComponent {
  constructor(private router: Router, private keycloak: KeycloakService) {}

  async retry(): Promise<void> {
    try {
      await this.keycloak.login({ redirectUri: getPublicAppOrigin() });
    } catch {
      // Tekrar fail ederse anasayfaya geri dön; en azından tekrar guard'a
      // takılır ve aynı ekran tekrar görünür.
      this.router.navigateByUrl('/');
    }
  }
}
