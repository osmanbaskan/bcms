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
