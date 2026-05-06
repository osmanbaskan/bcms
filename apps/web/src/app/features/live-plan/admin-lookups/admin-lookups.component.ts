import { Component, OnInit, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { KeycloakService } from 'keycloak-angular';
import { GROUP, PERMISSIONS } from '@bcms/shared';
import type { BcmsTokenParsed } from '../../../core/types/auth';
import { isSkipAuthAllowed } from '../../../core/auth/skip-auth';
import {
  LOOKUP_DEFINITIONS,
  LOOKUP_GROUP_LABELS,
  type LookupDefinition,
  type LookupGroup,
} from './lookup.types';
import { LookupListComponent } from './lookup-list.component';

@Component({
  selector: 'app-admin-lookups',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatListModule, MatIconModule, MatDividerModule,
    LookupListComponent,
  ],
  template: `
    <div class="page">
      <aside class="side">
        <div class="side-header">
          <h2>Live-Plan Lookup</h2>
          <p>Master data yönetimi</p>
        </div>
        @for (group of groups; track group.key) {
          <div class="group-section">
            <div class="group-label">{{ group.label }}</div>
            <mat-nav-list dense>
              @for (def of group.items; track def.type) {
                <a mat-list-item
                   (click)="select(def)"
                   [class.active]="selected()?.type === def.type">
                  <mat-icon matListItemIcon>folder_open</mat-icon>
                  <span matListItemTitle>{{ def.label }}</span>
                </a>
              }
            </mat-nav-list>
          </div>
        }
      </aside>
      <main class="main">
        <app-lookup-list
          [definition]="selected() ?? undefined"
          [canWrite]="canWrite()"
          [canDelete]="canDelete()">
        </app-lookup-list>
      </main>
    </div>
  `,
  styles: [`
    :host { display:block; height:100%; }
    .page { display:flex; height:100%; min-height:calc(100vh - 120px); }
    .side {
      width:280px; min-width:240px; border-right:1px solid rgba(255,255,255,0.08);
      overflow-y:auto; padding:16px 0; background:rgba(255,255,255,0.015);
    }
    .side-header { padding:0 16px 12px; }
    .side-header h2 { margin:0; font-size:16px; font-weight:600; }
    .side-header p { margin:2px 0 0; font-size:11px; color:#888; }
    .group-section { margin-top:8px; }
    .group-label {
      padding:8px 16px 4px; font-size:10px; letter-spacing:.08em;
      color:#888; font-weight:600; text-transform:uppercase;
    }
    .active { background: rgba(33,150,243,0.18) !important; }
    .main { flex:1; padding:16px 24px; overflow:auto; }
  `],
})
export class AdminLookupsComponent implements OnInit {
  private keycloak = inject(KeycloakService);

  selected   = signal<LookupDefinition | null>(null);
  userGroups = signal<string[]>([]);

  groups: Array<{ key: LookupGroup; label: string; items: LookupDefinition[] }> = (
    Object.keys(LOOKUP_GROUP_LABELS) as LookupGroup[]
  ).map((key) => ({
    key,
    label: LOOKUP_GROUP_LABELS[key],
    items: LOOKUP_DEFINITIONS.filter((d) => d.group === key),
  }));

  isAdmin = computed(() => this.userGroups().includes(GROUP.Admin));

  canWrite = computed(() => {
    if (this.isAdmin()) return true;
    return PERMISSIONS.livePlanLookups.write.some((g) => this.userGroups().includes(g));
  });

  canDelete = computed(() => {
    if (this.isAdmin()) return true;
    return PERMISSIONS.livePlanLookups.delete.some((g) => this.userGroups().includes(g));
  });

  ngOnInit() {
    if (isSkipAuthAllowed()) {
      this.userGroups.set([GROUP.SystemEng]);
    } else {
      const kc = this.keycloak.getKeycloakInstance();
      const parsed: BcmsTokenParsed = (kc?.tokenParsed as BcmsTokenParsed | undefined) ?? {};
      this.userGroups.set(parsed.groups ?? []);
    }
    if (LOOKUP_DEFINITIONS.length > 0) {
      this.selected.set(LOOKUP_DEFINITIONS[0]);
    }
  }

  select(def: LookupDefinition) {
    this.selected.set(def);
  }
}
