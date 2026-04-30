import { Component, OnInit, signal, computed, ChangeDetectorRef } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { CommonModule } from '@angular/common';
import { KeycloakService } from 'keycloak-angular';
import { environment } from '../environments/environment';
import { getPublicAppOrigin } from './core/auth/public-origin';
import { GROUP } from '@bcms/shared';

interface NavItem {
  label:      string;
  icon:       string;
  route:      string;
  groups:     string[];
  exactMatch?: boolean;
  children?:  NavItem[];
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
          @for (item of visibleNavItems(); track item.route) {
            @if (item.children?.length) {
              <div class="nav-group-label">
                <mat-icon class="nav-group-icon">{{ item.icon }}</mat-icon>
                <span>{{ item.label }}</span>
              </div>
              @for (child of item.children; track child.route) {
                <a mat-list-item [routerLink]="child.route" routerLinkActive="active-link"
                   (click)="sidenav.close()"
                   [routerLinkActiveOptions]="{ exact: !!child.exactMatch }">
                  <mat-icon matListItemIcon class="child-icon">{{ child.icon }}</mat-icon>
                  <span matListItemTitle>{{ child.label }}</span>
                </a>
              }
            } @else {
              <a mat-list-item [routerLink]="item.route" routerLinkActive="active-link" (click)="sidenav.close()">
                <mat-icon matListItemIcon>{{ item.icon }}</mat-icon>
                <span matListItemTitle>{{ item.label }}</span>
              </a>
            }
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
    .sidenav { width: 220px; background: #1e1e2e; color: rgba(255,255,255,0.87); }
    .sidenav-header {
      display: flex; align-items: center; gap: 8px;
      padding: 16px; font-size: 1.2rem; font-weight: 600;
      color: #fff;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .sidenav a { color: rgba(255,255,255,0.87) !important; }
    .active-link { background: rgba(255,255,255,0.1) !important; }
    .nav-group-label {
      display:flex; align-items:center; gap:8px;
      padding:10px 16px 4px;
      font-size:0.72rem; font-weight:700; letter-spacing:0.08em;
      text-transform:uppercase; color:rgba(255,255,255,0.4);
    }
    .nav-group-icon { font-size:16px; width:16px; height:16px; }
    .child-icon { font-size:18px !important; }
    .toolbar-title { margin-left: 8px; }
    .spacer { flex: 1; }
    .user-name { font-size: 0.85rem; opacity: 0.8; margin-right: 8px; }
    .main-content { padding: 24px; }
  `],
})
export class AppComponent implements OnInit {
  username = '';
  userGroups = signal<string[]>([]);

  readonly navItems: NavItem[] = [
    { label: 'Canlı Yayın Plan Listesi', icon: 'list', route: '/schedules', groups: [], exactMatch: true },
    { label: 'Ekip iş takip',        icon: 'book_online',    route: '/bookings',               groups: [] },
    { label: 'Raporlama',             icon: 'summarize',      route: '/schedules/reporting',    groups: [GROUP.Admin] },
    { label: 'Stüdyo Planı',          icon: 'event_seat',     route: '/studio-plan',            groups: [] },
    { label: 'Haftalık Shift',        icon: 'groups',         route: '/weekly-shift',           groups: [] },
    { label: 'Provys İçerik Kontrol', icon: 'fact_check',     route: '/provys-content-control', groups: [GROUP.Admin] },
    { label: 'Kanallar',              icon: 'live_tv',        route: '/channels',               groups: [GROUP.Admin] },
    { label: 'Ingest',                icon: 'cloud_upload',   route: '/ingest',                 groups: [GROUP.Admin, GROUP.Ingest] },
    { label: 'Monitoring',            icon: 'monitor_heart',  route: '/monitoring',             groups: [GROUP.Admin] },
    { label: 'MCR',                   icon: 'videocam',       route: '/mcr',                    groups: [GROUP.Admin, GROUP.MCR] },
    { label: 'Kullanıcılar',          icon: 'manage_accounts',route: '/users',                  groups: [GROUP.SystemEng] },
    { label: 'Ayarlar',               icon: 'settings',       route: '/settings',               groups: [GROUP.SystemEng] },
    { label: 'Audit Logları',         icon: 'manage_search',  route: '/audit-logs',             groups: [GROUP.SystemEng] },
    { label: 'Dökümanlar',            icon: 'description',    route: '/documents',              groups: [GROUP.SystemEng] },
  ];

  visibleNavItems = computed(() => {
    const groups = this.userGroups();
    return this.navItems
      .map((item) => {
        const children = item.children?.filter(
          (child) => child.groups.length === 0 || child.groups.some((g) => groups.includes(g)),
        );
        return { ...item, children };
      })
      .filter((item) =>
        item.groups.length === 0 || item.groups.some((g) => groups.includes(g)) || item.children?.length,
      );
  });

  constructor(private keycloak: KeycloakService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    if (environment.skipAuth) {
      this.username = 'dev-admin';
      this.userGroups.set([GROUP.SystemEng]);
      return;
    }
    // tokenParsed'dan username ve grupları oku — network çağrısı gerektirmez
    const kc = this.keycloak.getKeycloakInstance();
    const parsed: any = kc?.tokenParsed ?? {};
    this.username = parsed['preferred_username'] ?? '';
    const groups: string[] = parsed?.groups ?? [];
    this.userGroups.set(groups.includes(GROUP.Admin) ? Array.from(new Set([...groups, GROUP.SystemEng])) : groups);
    this.cdr.detectChanges();
  }

  logout() {
    if (environment.skipAuth) return;
    this.keycloak.logout(getPublicAppOrigin());
  }
}
