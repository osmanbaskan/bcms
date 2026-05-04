import {
  Component, OnInit, OnDestroy, signal, computed, ChangeDetectorRef,
  HostListener, inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, RouterLink, Router, NavigationEnd } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { Subscription, interval } from 'rxjs';
import { filter } from 'rxjs/operators';

import { KeycloakService } from 'keycloak-angular';
import { environment } from '../environments/environment';
import { getPublicAppOrigin } from './core/auth/public-origin';
import { GROUP } from '@bcms/shared';
import { CommandPaletteComponent, CommandItem } from './core/ui/command-palette.dialog';
import { AlertPopoverComponent, AlertItem } from './core/ui/alert-popover.component';

interface NavItem {
  label:       string;
  icon:        string;     // material outlined ikon adı
  route:       string;
  groups:      string[];
  exactMatch?: boolean;
  count?:      number | null;
  alert?:      boolean;
}

interface NavGroup {
  label: string;            // YAYIN | EKİP | YÖNETİM
  items: NavItem[];
}

/**
 * BCMS App Shell — beINport tasarımı (UI V2)
 * Sol mor gradient sidebar + üst header + page-content router-outlet.
 *
 * Pattern kaynağı: /home/ubuntu/website/beINport/Shell.jsx
 * Kapsam: KORUMA listesi memory'de — yetkiler, export, studio table, schedule headers değişmez.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    RouterLink,
    MatIconModule,
    MatDialogModule,
    AlertPopoverComponent,
  ],
  template: `
    <div class="root" [class.sidebar-collapsed]="sidebarCollapsed()">
      <!-- ─── Sidebar ───────────────────────────────────────────────────── -->
      <aside class="side" [class.collapsed]="sidebarCollapsed()">
        <div class="brand-wrap">
          <a class="brand-link" routerLink="/" [title]="sidebarCollapsed() ? 'beINport' : ''">
            <div class="brand">
              <span class="brand-be">be</span><span class="brand-in">IN</span><span class="brand-port">port</span>
            </div>
            <div class="brand-tag">WORKFLOW</div>
          </a>
          <button class="collapse-btn"
                  type="button"
                  (click)="toggleSidebar()"
                  [title]="sidebarCollapsed() ? 'Menüyü genişlet' : 'Menüyü küçült'">
            <mat-icon class="material-icons-outlined">{{ sidebarCollapsed() ? 'chevron_right' : 'chevron_left' }}</mat-icon>
          </button>
        </div>

        @for (group of visibleGroups(); track group.label; let isLast = $last) {
          <div class="section">
            <div class="section-label">{{ group.label }}</div>
            @for (item of group.items; track item.route) {
              <a class="item"
                 [class.active]="isItemActive(item)"
                 [routerLink]="item.route"
                 [title]="sidebarCollapsed() ? item.label : ''">
                <mat-icon class="material-icons-outlined ico">{{ item.icon }}</mat-icon>
                <span class="item-label">{{ item.label }}</span>
                @if (item.alert) { <span class="alert-dot"></span> }
                @if (item.count != null) { <span class="pill">{{ item.count }}</span> }
              </a>
            }
          </div>
          @if (!isLast) { <div class="divider"></div> }
        }

        <!-- ─── Sidebar user footer ────────────────────────────────────── -->
        <div class="user">
          <div class="avt">{{ initials() }}</div>
          <div class="user-meta">
            <div class="user-name">{{ username || 'Kullanıcı' }}</div>
            <div class="user-sub">{{ userSub() }}</div>
          </div>
          <button class="user-btn" (click)="logout()" title="Çıkış yap" type="button">
            <mat-icon class="material-icons-outlined">logout</mat-icon>
          </button>
        </div>
      </aside>

      <!-- ─── Main ──────────────────────────────────────────────────────── -->
      <main class="main">
        <!-- ─── Top header ────────────────────────────────────────────── -->
        <header class="top">
          <div class="search" (click)="openCommandPalette()" role="button" tabindex="0"
               (keydown.enter)="openCommandPalette()">
            <mat-icon class="material-icons-outlined search-ico">search</mat-icon>
            <span class="search-placeholder">Yayın, kanal, takım, port ara…</span>
            <span class="kbd">⌘K</span>
          </div>
          <div class="top-right">
            <span class="date-mono">{{ currentDate() }}</span>
            <button class="icon-btn"
                    [class.has-alert]="unackAlerts().length > 0"
                    (click)="toggleAlerts()"
                    type="button"
                    title="Uyarılar">
              <mat-icon class="material-icons-outlined">notifications</mat-icon>
              @if (unackAlerts().length > 0) {
                <span class="badge">{{ unackAlerts().length }}</span>
              }
            </button>
            <button class="icon-btn" type="button" title="Hatırlatıcı">
              <mat-icon class="material-icons-outlined">schedule</mat-icon>
            </button>
            <div class="t-divider"></div>
            <button class="btn-primary" (click)="openNewBroadcast()" type="button">
              + Yeni Yayın Kaydı
            </button>
          </div>

          <bp-alert-popover [open]="alertsOpen()" [alerts]="alerts()" (close)="alertsOpen.set(false)" />
        </header>

        <div class="body">
          <router-outlet />
        </div>
      </main>
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; }
    .root {
      display: flex;
      min-height: 100vh;
      background: var(--bp-bg-1);
      color: var(--bp-fg-1);
      font-family: var(--bp-font-sans);
    }

    /* ─── Sidebar ─────────────────────────────────────────────────────── */
    .side {
      width: var(--bp-sidebar-width);
      min-height: 100vh;
      background: var(--bp-sidebar-gradient);
      color: #fff;
      display: flex;
      flex-direction: column;
      padding: 20px 0 12px;
      position: sticky;
      top: 0;
      align-self: flex-start;
      height: 100vh;
      overflow-y: auto;
      flex-shrink: 0;
      transition: width var(--bp-dur-slow) var(--bp-ease);
    }
    .side.collapsed { width: 64px; }

    .brand-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px 18px 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.10);
      margin-bottom: 12px;
    }
    .brand-link {
      flex: 1;
      min-width: 0;
      text-decoration: none;
      display: block;
      color: #fff;
    }
    .collapse-btn {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      border-radius: var(--bp-r-sm);
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.10);
      color: rgba(255, 255, 255, 0.75);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background var(--bp-dur-fast), color var(--bp-dur-fast);
      padding: 0;
    }
    .collapse-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
    }
    .collapse-btn mat-icon {
      font-size: 16px !important;
      width: 16px !important;
      height: 16px !important;
    }
    .side.collapsed .brand-wrap {
      flex-direction: column;
      gap: 12px;
      padding: 0 8px 14px;
    }
    .side.collapsed .brand-link {
      width: 100%;
      text-align: center;
    }
    .side.collapsed .brand {
      font-size: 14px;
      justify-content: center;
    }
    .side.collapsed .brand-port { display: none; }
    .side.collapsed .brand-tag { display: none; }
    .brand {
      font-family: var(--bp-font-display);
      font-size: 26px;
      font-weight: var(--bp-fw-bold);
      letter-spacing: -0.025em;
      display: flex;
      align-items: baseline;
      gap: 1px;
    }
    .brand-be, .brand-in { color: #fff; }
    .brand-port { color: var(--bp-purple-200); font-weight: var(--bp-fw-regular); font-size: 16px; margin-left: 1px; }
    .brand-tag {
      font-size: 10px;
      letter-spacing: 0.18em;
      color: var(--bp-purple-200);
      margin-top: 6px;
      font-weight: var(--bp-fw-semibold);
    }

    .section { padding: 4px 12px; }
    .section-label {
      font-size: 10px;
      font-weight: var(--bp-fw-bold);
      letter-spacing: var(--bp-ls-label);
      color: rgba(255, 255, 255, 0.55);
      text-transform: uppercase;
      padding: 8px 12px 6px;
    }
    .item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 9px 12px;
      color: rgba(255, 255, 255, 0.78);
      font-size: 13.5px;
      border-radius: var(--bp-r-md);
      cursor: pointer;
      text-decoration: none;
      transition: background var(--bp-dur-fast) var(--bp-ease);
    }
    .item:hover { background: rgba(255, 255, 255, 0.08); }
    .item.active {
      background: rgba(255, 255, 255, 0.14);
      color: #fff;
    }
    .ico {
      width: 18px !important;
      height: 18px !important;
      font-size: 18px !important;
      opacity: 0.85;
      flex-shrink: 0;
    }
    .item-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pill {
      font-size: 10px;
      font-weight: var(--bp-fw-semibold);
      background: rgba(255, 255, 255, 0.18);
      color: #fff;
      padding: 2px 7px;
      border-radius: 8px;
    }
    .alert-dot {
      width: 8px;
      height: 8px;
      border-radius: 4px;
      background: var(--bp-status-live);
      box-shadow: 0 0 6px var(--bp-status-live);
    }
    .divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.10);
      margin: 12px 20px;
    }

    /* Collapsed sidebar — only icons visible */
    .side.collapsed .section { padding: 4px 6px; }
    .side.collapsed .section-label { display: none; }
    .side.collapsed .item {
      justify-content: center;
      padding: 9px 6px;
      gap: 0;
    }
    .side.collapsed .item-label { display: none; }
    .side.collapsed .pill { display: none; }
    .side.collapsed .alert-dot {
      position: absolute;
      top: 6px;
      right: 6px;
    }
    .side.collapsed .ico {
      font-size: 20px !important;
      width: 20px !important;
      height: 20px !important;
      opacity: 1;
    }
    .side.collapsed .item { position: relative; }
    .side.collapsed .divider { margin: 8px 12px; }
    .side.collapsed .user {
      flex-direction: column;
      gap: 6px;
      padding: 8px 6px;
      align-items: center;
      margin: auto 6px 6px;
    }
    .side.collapsed .user-meta { display: none; }

    .user {
      margin: auto 12px 12px;
      background: rgba(0, 0, 0, 0.20);
      border-radius: var(--bp-r-md);
      padding: 10px 12px;
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .avt {
      width: 32px;
      height: 32px;
      border-radius: 16px;
      background: #fff;
      color: var(--bp-purple-700);
      display: grid;
      place-items: center;
      font-size: 11px;
      font-weight: var(--bp-fw-bold);
      flex-shrink: 0;
    }
    .user-meta { flex: 1; min-width: 0; }
    .user-name {
      font-size: 13px;
      font-weight: var(--bp-fw-medium);
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .user-sub {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.65);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .user-btn {
      background: transparent;
      border: 0;
      color: rgba(255, 255, 255, 0.6);
      cursor: pointer;
      padding: 4px;
      border-radius: var(--bp-r-sm);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: color var(--bp-dur-fast);
    }
    .user-btn:hover { color: #fff; }
    .user-btn mat-icon { font-size: 16px !important; width: 16px !important; height: 16px !important; }

    /* ─── Main ────────────────────────────────────────────────────────── */
    .main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .top {
      position: sticky;
      top: 0;
      z-index: var(--bp-z-toolbar);
      height: var(--bp-toolbar-height);
      border-bottom: 1px solid var(--bp-line-2);
      display: flex;
      align-items: center;
      padding: 0 28px;
      gap: 16px;
      background: var(--bp-bg-1);
    }
    .search {
      flex: 1;
      max-width: 480px;
      display: flex;
      align-items: center;
      gap: 10px;
      background: var(--bp-bg-0);
      border: 1px solid var(--bp-line-2);
      border-radius: var(--bp-r-md);
      padding: 8px 12px;
      cursor: pointer;
      transition: border-color var(--bp-dur-fast);
    }
    .search:hover { border-color: var(--bp-line); }
    .search-ico {
      color: var(--bp-fg-3);
      font-size: 18px !important;
      width: 18px !important;
      height: 18px !important;
      opacity: 0.5;
    }
    .search-placeholder {
      flex: 1;
      color: var(--bp-fg-3);
      font-size: 13px;
    }
    .kbd {
      font-size: 10px;
      font-family: var(--bp-font-mono);
      color: var(--bp-fg-4);
      background: var(--bp-bg-2);
      border: 1px solid var(--bp-line-2);
      border-radius: 3px;
      padding: 1px 5px;
    }
    .top-right {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .date-mono {
      font-family: var(--bp-font-mono);
      font-size: 11.5px;
      color: var(--bp-fg-3);
    }
    .icon-btn {
      background: transparent;
      border: 1px solid var(--bp-line-2);
      color: var(--bp-fg-2);
      width: 36px;
      height: 36px;
      border-radius: var(--bp-r-md);
      cursor: pointer;
      position: relative;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: border-color var(--bp-dur-fast), color var(--bp-dur-fast);
    }
    .icon-btn:hover {
      color: var(--bp-fg-1);
      border-color: var(--bp-line);
    }
    .icon-btn.has-alert { border-color: rgba(239, 68, 68, 0.50); }
    .icon-btn mat-icon { font-size: 18px !important; width: 18px !important; height: 18px !important; }
    .badge {
      position: absolute;
      top: -4px;
      right: -4px;
      background: var(--bp-status-live);
      color: #fff;
      font-size: 9px;
      font-weight: var(--bp-fw-bold);
      border-radius: 8px;
      padding: 2px 5px;
      min-width: 14px;
      height: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .t-divider {
      width: 1px;
      height: 24px;
      background: var(--bp-line);
    }
    .btn-primary {
      background: var(--bp-purple-500);
      border: 0;
      color: #fff;
      padding: 9px 16px;
      border-radius: var(--bp-r-md);
      font-size: 13px;
      font-weight: var(--bp-fw-medium);
      cursor: pointer;
      font-family: inherit;
      transition: background var(--bp-dur-fast);
    }
    .btn-primary:hover { background: var(--bp-purple-600); }

    .body {
      flex: 1;
      min-width: 0;
    }

    /* ─── Responsive ──────────────────────────────────────────────────── */
    @media (max-width: 720px) {
      .top { padding: 0 16px; gap: 12px; }
      .search-placeholder { display: none; }
      .date-mono { display: none; }
    }
  `],
})
export class AppComponent implements OnInit, OnDestroy {
  private dialog = inject(MatDialog);
  private router = inject(Router);
  private keycloak = inject(KeycloakService);
  private cdr = inject(ChangeDetectorRef);

  username = '';
  userGroups = signal<string[]>([]);
  private currentUrl = signal('');
  private routerSub?: Subscription;
  private clockSub?: Subscription;

  alertsOpen = signal(false);

  /** Sidebar collapsed state (kullanıcı tercihi, localStorage'da kalıcı). */
  private readonly SIDEBAR_KEY = 'bp.sidebar.collapsed';
  sidebarCollapsed = signal<boolean>(this.readSidebarPref());

  private readSidebarPref(): boolean {
    try { return localStorage.getItem(this.SIDEBAR_KEY) === '1'; }
    catch { return false; }
  }

  toggleSidebar() {
    const next = !this.sidebarCollapsed();
    this.sidebarCollapsed.set(next);
    try { localStorage.setItem(this.SIDEBAR_KEY, next ? '1' : '0'); }
    catch { /* ignore */ }
  }

  /** Mock alerts — Aşama 1 placeholder. Aşama 2/3'te gerçek API'ye bağlanır. */
  alerts = signal<AlertItem[]>([
    { sev: 'warning',  msg: 'IRD-08 sinyal kaybı (3sn)', time: '19:38', port: 'IRD-08', src: 'monitor.live', ack: false },
    { sev: 'critical', msg: 'FIB-3 yedek port arızalı', time: '19:32', port: 'FIB-3', src: 'monitor.port', ack: false },
  ]);

  unackAlerts = computed(() => this.alerts().filter((a) => !a.ack));

  /** Üç-grup nav structure (Q1=B kararıyla) — tüm 14 sayfa dahil. */
  readonly navGroups: NavGroup[] = [
    {
      label: 'OPERASYON',
      items: [
        { label: 'Genel Bakış',       icon: 'dashboard',           route: '/dashboard',          groups: [], exactMatch: true },
        { label: 'Canlı Yayın Plan',  icon: 'play_circle',         route: '/schedules',          groups: [], exactMatch: true },
        { label: 'Stüdyo Planı',      icon: 'view_module',         route: '/studio-plan',        groups: [] },
        { label: 'Ingest',            icon: 'cloud_upload',        route: '/ingest',             groups: [GROUP.Admin, GROUP.Ingest] },
        { label: 'MCR',               icon: 'videocam',            route: '/mcr',                groups: [GROUP.Admin, GROUP.MCR] },
        { label: 'Monitoring',        icon: 'monitor_heart',       route: '/monitoring',         groups: [GROUP.Admin] },
        { label: 'Provys',            icon: 'fact_check',          route: '/provys-content-control', groups: [GROUP.Admin] },
      ],
    },
    {
      label: 'EKİP',
      items: [
        { label: 'Ekip İş Takip',     icon: 'people_outline',      route: '/bookings',           groups: [] },
        { label: 'Haftalık Shift',    icon: 'calendar_today',      route: '/weekly-shift',       groups: [] },
      ],
    },
    {
      label: 'YÖNETİM',
      items: [
        { label: 'Raporlama',         icon: 'bar_chart',           route: '/schedules/reporting',groups: [GROUP.Admin] },
        { label: 'Audit Logları',     icon: 'history',             route: '/audit-logs',         groups: [GROUP.SystemEng] },
        { label: 'Kanallar',          icon: 'tune',                route: '/channels',           groups: [GROUP.Admin] },
        { label: 'Kullanıcılar',      icon: 'manage_accounts',     route: '/users',              groups: [GROUP.SystemEng] },
        { label: 'Ayarlar',           icon: 'settings',            route: '/settings',           groups: [GROUP.SystemEng] },
        { label: 'Dökümanlar',        icon: 'description',         route: '/documents',          groups: [GROUP.SystemEng] },
      ],
    },
  ];

  /** RBAC filter — Admin bypass + group membership (mevcut visibleNavItems pattern). */
  visibleGroups = computed<NavGroup[]>(() => {
    const groups = this.userGroups();
    const isAdmin = groups.includes(GROUP.Admin);
    return this.navGroups
      .map((g) => ({
        label: g.label,
        items: g.items.filter(
          (it) => isAdmin || it.groups.length === 0 || it.groups.some((x) => groups.includes(x)),
        ),
      }))
      .filter((g) => g.items.length > 0);
  });

  initials = computed(() => {
    const name = (this.username || 'Kullanıcı').trim();
    return name.split(/\s+/).map((p) => p[0]?.toUpperCase() ?? '').join('').slice(0, 2) || 'U';
  });

  userSub = computed(() => {
    const groups = this.userGroups();
    if (groups.length === 0) return 'misafir';
    if (groups.includes(GROUP.Admin)) return 'Admin · tam yetki';
    return groups.slice(0, 2).join(' · ');
  });

  currentDate = signal('');
  private updateClock() {
    const now = new Date();
    const days = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
    const months = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
    const dd = String(now.getDate()).padStart(2, '0');
    const mo = months[now.getMonth()];
    const dn = days[now.getDay()];
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    this.currentDate.set(`${dd} ${mo} · ${dn} · ${hh}:${mm} · UTC+3`);
  }

  private matches(route: string, url: string, exact?: boolean): boolean {
    if (!url) return false;
    const cleanUrl = url.split('?')[0].split('#')[0];
    if (exact) return cleanUrl === route;
    return cleanUrl === route || cleanUrl.startsWith(route + '/');
  }

  isItemActive(item: NavItem): boolean {
    return this.matches(item.route, this.currentUrl(), item.exactMatch);
  }

  async ngOnInit() {
    this.currentUrl.set(this.router.url);
    this.updateClock();
    this.clockSub = interval(30_000).subscribe(() => this.updateClock());

    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        this.currentUrl.set(e.urlAfterRedirects);
        this.alertsOpen.set(false);
      });

    if (environment.skipAuth) {
      this.username = 'dev-admin';
      this.userGroups.set([GROUP.SystemEng]);
      return;
    }

    const kc = this.keycloak.getKeycloakInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any = kc?.tokenParsed ?? {};
    this.username = parsed['preferred_username'] ?? '';
    const groups: string[] = parsed?.groups ?? [];
    this.userGroups.set(groups);
    this.cdr.detectChanges();
  }

  ngOnDestroy() {
    this.routerSub?.unsubscribe();
    this.clockSub?.unsubscribe();
  }

  /** Cmd+K (Mac) / Ctrl+K (Win/Linux) — global shortcut. */
  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.openCommandPalette();
    }
  }

  openCommandPalette() {
    const items: CommandItem[] = [];
    for (const g of this.visibleGroups()) {
      for (const it of g.items) {
        items.push({ label: it.label, icon: it.icon, route: it.route, group: g.label });
      }
    }
    const ref = this.dialog.open<CommandPaletteComponent, { items: CommandItem[] }, string>(
      CommandPaletteComponent,
      {
        data: { items },
        width: '560px',
        maxWidth: '92vw',
        panelClass: 'bp-command-palette-panel',
        autoFocus: false,
        position: { top: '15vh' },
      },
    );
    ref.afterClosed().subscribe((route) => {
      if (route) this.router.navigateByUrl(route);
    });
  }

  toggleAlerts() {
    this.alertsOpen.update((v) => !v);
  }

  /** Yeni Yayın Kaydı — Aşama 2'de modal componenti yazılır; Aşama 1'de placeholder. */
  openNewBroadcast() {
    // TODO Aşama 2: NewBroadcastDialog open
    // Şimdilik schedule list'e yönlendir (en yakın iş)
    this.router.navigateByUrl('/schedules');
  }

  logout() {
    if (environment.skipAuth) return;
    this.keycloak.logout(getPublicAppOrigin());
  }
}
