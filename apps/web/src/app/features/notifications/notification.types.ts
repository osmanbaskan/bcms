export type NotifySeverity = 'info' | 'warning' | 'critical';

/** Backend NotifyPayload ile birebir (pg_notify -> SSE). */
export interface NotifyPayload {
  id: number;
  type: string;
  section: string;
  severity: NotifySeverity;
  title: string;
  body: string | null;
  link: string | null;
  requiredGroups: string[];
  defaultOn: boolean;
  sound: string;
  createdAt: string;
}

export type NotifyStreamEvent =
  | { type: 'notification'; notification: NotifyPayload }
  | { type: 'heartbeat'; ts: number };

/** Kullanıcının erişebildiği tip + efektif aç/kapa (ayarlar ekranı). */
export interface UserSubscription {
  key: string;
  label: string;
  section: string;
  severity: NotifySeverity;
  enabled: boolean;
  /** Kullanıcının seçtiği efektif ses: 'off' | 'normal' | 'critical'. */
  sound: string;
}

/** Admin tip katalogu. */
export interface NotificationTypeDef {
  key: string;
  label: string;
  section: string;
  requiredGroups: string[];
  severity: NotifySeverity;
  sound: string;
  defaultOn: boolean;
  active: boolean;
  sortOrder: number;
}

export interface NotificationItem {
  id: number;
  type: string;
  severity: NotifySeverity;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  read: boolean;
  readAt: string | null;
}
