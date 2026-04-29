export const BCMS_GROUPS = [
  'Admin',
  'Tekyon',
  'Transmisyon',
  'Booking',
  'YayınPlanlama',
  'SystemEng',
  'Ingest',
  'Kurgu',
  'MCR',
  'PCR',
  'Ses',
  'StudyoSefi',
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
 *  Initially only SystemEng has access; update as department permissions are defined. */
export const PERMISSIONS = {
  schedules: {
    read:          [] as BcmsGroup[],                                                                      // all authenticated
    add:           ['SystemEng', 'Booking', 'YayınPlanlama'] as BcmsGroup[],                              // yeni ekle butonu
    edit:          ['SystemEng', 'Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama'] as BcmsGroup[],     // düzenle
    technicalEdit: ['SystemEng', 'Transmisyon', 'Booking'] as BcmsGroup[],                                // teknik detay
    duplicate:     ['SystemEng', 'Tekyon', 'Transmisyon', 'Booking'] as BcmsGroup[],                      // çoğaltma
    delete:        ['SystemEng', 'Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama'] as BcmsGroup[],     // silme
    write:         ['SystemEng', 'Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama'] as BcmsGroup[],     // API PATCH/POST
  },
  bookings: {
    read:   [] as BcmsGroup[],
    write:  [] as BcmsGroup[],
    delete: [] as BcmsGroup[],
  },
  ingest: {
    read:         ['SystemEng', 'Ingest'] as BcmsGroup[],
    write:        ['SystemEng', 'Ingest'] as BcmsGroup[],
    delete:       ['SystemEng', 'Ingest'] as BcmsGroup[],
    reportIssue:  [] as BcmsGroup[],                       // tüm authenticated — her rol yayın sorunu bildirebilir
  },
  channels: {
    read:   ['SystemEng'] as BcmsGroup[],
    write:  ['SystemEng'] as BcmsGroup[],
    delete: ['SystemEng'] as BcmsGroup[],
  },
  incidents: {
    read:        ['SystemEng'] as BcmsGroup[],
    write:       ['SystemEng'] as BcmsGroup[],
    delete:      ['SystemEng'] as BcmsGroup[],
    reportIssue: ['SystemEng', 'Tekyon', 'Transmisyon'] as BcmsGroup[],
  },
  monitoring: {
    read:   ['SystemEng'] as BcmsGroup[],
    write:  ['SystemEng'] as BcmsGroup[],
  },
  auditLogs: {
    read:   ['SystemEng'] as BcmsGroup[],
  },
  reports: {
    read:   ['SystemEng'] as BcmsGroup[],
    export: ['SystemEng'] as BcmsGroup[],
  },
  studioPlans: {
    read:   [] as BcmsGroup[],
    write:  ['SystemEng', 'StudyoSefi'] as BcmsGroup[],
    delete: ['SystemEng', 'StudyoSefi'] as BcmsGroup[],
  },
  weeklyShifts: {
    read:  [] as BcmsGroup[],
    write: [] as BcmsGroup[],
    admin: ['Admin', 'SystemEng'] as BcmsGroup[],
  },
} as const;
