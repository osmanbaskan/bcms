import { Component, OnInit } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { CommonModule } from '@angular/common';
import { KeycloakService } from 'keycloak-angular';
import { environment } from '../environments/environment';

interface NavItem {
  label: string;
  icon:  string;
  route: string;
  roles: string[];
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatSidenavModule,
    MatToolbarModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
  ],
  template: `
    <mat-sidenav-container class="sidenav-container">
      <mat-sidenav #sidenav mode="side" opened class="sidenav">
        <div class="sidenav-header">
          <mat-icon>broadcast_on_personal</mat-icon>
          <span>BCMS</span>
        </div>
        <mat-nav-list>
          @for (item of visibleNavItems; track item.route) {
            <a mat-list-item [routerLink]="item.route" routerLinkActive="active-link">
              <mat-icon matListItemIcon>{{ item.icon }}</mat-icon>
              <span matListItemTitle>{{ item.label }}</span>
            </a>
          }
        </mat-nav-list>
      </mat-sidenav>

      <mat-sidenav-content>
        <mat-toolbar color="primary">
          <button mat-icon-button (click)="sidenav.toggle()">
            <mat-icon>menu</mat-icon>
          </button>
          <span class="toolbar-title">Broadcast Content Management</span>
          <span class="spacer"></span>
          <span class="user-name">{{ username }}</span>
          <button mat-icon-button (click)="logout()" title="Çıkış yap">
            <mat-icon>logout</mat-icon>
          </button>
        </mat-toolbar>

        <main class="main-content">
          <router-outlet />
        </main>
      </mat-sidenav-content>
    </mat-sidenav-container>
  `,
  styles: [`
    .sidenav-container { height: 100%; }
    .sidenav { width: 220px; background: #1e1e2e; }
    .sidenav-header {
      display: flex; align-items: center; gap: 8px;
      padding: 16px; font-size: 1.2rem; font-weight: 600;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .active-link { background: rgba(255,255,255,0.1) !important; }
    .toolbar-title { margin-left: 8px; }
    .spacer { flex: 1; }
    .user-name { font-size: 0.85rem; opacity: 0.8; margin-right: 8px; }
    .main-content { padding: 24px; }
  `],
})
export class AppComponent implements OnInit {
  username = '';
  userRoles: string[] = [];

  readonly navItems: NavItem[] = [
    { label: 'Yayın Planı',    icon: 'calendar_today',     route: '/schedules',  roles: ['admin','planner','scheduler','viewer'] },
    { label: 'Rezervasyonlar', icon: 'book_online',         route: '/bookings',   roles: ['admin','planner','scheduler','viewer'] },
    { label: 'Kanallar',       icon: 'live_tv',             route: '/channels',   roles: ['admin'] },
    { label: 'Ingest',         icon: 'cloud_upload',        route: '/ingest',     roles: ['admin','ingest_operator'] },
    { label: 'Monitoring',     icon: 'monitor_heart',       route: '/monitoring', roles: ['admin','monitoring','viewer'] },
    { label: 'MCR',            icon: 'videocam',            route: '/mcr',        roles: ['admin','monitoring'] },
  ];

  get visibleNavItems(): NavItem[] {
    return this.navItems.filter((item) =>
      item.roles.some((r) => this.userRoles.includes(r)),
    );
  }

  constructor(private keycloak: KeycloakService) {}

  async ngOnInit() {
    if (environment.skipAuth) {
      this.username  = 'dev-admin';
      this.userRoles = ['admin'];
      return;
    }
    const profile = await this.keycloak.loadUserProfile();
    this.username  = profile.username ?? '';
    this.userRoles = this.keycloak.getUserRoles();
  }

  logout() {
    if (environment.skipAuth) return;
    this.keycloak.logout(window.location.origin);
  }
}
