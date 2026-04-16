export type BookingStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface Booking {
  id: number;
  scheduleId: number;
  requestedBy: string;
  teamId?: number;
  matchId?: number;
  metadata?: Record<string, unknown>;
  status: BookingStatus;
  version: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBookingDto {
  scheduleId: number;
  teamId?: number;
  matchId?: number;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateBookingDto {
  status?: BookingStatus;
  notes?: string;
  metadata?: Record<string, unknown>;
}
