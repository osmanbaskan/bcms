import { Component, OnInit, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialogModule, MatDialog, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ApiService } from '../../../core/services/api.service';

interface KcUser {
  id:        string;
  username:  string;
  email:     string;
  firstName: string;
  lastName:  string;
  enabled:   boolean;
  groups:    string[];
}

const ALL_GROUPS = [
  'Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama', 'SystemEng',
  'Ingest', 'Kurgu', 'MCR', 'PCR', 'Ses', 'Studyo',
] as const;

const GROUP_COLORS: Record<string, string> = {
  Tekyon:        '#1565c0',
  Transmisyon:   '#6a1b9a',
  Booking:       '#2e7d32',
  YayınPlanlama: '#e65100',
  SystemEng:     '#b71c1c',
  Ingest:        '#00695c',
  Kurgu:         '#f57f17',
  MCR:           '#4527a0',
  PCR:           '#0277bd',
  Ses:           '#558b2f',
  Studyo:        '#37474f',
};

// ── Grup Düzenleme Dialog ─────────────────────────────────────────────────────
@Component({
  selector: 'app-user-group-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatDialogModule, MatButtonModule,
            MatCheckboxModule, MatProgressSpinnerModule],
  template: `
    <h2 mat-dialog-title>Grupları Düzenle — {{ data.user.username }}</h2>
    <mat-dialog-content style="min-width:320px">
      <p style="color:#aaa;font-size:12px;margin:0 0 12px">
        {{ data.user.email }}
      </p>
      <div style="display:flex;flex-direction:column;gap:8px">
        @for (group of allGroups; track group) {
          <mat-checkbox
            [checked]="selected.has(group)"
            (change)="toggle(group, $event.checked)">
            {{ group }}
          </mat-checkbox>
        }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>İptal</button>
      <button mat-raised-button color="primary"
              [disabled]="saving()"
              (click)="save()">
        {{ saving() ? 'Kaydediliyor…' : 'Kaydet' }}
      </button>
    </mat-dialog-actions>
  `,
})
export class UserGroupDialogComponent {
  data      = inject<{ user: KcUser }>(MAT_DIALOG_DATA);
  dialogRef = inject(MatDialogRef<UserGroupDialogComponent>);
  api       = inject(ApiService);
  saving    = signal(false);
  allGroups = ALL_GROUPS;
  selected  = new Set(this.data.user.groups);

  toggle(group: string, checked: boolean) {
    checked ? this.selected.add(group) : this.selected.delete(group);
  }

  save() {
    this.saving.set(true);
    this.api.put(`/users/${this.data.user.id}/groups`, { groups: [...this.selected] }).subscribe({
      next:  () => { this.saving.set(false); this.dialogRef.close(true); },
      error: () => { this.saving.set(false); },
    });
  }
}

// ── Yeni Kullanıcı Dialog ─────────────────────────────────────────────────────
@Component({
  selector: 'app-new-user-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule,
            MatInputModule, MatCheckboxModule, MatProgressSpinnerModule],
  template: `
    <h2 mat-dialog-title>Yeni Kullanıcı</h2>
    <mat-dialog-content style="min-width:360px">
      <div style="display:flex;flex-direction:column;gap:4px">
        <div style="display:flex;gap:12px">
          <mat-form-field style="flex:1">
            <mat-label>Ad</mat-label>
            <input matInput [(ngModel)]="f.firstName" name="fn">
          </mat-form-field>
          <mat-form-field style="flex:1">
            <mat-label>Soyad</mat-label>
            <input matInput [(ngModel)]="f.lastName" name="ln">
          </mat-form-field>
        </div>
        <mat-form-field>
          <mat-label>Kullanıcı Adı *</mat-label>
          <input matInput [(ngModel)]="f.username" name="un">
        </mat-form-field>
        <mat-form-field>
          <mat-label>E-posta *</mat-label>
          <input matInput type="email" [(ngModel)]="f.email" name="em">
        </mat-form-field>
        <mat-form-field>
          <mat-label>Geçici Şifre *</mat-label>
          <input matInput type="password" [(ngModel)]="f.password" name="pw">
        </mat-form-field>
        <p style="font-size:12px;color:#aaa;margin:4px 0">Gruplar</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          @for (group of allGroups; track group) {
            <mat-checkbox
              [checked]="selectedGroups.has(group)"
              (change)="toggleGroup(group, $event.checked)">
              {{ group }}
            </mat-checkbox>
          }
        </div>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>İptal</button>
      <button mat-raised-button color="primary"
              [disabled]="saving() || !canSave()"
              (click)="save()">
        {{ saving() ? 'Oluşturuluyor…' : 'Oluştur' }}
      </button>
    </mat-dialog-actions>
  `,
})
export class NewUserDialogComponent {
  dialogRef      = inject(MatDialogRef<NewUserDialogComponent>);
  api            = inject(ApiService);
  saving         = signal(false);
  allGroups      = ALL_GROUPS;
  selectedGroups = new Set<string>();
  f = { username: '', email: '', firstName: '', lastName: '', password: '' };

  canSave = () => !!(this.f.username && this.f.email && this.f.password);

  toggleGroup(group: string, checked: boolean) {
    checked ? this.selectedGroups.add(group) : this.selectedGroups.delete(group);
  }

  save() {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.api.post('/users', { ...this.f, groups: [...this.selectedGroups] }).subscribe({
      next:  () => { this.saving.set(false); this.dialogRef.close(true); },
      error: () => { this.saving.set(false); },
    });
  }
}

// ── Ana Bileşen ───────────────────────────────────────────────────────────────
@Component({
  selector: 'app-users-list',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatTableModule, MatButtonModule, MatIconModule, MatChipsModule,
    MatDialogModule, MatSlideToggleModule, MatSnackBarModule,
    MatTooltipModule, MatProgressSpinnerModule,
  ],
  template: `
    <div class="page-header">
      <h2>Kullanıcılar & Yetkiler</h2>
      <button mat-raised-button color="primary" (click)="openNewUser()">
        <mat-icon>person_add</mat-icon> Yeni Kullanıcı
      </button>
    </div>

    @if (loading()) {
      <div class="loading-wrap">
        <mat-spinner diameter="40"></mat-spinner>
      </div>
    } @else {
      <table mat-table [dataSource]="users()" class="users-table">

        <!-- Kullanıcı Adı -->
        <ng-container matColumnDef="username">
          <th mat-header-cell *matHeaderCellDef>Kullanıcı Adı</th>
          <td mat-cell *matCellDef="let u">
            <div class="user-name-cell">
              <mat-icon class="avatar-icon">account_circle</mat-icon>
              <div>
                <div>{{ u.username }}</div>
                <div class="sub-text">{{ u.firstName }} {{ u.lastName }}</div>
              </div>
            </div>
          </td>
        </ng-container>

        <!-- E-posta -->
        <ng-container matColumnDef="email">
          <th mat-header-cell *matHeaderCellDef>E-posta</th>
          <td mat-cell *matCellDef="let u">{{ u.email }}</td>
        </ng-container>

        <!-- Gruplar -->
        <ng-container matColumnDef="groups">
          <th mat-header-cell *matHeaderCellDef>Gruplar</th>
          <td mat-cell *matCellDef="let u">
            <div class="group-chips">
              @for (g of u.groups; track g) {
                <span class="group-chip" [style.background]="groupColor(g)">
                  {{ g }}
                </span>
              }
              @if (u.groups.length === 0) {
                <span class="no-group">—</span>
              }
            </div>
          </td>
        </ng-container>

        <!-- Durum -->
        <ng-container matColumnDef="enabled">
          <th mat-header-cell *matHeaderCellDef>Durum</th>
          <td mat-cell *matCellDef="let u">
            <mat-slide-toggle
              [checked]="u.enabled"
              (change)="toggleEnabled(u, $event.checked)"
              [matTooltip]="u.enabled ? 'Aktif — devre dışı bırakmak için tıkla' : 'Pasif — aktifleştirmek için tıkla'">
            </mat-slide-toggle>
          </td>
        </ng-container>

        <!-- İşlemler -->
        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef></th>
          <td mat-cell *matCellDef="let u">
            <button mat-icon-button matTooltip="Grupları düzenle" (click)="openGroupEdit(u)">
              <mat-icon>manage_accounts</mat-icon>
            </button>
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="cols"></tr>
        <tr mat-row *matRowDef="let row; columns: cols;" [class.disabled-row]="!row.enabled"></tr>
      </table>
    }
  `,
  styles: [`
    .page-header { display:flex; justify-content:space-between; align-items:center; padding:16px 24px 8px; }
    .page-header h2 { margin:0; font-size:20px; font-weight:500; }
    .loading-wrap { display:flex; justify-content:center; padding:60px; }
    .users-table { width:100%; }
    .user-name-cell { display:flex; align-items:center; gap:10px; }
    .avatar-icon { font-size:32px; height:32px; width:32px; color:#555; }
    .sub-text { font-size:11px; color:#888; }
    .group-chips { display:flex; flex-wrap:wrap; gap:4px; }
    .group-chip {
      font-size:10px; padding:2px 8px; border-radius:10px;
      color:#fff; font-weight:600; white-space:nowrap;
    }
    .no-group { color:#555; font-size:12px; }
    .disabled-row { opacity:.45; }
  `],
})
export class UsersListComponent implements OnInit {
  private api    = inject(ApiService);
  private dialog = inject(MatDialog);
  private snack  = inject(MatSnackBar);

  users   = signal<KcUser[]>([]);
  loading = signal(true);
  cols    = ['username', 'email', 'groups', 'enabled', 'actions'];

  groupColor = (g: string) => GROUP_COLORS[g] ?? '#555';

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    this.api.get<KcUser[]>('/users').subscribe({
      next:  (u) => { this.users.set(u); this.loading.set(false); },
      error: ()  => { this.loading.set(false); },
    });
  }

  openGroupEdit(user: KcUser) {
    this.dialog.open(UserGroupDialogComponent, { data: { user }, width: '360px' })
      .afterClosed().subscribe((ok) => {
        if (ok) { this.snack.open('Gruplar güncellendi', 'Kapat', { duration: 3000 }); this.load(); }
      });
  }

  openNewUser() {
    this.dialog.open(NewUserDialogComponent, { width: '420px' })
      .afterClosed().subscribe((ok) => {
        if (ok) { this.snack.open('Kullanıcı oluşturuldu', 'Kapat', { duration: 3000 }); this.load(); }
      });
  }

  toggleEnabled(user: KcUser, enabled: boolean) {
    this.api.patch(`/users/${user.id}/enabled`, { enabled }).subscribe({
      next: () => {
        this.users.update((list) => list.map((u) => u.id === user.id ? { ...u, enabled } : u));
        this.snack.open(`Kullanıcı ${enabled ? 'aktifleştirildi' : 'devre dışı bırakıldı'}`, 'Kapat', { duration: 3000 });
      },
    });
  }
}
