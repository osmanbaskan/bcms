export type BookingStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface Booking {
  id: number;
  scheduleId?: number | null;
  requestedBy: string;
  requestedByName?: string | null;
  teamId?: number | null;
  matchId?: number | null;
  taskTitle?: string | null;
  taskDetails?: string | null;
  taskReport?: string | null;
  userGroup?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  completedAt?: string | null;
  metadata?: Record<string, unknown>;
  status: BookingStatus;
  version: number;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  schedule?: { id: number; title: string; channel?: { id: number; name: string } | null } | null;
}

export interface CreateBookingDto {
  scheduleId?: number;
  teamId?: number;
  matchId?: number;
  taskTitle?: string;
  taskDetails?: string;
  taskReport?: string;
  userGroup?: string;
  assigneeId?: string;
  assigneeName?: string;
  startDate?: string;
  dueDate?: string;
  completedAt?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateBookingDto {
  status?: BookingStatus;
  taskTitle?: string;
  taskDetails?: string;
  taskReport?: string;
  assigneeId?: string | null;
  assigneeName?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  completedAt?: string | null;
  notes?: string;
  metadata?: Record<string, unknown>;
}

/** HIGH-SHARED-003 fix (2026-05-05) — booking.findAll'da hesaplanan ek alanlar.
 *  Base Booking interface'i salt-DB schema; list view'da requestedByName Keycloak
 *  user listesinden join ediliyor, base type'a koymak yanıltıcı olur. */
export interface BookingListItem extends Booking {
  /** Keycloak'dan join edilmiş display name; createdBy ID'sine karşılık. */
  requestedByName?: string | null;
}
