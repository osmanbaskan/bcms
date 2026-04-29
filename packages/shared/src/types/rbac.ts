export const BCMS_GROUPS = [
  'Admin',
  'Yayın Muhendisligi',
  'Transmisyon',
  'Booking',
  'Yayın Planlama Mudurlugu',
  'Sistem Muhendisligi',
  'Ingest',
  'Kurgu',
  'MCR',
  'PCR',
  'Ses',
  'Studyo Sefligi',
] as const;

export type BcmsGroup = typeof BCMS_GROUPS[number];

export interface JwtPayload {
  sub: string;
  preferred_username: string;
  email: string;
  groups: string[];
  iat: number;
  exp: number;
}

/** Permissions matrix — groups allowed for each action.
 *  Initially only Sistem Muhendisligi has access; update as department permissions are defined. */
export const PERMISSIONS = {
  schedules: {
    read:          [] as BcmsGroup[],                                                                      // all authenticated
    add:           ['Sistem Muhendisligi', 'Booking', 'Yayın Planlama Mudurlugu'] as BcmsGroup[],                              // yeni ekle butonu
    edit:          ['Sistem Muhendisligi', 'Yayın Muhendisligi', 'Transmisyon', 'Booking', 'Yayın Planlama Mudurlugu'] as BcmsGroup[],     // düzenle
    technicalEdit: ['Sistem Muhendisligi', 'Transmisyon', 'Booking'] as BcmsGroup[],                                // teknik detay
    duplicate:     ['Sistem Muhendisligi', 'Yayın Muhendisligi', 'Transmisyon', 'Booking'] as BcmsGroup[],                      // çoğaltma
    delete:        ['Sistem Muhendisligi', 'Yayın Muhendisligi', 'Transmisyon', 'Booking', 'Yayın Planlama Mudurlugu'] as BcmsGroup[],     // silme
    write:         ['Sistem Muhendisligi', 'Yayın Muhendisligi', 'Transmisyon', 'Booking', 'Yayın Planlama Mudurlugu'] as BcmsGroup[],     // API PATCH/POST
  },
  bookings: {
    read:   [] as BcmsGroup[],
    write:  [] as BcmsGroup[],
    delete: [] as BcmsGroup[],
  },
  ingest: {
    read:         ['Sistem Muhendisligi', 'Ingest'] as BcmsGroup[],
    write:        ['Sistem Muhendisligi', 'Ingest'] as BcmsGroup[],
    delete:       ['Sistem Muhendisligi', 'Ingest'] as BcmsGroup[],
    reportIssue:  [] as BcmsGroup[],                       // tüm authenticated — her rol yayın sorunu bildirebilir
  },
  channels: {
    read:   ['Sistem Muhendisligi'] as BcmsGroup[],
    write:  ['Sistem Muhendisligi'] as BcmsGroup[],
    delete: ['Sistem Muhendisligi'] as BcmsGroup[],
  },
  incidents: {
    read:        ['Sistem Muhendisligi'] as BcmsGroup[],
    write:       ['Sistem Muhendisligi'] as BcmsGroup[],
    delete:      ['Sistem Muhendisligi'] as BcmsGroup[],
    reportIssue: ['Sistem Muhendisligi', 'Yayın Muhendisligi', 'Transmisyon'] as BcmsGroup[],
  },
  monitoring: {
    read:   ['Sistem Muhendisligi'] as BcmsGroup[],
    write:  ['Sistem Muhendisligi'] as BcmsGroup[],
  },
  auditLogs: {
    read:   ['Sistem Muhendisligi'] as BcmsGroup[],
  },
  reports: {
    read:   ['Sistem Muhendisligi'] as BcmsGroup[],
    export: ['Sistem Muhendisligi'] as BcmsGroup[],
  },
  studioPlans: {
    read:   [] as BcmsGroup[],
    write:  ['Sistem Muhendisligi', 'Studyo Sefligi'] as BcmsGroup[],
    delete: ['Sistem Muhendisligi', 'Studyo Sefligi'] as BcmsGroup[],
  },
  weeklyShifts: {
    read:  [] as BcmsGroup[],
    write: [] as BcmsGroup[],
    admin: ['Admin', 'Sistem Muhendisligi'] as BcmsGroup[],
  },
} as const;
