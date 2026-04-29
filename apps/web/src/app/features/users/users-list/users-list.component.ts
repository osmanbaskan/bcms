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
  userType:  'staff' | 'supervisor' | 'admin';
  groups:    string[];
}

const ALL_GROUPS = [
  'Admin', 'Yayın Muhendisligi', 'Transmisyon', 'Booking', 'Yayın Planlama Mudurlugu', 'Sistem Muhendisligi',
  'Ingest', 'Kurgu', 'MCR', 'PCR', 'Ses', 'Studyo Sefligi',
] as const;

const GROUP_COLORS: Record<string, string> = {
  Admin:         '#111827',
  Yayın Muhendisligi:        '#1565c0',
  Transmisyon:   '#6a1b9a',
  Booking:       '#2e7d32',
  Yayın Planlama Mudurlugu: '#e65100',
  Sistem Muhendisligi:     '#b71c1c',
  Ingest:        '#00695c',
  Kurgu:         '#f57f17',
  MCR:           '#4527a0',
  PCR:           '#0277bd',
  Ses:           '#558b2f',
  Studyo Sefligi:    '#37474f',
};

const USER_TYPE_LABELS: Record<KcUser['userType'], string> = {
  admin:      'Admin',
  staff:      'Personel',
  supervisor: 'Sorumlu',
};

// ── Kullanıcı Düzenleme Dialog ────────────────────────────────────────────────
@Component({
  selector: 'app-user-edit-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatDialogModule, MatButtonModule,
            MatCheckboxModule, MatProgressSpinnerModule, MatFormFieldModule,
            MatInputModule, MatSelectModule, MatSlideToggleModule],
  template: `
    <h2 mat-dialog-title>Düzenle — {{ data.user.username }}</h2>
    <mat-dialog-content style="min-width:420px">
      <div style="display:flex;flex-direction:column;gap:4px">
        <div style="display:flex;gap:12px">
          <mat-form-field style="flex:1">
            <mat-label>Ad</mat-label>
            <input matInput [(ngModel)]="f.firstName" name="firstName">
          </mat-form-field>
          <mat-form-field style="flex:1">
            <mat-label>Soyad</mat-label>
            <input matInput [(ngModel)]="f.lastName" name="lastName">
          </mat-form-field>
        </div>
        <mat-form-field>
          <mat-label>Kullanıcı Adı *</mat-label>
          <input matInput [(ngModel)]="f.username" name="username">
        </mat-form-field>
        <mat-form-field>
          <mat-label>E-posta *</mat-label>
          <input matInput type="email" [(ngModel)]="f.email" name="email">
        </mat-form-field>
        <mat-form-field>
          <mat-label>Personel Tipi</mat-label>
          <mat-select [(ngModel)]="f.userType" name="userType">
            <mat-option value="staff">Personel</mat-option>
            <mat-option value="supervisor">Sorumlu</mat-option>
            <mat-option value="admin">Admin</mat-option>
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Yeni Geçici Şifre</mat-label>
          <input matInput type="password" [(ngModel)]="password" name="password">
        </mat-form-field>
        <mat-slide-toggle [(ngModel)]="f.enabled" name="enabled">
          {{ f.enabled ? 'Aktif' : 'Pasif' }}
        </mat-slide-toggle>
        <p style="font-size:12px;color:#aaa;margin:12px 0 4px">Gruplar</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
        @for (group of allGroups; track group) {
          <mat-checkbox
            [checked]="selected.has(group)"
            (change)="toggle(group, $event.checked)">
            {{ group }}
          </mat-checkbox>
        }
        </div>
      </div>
      @if (errorMsg()) {
        <p style="color:#f44336;font-size:12px;margin:8px 0 0">{{ errorMsg() }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>İptal</button>
      <button mat-raised-button color="primary"
              [disabled]="saving() || !canSave()"
              (click)="save()">
        {{ saving() ? 'Kaydediliyor…' : 'Kaydet' }}
      </button>
    </mat-dialog-actions>
  `,
})
export class UserEditDialogComponent {
  data      = inject<{ user: KcUser }>(MAT_DIALOG_DATA);
  dialogRef = inject(MatDialogRef<UserEditDialogComponent>);
  api       = inject(ApiService);
  saving    = signal(false);
  errorMsg  = signal('');
  allGroups = ALL_GROUPS;
  selected  = new Set(this.data.user.groups);
  password  = '';
  f = {
    username:  this.data.user.username,
    email:     this.data.user.email,
    firstName: this.data.user.firstName,
    lastName:  this.data.user.lastName,
    enabled:   this.data.user.enabled,
    userType:  this.data.user.userType ?? 'staff',
  };

  canSave = () => !!(this.f.username && this.f.email);

  toggle(group: string, checked: boolean) {
    checked ? this.selected.add(group) : this.selected.delete(group);
  }

  save() {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.errorMsg.set('');
    const payload = {
      ...this.f,
      groups: [...this.selected],
      ...(this.password.trim() ? { password: this.password.trim() } : {}),
    };
    this.api.put(`/users/${this.data.user.id}`, payload).subscribe({
      next:  () => { this.saving.set(false); this.dialogRef.close(true); },
      error: (err) => {
        this.saving.set(false);
        this.errorMsg.set(err?.error?.message ?? err?.message ?? 'Kullanıcı güncellenemedi');
      },
    });
  }
}

// ── Yeni Kullanıcı Dialog ─────────────────────────────────────────────────────
@Component({
  selector: 'app-new-user-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule,
            MatInputModule, MatSelectModule, MatCheckboxModule, MatProgressSpinnerModule],
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
        <mat-form-field>
          <mat-label>Personel Tipi</mat-label>
          <mat-select [(ngModel)]="f.userType" name="ut">
            <mat-option value="staff">Personel</mat-option>
            <mat-option value="supervisor">Sorumlu</mat-option>
            <mat-option value="admin">Admin</mat-option>
          </mat-select>
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
      @if (errorMsg()) {
        <p style="color:#f44336;font-size:12px;margin:8px 0 0">{{ errorMsg() }}</p>
      }
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
  snack          = inject(MatSnackBar);
  saving         = signal(false);
  errorMsg       = signal('');
  allGroups      = ALL_GROUPS;
  selectedGroups = new Set<string>();
  f: {
    username: string;
    email: string;
    firstName: string;
    lastName: string;
    password: string;
    userType: KcUser['userType'];
  } = { username: '', email: '', firstName: '', lastName: '', password: '', userType: 'staff' };

  canSave = () => !!(this.f.username && this.f.email && this.f.password);

  toggleGroup(group: string, checked: boolean) {
    checked ? this.selectedGroups.add(group) : this.selectedGroups.delete(group);
  }

  save() {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.errorMsg.set('');
    this.api.post('/users', { ...this.f, groups: [...this.selectedGroups] }).subscribe({
      next:  () => { this.saving.set(false); this.dialogRef.close(true); },
      error: (err) => {
        this.saving.set(false);
        const msg = err?.error?.message ?? err?.message ?? 'Kullanıcı oluşturulamadı';
        this.errorMsg.set(msg);
      },
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

        <!-- Personel Tipi -->
        <ng-container matColumnDef="userType">
          <th mat-header-cell *matHeaderCellDef>Personel Tipi</th>
          <td mat-cell *matCellDef="let u">
            <span class="type-chip" [class.supervisor]="u.userType === 'supervisor'" [class.admin]="u.userType === 'admin'">
              {{ userTypeLabel(u.userType) }}
            </span>
          </td>
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
            <button mat-icon-button matTooltip="Düzenle" (click)="openEdit(u)">
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
    .type-chip {
      display:inline-flex; align-items:center; min-width:72px; justify-content:center;
      font-size:11px; padding:3px 10px; border-radius:10px;
      background:#263238; color:#e0f2f1; font-weight:600;
    }
    .type-chip.supervisor { background:#4a148c; color:#f3e5f5; }
    .type-chip.admin { background:#111827; color:#fff; }
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
  cols    = ['username', 'userType', 'groups', 'enabled', 'actions'];

  groupColor = (g: string) => GROUP_COLORS[g] ?? '#555';
  userTypeLabel = (type: KcUser['userType']) => USER_TYPE_LABELS[type] ?? 'Personel';

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    this.api.get<KcUser[]>('/users').subscribe({
      next:  (u) => { this.users.set(u); this.loading.set(false); },
      error: ()  => { this.loading.set(false); },
    });
  }

  openEdit(user: KcUser) {
    this.dialog.open(UserEditDialogComponent, { data: { user }, width: '480px' })
      .afterClosed().subscribe((ok) => {
        if (ok) { this.snack.open('Kullanıcı güncellendi', 'Kapat', { duration: 3000 }); this.load(); }
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
